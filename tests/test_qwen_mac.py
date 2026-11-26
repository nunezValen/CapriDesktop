"""Mac Qwen lifecycle and real FFmpeg audio checks, without downloading models."""
import importlib.util
import os
from pathlib import Path
import shutil
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch
import wave
import math
import struct

spec = importlib.util.spec_from_file_location('capri_voice', Path(__file__).parents[1] / 'scripts/capri_voice.py')
voice = importlib.util.module_from_spec(spec)
spec.loader.exec_module(voice)


class QwenMacTests(unittest.TestCase):
    def test_switching_models_frees_mps_cache_and_uses_sdpa(self):
        torch = types.SimpleNamespace(
            cuda=types.SimpleNamespace(is_available=lambda: False),
            backends=types.SimpleNamespace(mps=types.SimpleNamespace(is_available=lambda: True, is_macos_or_newer=lambda *_: True)),
            mps=types.SimpleNamespace(empty_cache=Mock()), bfloat16='bf16', float16='fp16', float32='fp32',
        )
        loader = Mock(side_effect=[object(), object()])
        qwen = types.SimpleNamespace(Qwen3TTSModel=types.SimpleNamespace(from_pretrained=loader))
        snapshot = Mock(return_value='/cached/qwen-snapshot')
        hub = types.SimpleNamespace(snapshot_download=snapshot)
        initial = voice._qwen_state.copy()
        voice._qwen_state.update(key=None, model=None, device=None, prompt=None, prompt_key=None)
        try:
            # An importable FlashAttention must never select the CUDA kernel on MPS.
            with patch.dict(sys.modules, torch=torch, qwen_tts=qwen, huggingface_hub=hub, flash_attn=types.SimpleNamespace()), patch.dict(os.environ, CAPRI_ALLOW_MODEL_DOWNLOAD="0"):
                first, device = voice.load_qwen_tts('custom', '0.6B')
                self.assertEqual(device, 'mps')
                self.assertIs(voice.load_qwen_tts('custom', '0.6B')[0], first)
                self.assertEqual(loader.call_count, 1)
                voice.load_qwen_tts('clone', '0.6B')
            torch.mps.empty_cache.assert_called_once()
            self.assertEqual(loader.call_args.args, ('/cached/qwen-snapshot',))
            self.assertTrue(snapshot.call_args.kwargs['local_files_only'])
            self.assertEqual(loader.call_args.kwargs, {'device_map': 'mps', 'dtype': 'bf16', 'attn_implementation': 'sdpa'})
            self.assertIsNone(voice._qwen_state['prompt'])
        finally:
            voice._qwen_state.update(initial)

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg required')
    def test_24khz_qwen_pitch_filter_preserves_duration(self):
        import subprocess
        with tempfile.TemporaryDirectory() as directory:
            raw, out = os.path.join(directory, 'raw.wav'), os.path.join(directory, 'out.mp3')
            with wave.open(raw, 'wb') as f:
                f.setparams((1, 2, 24000, 0, 'NONE', 'not compressed'))
                f.writeframes(b''.join(struct.pack('<h', int(8000 * math.sin(2 * math.pi * 440 * i / 24000))) for i in range(48000)))
            self.assertTrue(voice.apply_audio_filter(raw, out, 'none', voice.parse_pitch_multiplier('+32Hz')))
            duration = float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', out]))
            self.assertAlmostEqual(duration, 2.0, delta=0.15)


if __name__ == '__main__':
    unittest.main()
