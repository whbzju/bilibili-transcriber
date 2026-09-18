import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'skills/bilibili-transcriber/scripts/bili.py'
spec = importlib.util.spec_from_file_location('bili', SCRIPT)
bili = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bili)
transcribe_spec = importlib.util.spec_from_file_location('transcribe', SCRIPT.with_name('transcribe_audio_local.py'))
transcriber = importlib.util.module_from_spec(transcribe_spec)
transcribe_spec.loader.exec_module(transcriber)


class SkillTests(unittest.TestCase):
    def test_setup_permission_preserves_existing_data(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {'BILI_HOME': temp}):
            for name in ['runtime', 'jobs', 'cache']:
                folder = Path(temp) / name
                folder.mkdir()
                (folder / 'keep').write_text('keep')
            with patch.object(bili, 'ready', return_value=False), patch.object(bili.sys, 'platform', 'darwin'), patch.object(bili.subprocess, 'run') as run:
                run.return_value.returncode = 1
                run.return_value.stderr = 'Permission denied: runtime/bin/python'
                with self.assertRaises(bili.SetupError) as caught: bili.setup()
                self.assertEqual(caught.exception.code, 'permission_denied')
                self.assertEqual(caught.exception.stage, 'create_venv')
                self.assertEqual(run.call_count, 1)
                self.assertNotIn('--clear', run.call_args.args[0])
            for name in ['runtime', 'jobs', 'cache']:
                self.assertEqual((Path(temp) / name / 'keep').read_text(), 'keep')

    def test_setup_ready_does_not_reinstall(self):
        with patch.object(bili.sys, 'platform', 'darwin'), patch.object(bili, 'ready', return_value=True), patch.object(bili, 'emit'), patch.object(bili.subprocess, 'run') as run:
            bili.setup()
            run.assert_not_called()

    def test_setup_network_error_is_not_permission_error(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {'BILI_HOME': temp}), patch.object(bili.sys, 'platform', 'darwin'), patch.object(bili, 'ready', return_value=False), patch.object(bili.subprocess, 'run') as run:
            from subprocess import CompletedProcess
            run.side_effect = [CompletedProcess([], 0, stderr=''), CompletedProcess([], 1, stderr='Connection timed out')]
            with self.assertRaises(bili.SetupError) as caught: bili.setup()
            self.assertEqual(caught.exception.code, 'setup_failed')
            self.assertEqual(caught.exception.stage, 'install_dependencies')

    def test_url_validation(self):
        self.assertEqual(bili.normalize('https://www.bilibili.com/video/BV1mZYj6VEwb/?spm=x'), 'BV1mZYj6VEwb')
        for url in ['https://evil.com/video/BV1mZYj6VEwb', 'https://bilibili.com.evil.com/video/BV1mZYj6VEwb', 'file:///video/BV1mZYj6VEwb', 'https://x@bilibili.com/video/BV1mZYj6VEwb', 'BV1mZYj6VEwb;rm -rf /']:
            with self.assertRaises(ValueError): bili.normalize(url)
        with self.assertRaises(ValueError): bili.job_dir('../../secrets')

    def test_resume_skips_download_and_delivers_files(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {'BILI_HOME': temp}):
            directory = bili.job_dir('BV1mZYj6VEwb-small')
            directory.mkdir(parents=True)
            (directory / 'audio.m4a').write_bytes(b'audio')
            bili.save(directory / 'audio-manifest.json', [{'index':1, 'audioFile':str(directory / 'audio.m4a')}])
            bili.save(directory / 'job.json', {'id':directory.name, 'bvid':'BV1mZYj6VEwb','model':'small','browser':None})
            def transcribe(command, **kwargs):
                self.assertIn('transcribe_audio_local.py', command[-1])
                items = json.loads((directory / 'audio-manifest.json').read_text())
                self.assertEqual(items[0]['status'], 'exists')
                self.assertEqual(len(transcriber.select_items(items)), 1)
                output = directory / 'transcripts/small'
                output.mkdir(parents=True)
                bili.save(output / 'transcription-summary.json', {'failureCount':0, 'selectedCount':1})
                (output / 'video.srt').write_text('1\n00:00:00,000 --> 00:00:01,000\n测试')
                (output / 'video.txt').write_text('测试')
            with patch.object(bili.subprocess, 'run', side_effect=transcribe):
                bili.worker(directory.name)
            result = bili.status(directory.name)
            self.assertEqual(result['status'], 'succeeded')
            self.assertEqual(len(result['files']), 2)
            self.assertFalse((directory / 'worker.lock').exists())

    def test_download_failure_is_recoverable(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {'BILI_HOME': temp}):
            directory = bili.job_dir('BV1mZYj6VEwb-small'); directory.mkdir(parents=True)
            bili.save(directory / 'job.json', {'id':directory.name,'bvid':'BV1mZYj6VEwb','model':'small','browser':None})
            with patch.object(bili.subprocess, 'run') as run:
                run.return_value.returncode = 1
                bili.worker(directory.name)
            self.assertEqual(bili.status(directory.name)['status'], 'failed')
            self.assertFalse((directory / 'worker.lock').exists())

    def test_fresh_manifest_matches_real_selector(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {'BILI_HOME':temp}):
            directory = bili.job_dir('BV1mZYj6VEwb-small'); directory.mkdir(parents=True)
            bili.save(directory / 'job.json', {'bvid':'BV1mZYj6VEwb','model':'small','browser':None})
            def run(command, **kwargs):
                if 'yt_dlp' in command:
                    (directory / 'audio.m4a').write_bytes(b'audio')
                    bili.save(directory / 'audio.info.json', {'title':'test'})
                    return bili.subprocess.CompletedProcess(command, 0)
                items = json.loads((directory / 'audio-manifest.json').read_text())
                self.assertEqual(items[0]['status'], 'downloaded')
                self.assertEqual(len(transcriber.select_items(items)), 1)
                output = directory / 'transcripts/small'; output.mkdir(parents=True)
                bili.save(output / 'transcription-summary.json', {'selectedCount':0,'failureCount':0})
                # Stale outputs must not mask a zero-selection run.
                (output / 'old.srt').write_text('old')
                (output / 'old.txt').write_text('old')
            with patch.object(bili.subprocess, 'run', side_effect=run): bili.worker(directory.name)
            result = bili.status(directory.name)
            self.assertEqual(result['status'], 'failed')
            self.assertIn('selectedCount=0', result['error'])

    def test_manifest_repair_rejects_invalid_audio_without_writing(self):
        with tempfile.TemporaryDirectory() as temp:
            manifest = Path(temp) / 'manifest.json'
            audio = Path(temp) / 'empty.m4a'; audio.touch()
            for value in [[], [{'audioFile':str(audio)}], [{'audioFile':str(Path(temp)/'missing')}]]:
                bili.save(manifest, value)
                before = manifest.read_bytes()
                with self.assertRaises(RuntimeError): bili.prepare_manifest(manifest)
                self.assertEqual(manifest.read_bytes(), before)

    def test_manifest_does_not_override_explicit_failed_status(self):
        with tempfile.TemporaryDirectory() as temp:
            audio = Path(temp) / 'audio.m4a'; audio.write_bytes(b'audio')
            manifest = Path(temp) / 'manifest.json'
            bili.save(manifest, [{'audioFile':str(audio), 'status':'failed'}])
            with self.assertRaises(RuntimeError): bili.prepare_manifest(manifest)
            self.assertEqual(json.loads(manifest.read_text())[0]['status'], 'failed')


if __name__ == '__main__': unittest.main()
