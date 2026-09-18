#!/usr/bin/env python3
"""Local Skill entrypoint. stdout is JSON; secrets are never CLI arguments."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time
from urllib.parse import urlparse

SCRIPT = Path(__file__).resolve()


class SetupError(Exception):
    def __init__(self, code, stage, detail):
        super().__init__(detail)
        self.code, self.stage = code, stage

    def payload(self):
        return {'status': 'error', 'code': self.code, 'stage': self.stage,
                'error': str(self), 'runtime_dir': str(home() / 'runtime'),
                'preserved': True,
                'next_action': '保留已有文件。权限问题按宿主授权流程处理；其他错误先检查原始错误。解决原因后重试同一 setup 命令。不要自动删除或移动 runtime、jobs、cache 或数据根目录，不要使用 sudo 或改目录绕过沙箱。'}


def home():
    return Path(os.environ.get('BILI_HOME', str(Path.home() / 'Library/Application Support/bilibili-transcriber'))).expanduser().resolve()


def python():
    return home() / 'runtime/bin/python'


def emit(value):
    print(json.dumps(value, ensure_ascii=False, indent=2))


def save(path, value):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temp.replace(path)


def normalize(value):
    value = value.strip()
    if re.fullmatch(r'BV[A-Za-z0-9]{10}', value):
        return value
    parsed = urlparse(value)
    match = re.fullmatch(r'/video/(BV[A-Za-z0-9]{10})/?', parsed.path)
    if parsed.scheme not in ('http', 'https') or parsed.hostname not in ('www.bilibili.com', 'bilibili.com') or parsed.username or parsed.password or parsed.port or not match:
        raise ValueError('仅支持 BV 号或 bilibili.com/video/BV... 视频链接')
    return match.group(1)


def job_dir(job_id):
    if not re.fullmatch(r'BV[A-Za-z0-9]{10}-(base|small|medium)', job_id):
        raise ValueError('无效任务 ID')
    return home() / 'jobs' / job_id


def alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, TypeError, ValueError):
        return False


def ready():
    if not python().exists():
        return False
    try:
        result = subprocess.run([str(python()), '-c', 'import yt_dlp, faster_whisper'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


def doctor():
    return {'platform': sys.platform, 'supported': sys.platform == 'darwin' and sys.version_info >= (3, 9), 'python': sys.version.split()[0], 'ffmpeg': bool(shutil.which('ffmpeg')), 'runtime_ready': ready(), 'data_dir': str(home()), 'model_download': '首次转录按需下载', 'cookie_mode': '默认匿名；--browser 显式启用本机浏览器'}


def setup():
    if sys.platform != 'darwin' or sys.version_info < (3, 9):
        raise ValueError('首版需要 macOS 和 Python 3.9+')
    if ready():
        emit(doctor())
        return
    stage = 'create_directory'
    try:
        home().mkdir(parents=True, exist_ok=True, mode=0o700)
        commands = [
            ('create_venv', [sys.executable, '-m', 'venv', str(home() / 'runtime')]),
            ('install_dependencies', [str(python()), '-m', 'pip', 'install', '-r', str(SCRIPT.with_name('requirements.txt'))]),
        ]
        # Re-running venv without --clear preserves the existing directory.
        for stage, command in commands:
            result = subprocess.run(command, stdout=sys.stderr, stderr=subprocess.PIPE, text=True)
            if result.returncode:
                detail = (result.stderr or '')[-6000:]
                permission = any(term in detail.lower() for term in ('permission denied', 'operation not permitted', 'errno 13', 'errno 1]'))
                raise SetupError('permission_denied' if permission else 'setup_failed', stage, detail or f'exit {result.returncode}')
        stage = 'verify_runtime'
        if not ready():
            raise SetupError('runtime_not_ready', stage, '依赖安装后导入检查未通过，保留环境供检查')
    except PermissionError as error:
        raise SetupError('permission_denied', stage, str(error)) from error
    except OSError as error:
        raise SetupError('filesystem_error', stage, str(error)) from error
    emit(doctor())


def status(job_id):
    directory = job_dir(job_id)
    data = json.loads((directory / 'job.json').read_text(encoding='utf-8'))
    if data['status'] in ('queued', 'running') and time.time() - data['updated_at'] > 15 and not alive(data.get('pid')):
        data.update(status='failed', error='后台进程已退出，可重新 start 续跑')
    return data


def start(args):
    bvid = normalize(args.url)
    if not ready() or not shutil.which('ffmpeg'):
        raise ValueError('环境未就绪，请先执行 doctor 和 setup，并安装 ffmpeg')
    if args.browser and not re.fullmatch(r'(chrome|chromium|edge|firefox|brave|safari)(:[^/\\\r\n]{1,100})?', args.browser):
        raise ValueError('不支持的浏览器/Profile')
    job_id = bvid + '-' + args.model
    directory = job_dir(job_id)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = directory / 'worker.lock'
    if lock.exists():
        owner = json.loads(lock.read_text())
        if alive(owner.get('pid')) or time.time() - owner.get('time', 0) < 15:
            if (directory / 'job.json').exists():
                emit(status(job_id))
                return
            raise ValueError('任务正在启动，请稍后查询')
        lock.unlink()
    if (directory / 'job.json').exists():
        previous = status(job_id)
        if previous['status'] == 'succeeded' and previous.get('files') and all(Path(f).exists() for f in previous['files']):
            emit(previous)
            return
    with lock.open('x') as handle:
        json.dump({'pid': os.getpid(), 'time': time.time()}, handle)
    data = {'id': job_id, 'bvid': bvid, 'model': args.model, 'browser': args.browser, 'status': 'queued', 'step': 'download', 'updated_at': time.time(), 'files': []}
    save(directory / 'job.json', data)
    try:
        with (directory / 'worker.log').open('ab') as log:
            child = subprocess.Popen([str(python()), str(SCRIPT), '_run', job_id], stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        emit({'id': job_id, 'status': 'queued', 'pid': child.pid, 'data_dir': str(directory)})
    except Exception:
        lock.unlink(missing_ok=True)
        raise


def prepare_manifest(manifest):
    items = json.loads(manifest.read_text(encoding='utf-8'))
    if not isinstance(items, list) or not items:
        raise RuntimeError('音频清单为空或格式无效，未选中音频')
    changed = False
    eligible = 0
    for item in items:
        if not isinstance(item, dict) or not item.get('audioFile'):
            raise RuntimeError('音频清单缺少 audioFile')
        audio = Path(item['audioFile'])
        if not audio.is_file() or audio.stat().st_size == 0:
            raise RuntimeError('音频清单对应文件不存在或为空，保留清单供检查')
        if 'status' not in item:
            item['status'] = 'exists'
            changed = True
        if item['status'] in ('downloaded', 'exists'):
            eligible += 1
    if not eligible:
        raise RuntimeError('未选中音频：清单 status 必须为 downloaded 或 exists')
    if changed:
        save(manifest, items)


def worker(job_id):
    directory = job_dir(job_id)
    data = json.loads((directory / 'job.json').read_text())
    save(directory / 'worker.lock', {'pid': os.getpid(), 'time': time.time()})
    def update(**patch):
        data.update(patch, updated_at=time.time(), pid=os.getpid())
        save(directory / 'job.json', data)
    def interrupted(signum, frame):
        raise RuntimeError('任务中断')
    signal.signal(signal.SIGTERM, interrupted)
    try:
        update(status='running', step='download', error='')
        manifest = directory / 'audio-manifest.json'
        audio = directory / 'audio.m4a'
        if not (manifest.exists() and audio.exists()):
            command = [str(python()), '-m', 'yt_dlp', '--ignore-config', '--no-playlist', '--no-progress', '--quiet', '--no-warnings', '--write-info-json', '-f', 'bestaudio', '-x', '--audio-format', 'm4a', '-o', str(directory / 'audio.%(ext)s')]
            if data.get('browser'):
                command += ['--cookies-from-browser', data['browser']]
            command += ['--', 'https://www.bilibili.com/video/' + data['bvid'] + '/?p=1']
            result = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if result.returncode:
                raise RuntimeError('音频下载失败：检查网络、B站访问权限或浏览器登录。匿名失败可在用户知情后指定 --browser chrome')
            info = json.loads((directory / 'audio.info.json').read_text())
            if not audio.is_file() or audio.stat().st_size == 0:
                raise RuntimeError('下载未生成有效音频')
            save(manifest, [{'index': 1, 'id': data['bvid'], 'title': info.get('title', data['bvid']), 'audioFile': str(audio), 'duration': info.get('duration'), 'uploader': info.get('uploader', ''), 'source': 'bilibili', 'status': 'downloaded'}])
        update(step='transcribe')
        prepare_manifest(manifest)
        env = {k: v for k, v in os.environ.items() if not k.startswith(('AUDIO_', 'XYZ_', 'WHISPER_', 'TRANSCRIPT_'))}
        env.update(AUDIO_CATALOG_DIR=str(directory), WHISPER_BACKEND='faster', WHISPER_MODEL=data['model'], WHISPER_DEVICE='cpu', WHISPER_COMPUTE_TYPE='int8', AUDIO_LANGUAGE='zh', HF_HOME=str(home() / 'cache'), PYTHONUNBUFFERED='1')
        subprocess.run([str(python()), str(SCRIPT.with_name('transcribe_audio_local.py'))], env=env, check=True)
        summary = json.loads((directory / 'transcripts' / data['model'] / 'transcription-summary.json').read_text())
        if not summary.get('selectedCount'):
            raise RuntimeError('未选中音频（selectedCount=0），请检查清单状态与筛选条件；音频已保留')
        files = sorted(str(p) for p in (directory / 'transcripts' / data['model']).iterdir() if p.suffix in ('.txt', '.srt', '.md'))
        if summary.get('failureCount') or not all(any(p.endswith(ext) and Path(p).stat().st_size > 0 for p in files) for ext in ('.srt', '.txt')):
            raise RuntimeError('转录未完整成功，可重试；已有音频保留')
        update(status='succeeded', step='done', files=files)
    except Exception as error:
        update(status='failed', error=str(error))
    finally:
        (directory / 'worker.lock').unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('doctor'); sub.add_parser('setup')
    start_parser = sub.add_parser('start')
    start_parser.add_argument('url'); start_parser.add_argument('--browser', default=None)
    start_parser.add_argument('--model', choices=['base', 'small', 'medium'], default='small')
    for name in ('status', '_run'):
        sub.add_parser(name).add_argument('job_id')
    args = parser.parse_args()
    try:
        if args.command == 'doctor': emit(doctor())
        elif args.command == 'setup': setup()
        elif args.command == 'start': start(args)
        elif args.command == 'status': emit(status(args.job_id))
        else: worker(args.job_id)
    except SetupError as error:
        emit(error.payload())
        return 1
    except Exception as error:
        emit({'status': 'error', 'error': str(error)})
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
