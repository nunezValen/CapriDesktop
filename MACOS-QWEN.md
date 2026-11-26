# Qwen3-TTS on Apple Silicon

Mac-specific follow-up to upstream PR #48. This change contains only TTS integration fixes.

## Setup

Use the Apple Silicon build on a Mac with Python 3.11 and FFmpeg available. Prepare the voice environment in Mac settings, then open Settings → TTS, select Qwen3-TTS, choose a mode and size, and download that model. Preview before pressing Save. Downloading a model does not select Qwen as the saved voice.

Start with Custom Voice 0.6B on an 8 GB Mac. The GPU budget is an estimate, not a live memory measurement or a guarantee that models fit. A local 7B chat model plus Qwen can exceed the unified-memory budget; the bar reflects this. Voice Design requires the 1.7B model. Each mode/size has a separate download.

Setup, offline readiness checks, worker playback and installed-parts inventory now use the same Mac speech cache: `~/Library/Application Support/Capri Desktop/speech-models/hub`, or the `whisper/hub` folder inside the requirements location you selected. The existing Mac storage move includes this cache. Preview/inference stays offline after the explicit download.

The loader resolves the downloaded snapshot to a local path before calling qwen-tts; loading by repository ID caused a Hub API request to fail in the offline worker even after downloading.

MPS uses BF16 on macOS 14+ to avoid the FP16 generation-logit overflow seen in testing, and FP32 on older MPS runtimes, with PyTorch SDPA attention. FlashAttention is selected only for CUDA. Switching modes/sizes clears the previous MPS allocation cache as well as the previous model and clone prompt.

## Checks

- `npm run test:qwen-mac`: checks the shared Mac cache and storage plan, offline snapshot loading, MPS model replacement/cache release and a real FFmpeg 24 kHz pitch-filter duration regression, without downloading models.
- `npm run test:gpu-budget`: existing budget/model-selection tests.
- `npm run typecheck`: main/preload and renderer type checks.

Runtime validation and its limits are recorded below.

### Runtime validation — 2026-11-24

On Apple A18 Pro, 8 GB unified memory, macOS 27.0, Python 3.11.18, qwen-tts 0.1.1 and PyTorch 2.15.0:

- Downloaded CustomVoice 0.6B and its speech tokenizer; both weight files passed their published SHA-256 checks. Offline readiness returned true.
- The real worker generated two English lines with `HF_HUB_OFFLINE=1`, strict Qwen mode and no fallback. Both responses reported `provider: qwen3-tts` and `device: mps`.
- The two-line run, including model loading, took 24.82 seconds. This is a local smoke-test measurement, not a latency guarantee. The decoded outputs were 1.51 and 1.98 seconds long, finite and non-silent; both used the +32 Hz pitch setting. The worker reused the loaded model and exited successfully after stdin closed.
- FP16 initially failed with non-finite generation probabilities; BF16 completed the same requests. Loading by repository ID initially failed offline; using the local snapshot resolved it.
- The independent packaged app reported the model ready and returned a successful preview through preload/IPC in 19.48 seconds, leaving the saved provider unchanged. Closing the app also stopped its Qwen worker.
- TypeScript checks, 11 GPU-budget tests and the standalone Mac cache/audio/MPS checks pass. Apple Silicon app and DMG packaging/signature checks pass.

The 1.7B, Voice Design and real voice-cloning models were not downloaded or runtime tested on this 8 GB Mac. MPS model replacement is tested with mocks, not a second live model. Older macOS/FP32 fallback, Intel, Windows/CUDA and Linux runtime were not tested. The build is locally development-signed and is not notarized.
