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


class SkillTests(unittest.TestCase):
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
            bili.save(directory / 'audio-manifest.json', [])
            bili.save(directory / 'job.json', {'id':directory.name, 'bvid':'BV1mZYj6VEwb','model':'small','browser':None})
            def transcribe(command, **kwargs):
                self.assertIn('transcribe_audio_local.py', command[-1])
                output = directory / 'transcripts/small'
                output.mkdir(parents=True)
                bili.save(output / 'transcription-summary.json', {'failureCount':0})
                (output / 'video.srt').write_text('1\n00:00:00,000 --> 00:00:01,000\n测试')
            with patch.object(bili.subprocess, 'run', side_effect=transcribe):
                bili.worker(directory.name)
            result = bili.status(directory.name)
            self.assertEqual(result['status'], 'succeeded')
            self.assertEqual(len(result['files']), 1)
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


if __name__ == '__main__': unittest.main()
