import sys
import os
import re
import json
import asyncio
import argparse
import subprocess
import hashlib
import time
import shutil

# Ensure Windows finds PyTorch CUDA DLLs (cublas64_12.dll, etc.) for local GPU acceleration
script_dir = os.path.dirname(os.path.abspath(__file__))
torch_lib_candidates = [
    os.path.join(sys.prefix, "Lib", "site-packages", "torch", "lib"),
    os.path.join(script_dir, "..", ".venv", "Lib", "site-packages", "torch", "lib"),
]
for tlib in torch_lib_candidates:
    if os.path.exists(tlib):
        if hasattr(os, "add_dll_directory"):
            try:
                os.add_dll_directory(tlib)
            except Exception:
                pass
        os.environ["PATH"] = tlib + os.pathsep + os.environ.get("PATH", "")
        break

def find_ffmpeg() -> str:
    """CAPRI_FFMPEG env var, then PATH, then a winget install of Gyan.FFmpeg."""
    explicit = os.environ.get("CAPRI_FFMPEG", "").strip()
    if explicit and os.path.exists(explicit):
        return explicit
    on_path = shutil.which("ffmpeg")
    if on_path:
        return on_path
    import glob
    winget = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "WinGet", "Packages")
    hits = glob.glob(os.path.join(winget, "Gyan.FFmpeg*", "*", "bin", "ffmpeg.exe"))
    return sorted(hits)[-1] if hits else "ffmpeg"

FFMPEG = find_ffmpeg()

# Writable folder with voice_config.json, voice_config.local.json (API keys) and the audio cache.
# The app passes it in CAPRI_VOICE_DIR; running the script by hand falls back to the repo assets.
VOICE_DIR = os.environ.get("CAPRI_VOICE_DIR") or os.path.join(script_dir, "..", "assets", "capri_voice")

def load_env_file():
    candidates = [
        os.environ.get("CAPRI_ENV_FILE", ""),
        os.path.join(os.path.dirname(__file__), "..", ".env"),
    ]
    for env_path in candidates:
        if os.path.exists(env_path):
            try:
                with open(env_path, "r", encoding="utf-8") as ef:
                    for line in ef:
                        line = line.strip()
                        if not line or line.startswith("#"):
                            continue
                        if "=" in line:
                            k, v = line.split("=", 1)
                            k = k.strip()
                            v = v.strip().strip('"').strip("'")
                            if k not in os.environ:
                                os.environ[k] = v
                break
            except Exception:
                pass

SYNTH_FILTERS = {
    "cyber_android": (
        "highpass=f=175,"
        "flanger=delay=2.5:depth=1.8:regen=35:width=70:speed=0.6,"
        "aecho=0.8:0.7:18|28:0.25|0.18,"
        "equalizer=f=3400:width_type=h:w=600:g=3.0,"
        "equalizer=f=8000:width_type=h:w=1200:g=2.5"
    ),
    "aguda_cyber": (
        "highpass=f=185,"
        "flanger=delay=2.5:depth=1.8:regen=35:width=70:speed=0.6,"
        "aecho=0.8:0.7:18|28:0.25|0.18,"
        "equalizer=f=3400:width_type=h:w=600:g=3.2,"
        "equalizer=f=8000:width_type=h:w=1200:g=2.8"
    ),
    "synth_hologram": (
        "highpass=f=160,"
        "aphaser=in_gain=0.9:out_gain=0.85:delay=3:decay=0.4:speed=0.5:type=t,"
        "aecho=0.8:0.65:15|30:0.25|0.18,"
        "equalizer=f=1400:width_type=h:w=300:g=2.5"
    ),
    "robot_vocoder": (
        "highpass=f=175,"
        "flanger=delay=4:depth=3:regen=55:width=85:speed=0.8,"
        "aecho=0.75:0.7:12|22:0.4|0.3,"
        "equalizer=f=400:width_type=h:w=150:g=-3,"
        "equalizer=f=2800:width_type=h:w=500:g=4"
    ),
    "glitch_mech": (
        "highpass=f=200,lowpass=f=7500,"
        "aecho=0.8:0.8:8|16|24:0.4|0.3|0.2,"
        "tremolo=f=8:d=0.2,"
        "flanger=delay=1.5:depth=1.2:regen=50:width=60:speed=1.0"
    )
}

def parse_pitch_multiplier(pitch_str: str) -> float:
    """
    Converts a pitch configuration string (e.g. '+28Hz', '+32Hz', '+15%') into a frequency multiplier.
    Baseline human voice fundamental frequency for female anime/young adult is ~220Hz.
    +28Hz -> 1.13x
    +32Hz -> 1.15x
    +35Hz -> 1.16x
    """
    if not pitch_str:
        return 1.15
    try:
        s = str(pitch_str).strip().lower()
        if s.endswith("%"):
            val = float(s.replace("%", "").replace("+", ""))
            return max(0.8, min(1.45, 1.0 + (val / 100.0)))
        if s.endswith("hz"):
            val = float(s.replace("hz", "").replace("+", ""))
            return max(0.85, min(1.4, 1.0 + (val / 220.0)))
        val = float(s)
        if 0.7 <= val <= 1.6:
            return val
    except Exception:
        pass
    return 1.15

def apply_audio_filter(raw_path: str, out_path: str, synth_preset: str = "cyber_android", pitch_mult: float = 1.0) -> bool:
    if not os.path.exists(raw_path) or os.path.getsize(raw_path) == 0:
        return False
    preset = synth_preset or "cyber_android"

    pitch_filter = ""
    if abs(pitch_mult - 1.0) >= 0.01:
        # Resample to 44.1 kHz first: asetrate assumes 44.1 kHz input, but local engines
        # (Qwen3-TTS writes 24 kHz) would otherwise play too fast and too high.
        pitch_filter = f"aresample=44100,asetrate=44100*{pitch_mult:.3f},aresample=44100,atempo={1.0/pitch_mult:.3f},"

    if preset == "none" or (preset not in SYNTH_FILTERS and preset != "ringmod"):
        if pitch_filter:
            cmd = [FFMPEG, "-y", "-threads", "4", "-i", raw_path, "-af", pitch_filter.rstrip(","), "-b:a", "192k", out_path]
            proc = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return proc.returncode == 0
        if raw_path.lower().endswith(".wav"):
            # Turns the wav from local engines into mp3
            cmd = [FFMPEG, "-y", "-i", raw_path, "-b:a", "192k", out_path]
            return subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
        if os.path.abspath(raw_path) != os.path.abspath(out_path):
            shutil.copyfile(raw_path, out_path)
        return True

    if preset == "ringmod":
        filter_complex = f"[0:a]{pitch_filter}volume=1.0[pitched];[pitched][1:a]amultiply,volume=2.2[mod];[pitched][mod]amix=inputs=2:weights=0.65 0.35[out]"
        cmd = [
            FFMPEG, "-y",
            "-i", raw_path,
            "-f", "lavfi", "-i", "sine=frequency=42:sample_rate=44100",
            "-filter_complex", filter_complex,
            "-map", "[out]",
            "-b:a", "192k",
            out_path
        ]
        proc = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if proc.returncode != 0 and os.path.abspath(raw_path) != os.path.abspath(out_path):
            shutil.copyfile(raw_path, out_path)
        return proc.returncode == 0

    base_chain = SYNTH_FILTERS.get(preset, SYNTH_FILTERS["cyber_android"])
    if pitch_filter:
        if base_chain.startswith("highpass="):
            hp_end = base_chain.find(",")
            fchain = base_chain[:hp_end+1] + pitch_filter + base_chain[hp_end+1:]
        else:
            fchain = pitch_filter + base_chain
    else:
        fchain = base_chain

    cmd = [FFMPEG, "-y", "-threads", "4", "-i", raw_path, "-af", fchain, "-b:a", "192k", out_path]
    proc = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if proc.returncode != 0 and os.path.abspath(raw_path) != os.path.abspath(out_path):
        shutil.copyfile(raw_path, out_path)
    return proc.returncode == 0

def clean_text_for_speech(text: str) -> str:
    # Remove code blocks
    text = re.sub(r'```[\s\S]*?```', '', text)
    # Remove inline code
    text = re.sub(r'`([^`]+)`', r'\1', text)
    # Remove URLs
    text = re.sub(r'https?://\S+', '', text)
    # Remove emojis and pictorial symbols so TTS does not read them out loud
    emoji_pattern = re.compile(
        "["
        "\U0001F000-\U0001FAFF"  # Emoticons, symbols, pictographs, transport
        "\U00002600-\U000027BF"  # Miscellaneous symbols, dingbats
        "\U00002B50-\U00002B55"
        "\U00002300-\U000023FF"
        "]+",
        flags=re.UNICODE
    )
    text = emoji_pattern.sub('', text)
    # Remove common emoji characters explicitly
    text = re.sub(r'[🐾✨👀⚡🎉🦾🛑💬🎵🔥💥💡⚔️📹🎮💤✓✕⚠️🤖🐱🐶👍👎❤️]', '', text)
    # Remove markdown symbols
    text = re.sub(r'[*#_~>|`]', '', text)
    # Normalize spaces
    text = re.sub(r'\s+', ' ', text).strip()
    return text

def is_portuguese_text(text: str) -> bool:
    lower = text.lower()
    # Portuguese-unique characters that never appear in Spanish
    if re.search(r'[ãõêôçà]', lower):
        return True
    pt_words = [
        'obrigado', 'obrigada', 'você', 'voce', 'vocês', 'voces', 'estou', 'música', 'musica',
        'não', 'nao', 'então', 'entao', 'também', 'tambem', 'abra', 'feche', 'beleza', 'valeu',
        'olá', 'ola', 'tudo', 'bem', 'fazer', 'fazendo', 'legal', 'muito', 'muita', 'pra', 'pro',
        'minha', 'meu', 'meus', 'minhas', 'arquivo', 'tarefa', 'fala', 'falar', 'falando', 'bora',
        'gente', 'ajuda', 'ajudar', 'tela', 'computador', 'pode', 'podem', 'consegue', 'comigo'
    ]
    for w in pt_words:
        if re.search(rf'\b{re.escape(w)}\b', lower):
            return True
    return False

def is_spanish_text(text: str) -> bool:
    if is_portuguese_text(text):
        return False

    lower = text.lower()
    # Pure English function words that never occur in authentic Spanish sentences
    en_markers = [
        'the', 'what', 'doing', 'your', 'with', 'this', 'that', 'have',
        'from', 'they', 'ready', 'systems', 'online', 'jacking', 'reboot',
        'complete', 'catch', 'side', 'powering', 'shutting', 'standing',
        'desktop', 'homework', 'easy', 'got', 'stop', 'dat', 'sparks',
        'construct', 'blackwall', 'look', 'see', 'can', 'will', 'you'
    ]
    for em in en_markers:
        if re.search(rf'\b{re.escape(em)}\b', lower):
            return False

    # Spanish unique characters
    if re.search(r'[ñ¿¡]', lower):
        return True

    spanish_words = [
        'hola', 'abriendo', 'cerrando', 'listo', 'lista', 'borrado', 'juego',
        'archivo', 'carpeta', 'vamos', 'gracias', 'cancion', 'canción', 'reproduciendo',
        'por favor', 'buenas', 'que tal', 'como estas', 'puedes', 'hacer',
        'estas', 'este', 'esta', 'esto', 'tema', 'pista', 'saltada', 'musica',
        'escritorio', 'pantalla', 'pestaña', 'pestana', 'ventana', 'equipo',
        'reinicio', 'apagaste', 'acuerdas', 'acordas', 'autoconsciente', 'quien',
        'sos', 'eres', 'subir', 'volumen', 'disfrutar', 'ritmo', 'bardo', 'che',
        'dale', 'pausado', 'sonando', 'reloj', 'calculadora', 'navegador', 'puse',
        'sacá', 'saca', 'manos', 'agarrar', 'agarrés', 'agarres', 'bajame',
        'susto', 'respiro', 'espía', 'espiando', 'mirando', 'laburar', 'dormilón',
        'largá', 'larga', 'subile', 'reventar', 'quilombo', 'temazo', 'vibrando',
        'estática', 'panorámica', 'pensando', 'atrapame', 'reflejos', 'lento',
        'vos', 'para', 'ahora', 'mismo', 'de una', 'al toque', 'bienvenido',
        'dibujo', 'dibuja', 'dibujá', 'dibujar', 'dibújame', 'dibujame',
        'perro', 'gato', 'casa', 'sol', 'arbol', 'árbol', 'monigote', 'auto', 'logo',
        'trazo', 'trazos', 'lienzo', 'aprende', 'aprendé', 'aprendiste', 'escáner', 'escaner',
        'escaneaste', 'tuyo', 'tuya', 'mio', 'mía', 'conmigo', 'tranqui', 'genial'
    ]
    for w in spanish_words:
        if re.search(rf'\b{re.escape(w)}\b', lower):
            return True

    # Generic Spanish accented vowels (checked only if no Portuguese markers matched)
    if any(c in 'áéíóúü' for c in lower):
        return True

    return False

def select_voice(text: str, cfg: dict, lang_override: str = None) -> str:
    # Non-Latin scripts must take absolute precedence over language override,
    # because Latin voices (es/en) fail with 'No audio was received' on CJK/Cyrillic scripts
    # Japanese (Hiragana / Katakana)
    if re.search(r'[\u3040-\u309F\u30A0-\u30FF]', text):
        return cfg.get("voice_ja", "ja-JP-NanamiNeural")

    # Chinese (CJK ideographs without Kana)
    if re.search(r'[\u4E00-\u9FFF]', text):
        return cfg.get("voice_zh", "zh-CN-XiaoxiaoNeural")

    # Korean (Hangul)
    if re.search(r'[\uAC00-\uD7AF\u1100-\u11FF]', text):
        return cfg.get("voice_ko", "ko-KR-SunHiNeural")

    # Russian / Cyrillic
    if re.search(r'[\u0400-\u04FF]', text):
        return cfg.get("voice_ru", "ru-RU-SvetlanaNeural")

    # Arabic
    if re.search(r'[\u0600-\u06FF]', text):
        return cfg.get("voice_ar", "ar-SA-ZariyahNeural")

    # Check if text is distinctly Spanish first before blind English override
    # Never allow a mistaken 'en' override to force an English voice on Spanish text.
    if is_spanish_text(text):
        if not lang_override or lang_override.lower().strip() in ('es', 'spanish', 'auto'):
            return cfg.get("voice_es", "es-AR-ElenaNeural")

    # Check explicit lang_override if specified (for Latin scripts like ja-romaji, zh-pinyin, es, en, etc.)
    if lang_override:
        lo = lang_override.lower().strip()
        if lo in ('ja', 'japanese', 'jp'):
            return cfg.get("voice_ja", "ja-JP-NanamiNeural")
        if lo in ('zh', 'chinese', 'cn'):
            return cfg.get("voice_zh", "zh-CN-XiaoxiaoNeural")
        if lo in ('ko', 'korean', 'kr'):
            return cfg.get("voice_ko", "ko-KR-SunHiNeural")
        if lo in ('ru', 'russian'):
            return cfg.get("voice_ru", "ru-RU-SvetlanaNeural")
        if lo in ('es', 'spanish', 'espanol', 'español'):
            return cfg.get("voice_es", "es-AR-ElenaNeural")
        if lo in ('en', 'english'):
            return cfg.get("active_voice", "en-US-AriaNeural")
        if lo in ('pt', 'portuguese'):
            return cfg.get("voice_pt", "pt-BR-FranciscaNeural")
        if lo in ('fr', 'french'):
            return cfg.get("voice_fr", "fr-FR-DeniseNeural")
        if lo in ('de', 'german'):
            return cfg.get("voice_de", "de-DE-KatjaNeural")
        if lo in ('it', 'italian'):
            return cfg.get("voice_it", "it-IT-ElsaNeural")
        if lo in ('pl', 'polish'):
            return cfg.get("voice_pl", "pl-PL-ZofiaNeural")
        if lo in ('nl', 'dutch'):
            return cfg.get("voice_nl", "nl-NL-ColetteNeural")
        if lo in ('tr', 'turkish'):
            return cfg.get("voice_tr", "tr-TR-EmelNeural")
        if lo in ('sv', 'swedish'):
            return cfg.get("voice_sv", "sv-SE-SofieNeural")
        if lo in ('uk', 'ukrainian'):
            return cfg.get("voice_uk", "uk-UA-PolinaNeural")

    # Text content heuristics for Latin scripts
    lower = text.lower()
    # Check Portuguese before Spanish so Portuguese phrases are never mistaken for Spanish
    if is_portuguese_text(text):
        return cfg.get("voice_pt", "pt-BR-FranciscaNeural")

    if is_spanish_text(text):
        return cfg.get("voice_es", "es-AR-ElenaNeural")

    # French
    fr_words = ['bonjour', 'merci', 'oui', 'salut', 'chanson', 'fermer', 'ouvrir', "s'il", 'vous', 'plaît', 'plait', 'avec']
    if any(re.search(rf'\b{w}\b', lower) for w in fr_words):
        return cfg.get("voice_fr", "fr-FR-DeniseNeural")

    # German
    de_words = ['hallo', 'danke', 'bitte', 'schließen', 'öffnen', 'musik', 'lied', 'tschüss', 'guten', 'morgen', 'tag']
    if any(re.search(rf'\b{w}\b', lower) for w in de_words):
        return cfg.get("voice_de", "de-DE-KatjaNeural")

    # Italian
    it_words = ['ciao', 'grazie', 'musica', 'canzone', 'chiudi', 'apri', 'buongiorno', 'buonasera', 'prego', 'per favore']
    if any(re.search(rf'\b{w}\b', lower) for w in it_words):
        return cfg.get("voice_it", "it-IT-ElsaNeural")

    # Default fallback for English and unknown Latin text is Capri's primary English voice
    return cfg.get("active_voice", "en-US-AriaNeural")

def synthesize_elevenlabs(text: str, out_path: str, el_cfg: dict, synth_preset: str = "cyber_android", pitch_str: str = "+32Hz") -> bool:
    import urllib.request
    import urllib.error

    api_key = el_cfg.get("api_key", "").strip()
    if not api_key:
        sys.stderr.write("[ElevenLabs] Error: Missing API Key\n")
        return False

    voice_id = el_cfg.get("voice_id", "21m00Tcm4TlvDq8ikWAM").strip() or "21m00Tcm4TlvDq8ikWAM"
    model_id = el_cfg.get("model_id", "eleven_multilingual_v2").strip() or "eleven_multilingual_v2"
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"

    payload = json.dumps({
        "text": text,
        "model_id": model_id,
        "voice_settings": {
            "stability": float(el_cfg.get("stability", 0.5)),
            "similarity_boost": float(el_cfg.get("similarity_boost", 0.75))
        }
    }).encode("utf-8")

    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            "xi-api-key": api_key,
            "Content-Type": "application/json",
            "Accept": "audio/mpeg"
        },
        method="POST"
    )

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = resp.read()
            with open(out_path, "wb") as f:
                f.write(data)
        return os.path.exists(out_path) and os.path.getsize(out_path) > 500
    except Exception as e:
        sys.stderr.write(f"[ElevenLabs] Request failed: {e}\n")
        return False

# Capri's voice on Fish Audio, used when no other voice model is set
DEFAULT_FISH_VOICE_ID = "f6f9169f53244cbfb3bd8ce69bf2db10"

def synthesize_fish_audio(text: str, out_path: str, fish_cfg: dict, synth_preset: str = "cyber_android", pitch_str: str = "+32Hz") -> bool:
    import urllib.request
    import urllib.error

    load_env_file()
    api_key = fish_cfg.get("api_key", "").strip() or os.environ.get("FISH_AUDIO_API_KEY", "").strip()
    if not api_key:
        sys.stderr.write("[Fish Audio] Error: Missing API Key\n")
        return False

    # Voice model to use (your own or one from the Fish Audio library). Empty = Capri's voice
    ref_id = fish_cfg.get("reference_id", "").strip() or os.environ.get("FISH_AUDIO_REFERENCE_ID", "").strip() or DEFAULT_FISH_VOICE_ID
    model = fish_cfg.get("model", "").strip() or os.environ.get("FISH_AUDIO_MODEL", "").strip() or "s2.1-pro-free"
    url = "https://api.fish.audio/v1/tts"

    body = {
        "text": text,
        "format": fish_cfg.get("format", "mp3")
    }
    if ref_id:
        body["reference_id"] = ref_id
    # How long Fish takes before answering: "normal" (best quality), "balanced" or "low". Measured
    # on a one-line reaction, "balanced" answered in 3-4s and "normal" in 5-6s
    latency = str(fish_cfg.get("latency", "") or os.environ.get("FISH_AUDIO_LATENCY", "") or "balanced").strip().lower()
    if latency in ("normal", "balanced", "low"):
        body["latency"] = latency

    emotions = re.findall(r'\[[a-zA-Z0-9_\s\-]+\]', text)
    sys.stderr.write(
        f"\n==================================================\n"
        f"[Fish Audio API Request]\n"
        f"  URL: {url}\n"
        f"  Model: {model}\n"
        f"  Reference ID: {ref_id}\n"
        f"  Format: {fish_cfg.get('format', 'mp3')}\n"
        f"  DSP Preset: {synth_preset} | Pitch: {pitch_str}\n"
        f"  Emotions detected: {emotions}\n"
        f"  Text Payload to API:\n"
        f"    \"{text}\"\n"
        f"==================================================\n"
    )
    sys.stderr.flush()

    payload = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "model": model
        },
        method="POST"
    )

    temp_raw = out_path + ".raw.mp3"
    try:
        data = None
        last_err = None
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=25) as resp:
                    data = resp.read()
                break
            except urllib.error.HTTPError as he:
                last_err = he
                # 4xx other than rate limiting won't fix itself by retrying
                if he.code not in (408, 429) and he.code < 500:
                    raise
            except Exception as te:
                last_err = te
            sys.stderr.write(f"[Fish Audio] Attempt {attempt + 1} failed ({last_err}), retrying...\n")
            time.sleep(1.2 * (attempt + 1))
        if data is None:
            raise last_err or RuntimeError("Fish Audio request failed")
        with open(temp_raw, "wb") as f:
            f.write(data)

        if not os.path.exists(temp_raw) or os.path.getsize(temp_raw) < 500:
            sys.stderr.write("[Fish Audio] Received empty or corrupted audio from API\n")
            if os.path.exists(temp_raw):
                try:
                    os.remove(temp_raw)
                except Exception:
                    pass
            return False

        # Apply acute robotic cyber filter to Fish Audio voice output
        pitch_mult = parse_pitch_multiplier(pitch_str)
        apply_audio_filter(temp_raw, out_path, synth_preset, pitch_mult=pitch_mult)
        if os.path.exists(temp_raw):
            try:
                os.remove(temp_raw)
            except Exception:
                pass

        return os.path.exists(out_path) and os.path.getsize(out_path) > 500
    except Exception as e:
        sys.stderr.write(f"[Fish Audio] Request failed: {e}\n")
        if os.path.exists(temp_raw):
            try:
                os.remove(temp_raw)
            except Exception:
                pass
        return False

QWEN_PROVIDERS = ("qwen3-tts", "qwen3_tts", "qwen3tts")
QWEN_TTS_REPOS = {
    ("custom", "0.6B"): "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
    ("custom", "1.7B"): "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
    ("clone", "0.6B"): "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
    ("clone", "1.7B"): "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
    ("design", "1.7B"): "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign",
}
QWEN_TTS_SPEAKERS = ["Vivian", "Serena", "Uncle_Fu", "Dylan", "Eric", "Ryan", "Aiden", "Ono_Anna", "Sohee"]
QWEN_TTS_LANGS = {
    "zh": "Chinese", "en": "English", "ja": "Japanese", "ko": "Korean", "de": "German",
    "fr": "French", "ru": "Russian", "pt": "Portuguese", "es": "Spanish", "it": "Italian",
}
QWEN_MAX_NEW_TOKENS = 2048
QWEN_REFERENCE_SECONDS = 30
_qwen_state = {"key": None, "model": None, "device": None, "prompt_key": None, "prompt": None}
_qwen_last_error = ""


def qwen_language(lang: str):
    if not lang:
        return "Auto"
    return QWEN_TTS_LANGS.get(lang.lower().split("-")[0])


def qwen_spec(q_cfg: dict):
    mode = q_cfg.get("mode") if q_cfg.get("mode") in ("custom", "clone", "design") else "custom"
    size = "1.7B" if mode == "design" or str(q_cfg.get("model_size", "0.6B")) == "1.7B" else "0.6B"
    return mode, size


def qwen_cache_id(q_cfg: dict, lang: str) -> str:
    mode, size = qwen_spec(q_cfg)
    ref = str(q_cfg.get("clone_ref_audio", "") or "")
    stamp = ""
    if mode == "clone" and ref and os.path.isfile(ref):
        stamp = f"{os.path.getmtime(ref)}:{os.path.getsize(ref)}"
    parts = [mode, size, q_cfg.get("speaker", ""), q_cfg.get("instruct", "")]
    if mode == "clone":
        parts += [ref, stamp, q_cfg.get("clone_ref_text", ""), bool(q_cfg.get("clone_xvector_only"))]
    if mode == "design":
        parts += [q_cfg.get("design_description", "")]
    return "|".join(str(p) for p in parts) + f"|{lang or ''}"


def load_qwen_tts(mode: str, size: str):
    key = (mode, size)
    if _qwen_state["model"] is not None and _qwen_state["key"] == key:
        return _qwen_state["model"], _qwen_state["device"]
    import torch
    from qwen_tts import Qwen3TTSModel

    if _qwen_state["model"] is not None:
        _qwen_state.update({"model": None, "key": None, "prompt": None, "prompt_key": None})
        import gc
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    if torch.cuda.is_available():
        device = "cuda:0"
        dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        device, dtype = "mps", torch.float16
    else:
        device, dtype = "cpu", torch.float32

    kwargs = {"device_map": device, "dtype": dtype}
    try:
        import flash_attn  # noqa: F401
        kwargs["attn_implementation"] = "flash_attention_2"
    except Exception:
        kwargs["attn_implementation"] = "sdpa"
    repo = QWEN_TTS_REPOS[key]
    sys.stderr.write(f"[Qwen3-TTS] Loading {repo} on {device} ({kwargs['attn_implementation']})\n")
    model = Qwen3TTSModel.from_pretrained(repo, **kwargs)
    _qwen_state.update({"key": key, "model": model, "device": device})
    return model, device


def prepare_reference(path: str) -> str:
    """Converts the reference to a short mono wav so any audio file works."""
    import hashlib
    st = os.stat(path)
    digest = hashlib.sha256(f"{path}|{st.st_mtime}|{st.st_size}".encode()).hexdigest()[:16]
    out_dir = os.path.join(VOICE_DIR, "clone")
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, f"prep_{digest}.wav")
    if os.path.exists(out) and os.path.getsize(out) > 1000:
        return out
    cmd = [FFMPEG, "-y", "-i", path, "-t", str(QWEN_REFERENCE_SECONDS), "-ac", "1", "-ar", "24000", out]
    try:
        ok = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    except OSError:
        ok = False
    return out if ok and os.path.exists(out) else path


def with_token_limit(fn, **kwargs):
    try:
        return fn(max_new_tokens=QWEN_MAX_NEW_TOKENS, **kwargs)
    except TypeError:
        return fn(**kwargs)


def qwen_generate(model, mode: str, size: str, text: str, language: str, q_cfg: dict):
    if mode == "clone":
        ref = str(q_cfg.get("clone_ref_audio", "") or "")
        if not ref or not os.path.isfile(ref):
            raise RuntimeError("No reference audio selected for voice cloning")
        ref_text = str(q_cfg.get("clone_ref_text", "") or "").strip()
        xvec = bool(q_cfg.get("clone_xvector_only")) or not ref_text
        prepared = prepare_reference(ref)
        prompt_key = (size, prepared, ref_text, xvec)
        if _qwen_state["prompt_key"] != prompt_key:
            _qwen_state["prompt"] = model.create_voice_clone_prompt(ref_audio=prepared, ref_text=None if xvec else ref_text, x_vector_only_mode=xvec)
            _qwen_state["prompt_key"] = prompt_key
        return with_token_limit(model.generate_voice_clone, text=[text], language=[language], voice_clone_prompt=_qwen_state["prompt"])
    if mode == "design":
        description = str(q_cfg.get("design_description", "") or "").strip()
        if not description:
            raise RuntimeError("Describe the voice first")
        return with_token_limit(model.generate_voice_design, text=text, language=language, instruct=description)
    speaker = q_cfg.get("speaker") if q_cfg.get("speaker") in QWEN_TTS_SPEAKERS else "Vivian"
    kwargs = {"text": text, "language": language, "speaker": speaker}
    instruct = str(q_cfg.get("instruct", "") or "").strip() if size == "1.7B" else ""
    if instruct:
        kwargs["instruct"] = instruct
    return with_token_limit(model.generate_custom_voice, **kwargs)


def synthesize_qwen3(text: str, out_path: str, q_cfg: dict, lang: str, synth_preset: str, pitch_str: str) -> bool:
    global _qwen_last_error
    _qwen_last_error = ""
    if os.environ.get("CAPRI_TTS_WORKER") != "1":
        _qwen_last_error = "Qwen3-TTS only runs inside the voice worker"
        return False
    language = qwen_language(lang)
    if language is None:
        _qwen_last_error = f"Qwen3-TTS does not speak '{lang}'"
        sys.stderr.write(f"[Qwen3-TTS] {_qwen_last_error}, using Edge-TTS for this line\n")
        return False
    mode, size = qwen_spec(q_cfg)
    raw = out_path + ".raw.wav"
    try:
        import soundfile as sf
        model, _device = load_qwen_tts(mode, size)
        wavs, sr = qwen_generate(model, mode, size, text, language, q_cfg)
        sf.write(raw, wavs[0], sr)
        apply_audio_filter(raw, out_path, synth_preset, pitch_mult=parse_pitch_multiplier(pitch_str))
        return os.path.exists(out_path) and os.path.getsize(out_path) > 500
    except Exception as e:
        _qwen_last_error = str(e)
        sys.stderr.write(f"[Qwen3-TTS] Failed: {e}\n")
        return False
    finally:
        if os.path.exists(raw):
            try:
                os.remove(raw)
            except Exception:
                pass


def design_reference(text: str, description: str, lang: str, out_path: str) -> dict:
    """Makes a sample with a designed voice and saves it as wav for cloning."""
    language = qwen_language(lang)
    if language is None:
        return {"success": False, "error": f"Qwen3-TTS does not speak '{lang}'"}
    try:
        import soundfile as sf
        model, _device = load_qwen_tts("design", "1.7B")
        wavs, sr = qwen_generate(model, "design", "1.7B", text, language, {"design_description": description})
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        sf.write(out_path, wavs[0], sr)
        return {"success": True, "path": out_path}
    except Exception as e:
        return {"success": False, "error": str(e)}


def plain_speech_text(cleaned: str, voice: str) -> str:
    """Removes emotion tags and writes laughs out as words for engines that cannot act them."""
    laugh_word = "jajaja" if str(voice).lower().startswith("es-") else "hahaha"
    giggle_word = "jiji" if str(voice).lower().startswith("es-") else "hehe"
    text = re.sub(r'\[(?:laughs?\s+hard|laugh(?:s|ing)?|chuckl(?:e|es|ing))\]', f' {laugh_word}, ', cleaned, flags=re.IGNORECASE)
    text = re.sub(r'\[(?:giggl(?:e|es|ing))\]', f' {giggle_word}, ', text, flags=re.IGNORECASE)
    text = re.sub(r'\[[a-zA-Z0-9_,\s\-]+\]', '', text)
    text = re.sub(r'\s+,', ',', re.sub(r'\s+', ' ', text)).strip(' ,')
    return re.sub(r'[{}\[\]"\'`]+', '', text).strip(' ,')


async def synthesize_speech(text: str, out_path: str, lang_override: str = None, use_cache: bool = True, cfg_override: dict = None):
    cleaned = clean_text_for_speech(text)
    if not cleaned:
        cleaned = "Standing by, choomba!"

    # Load base voice config
    cfg_candidates = [os.path.join(VOICE_DIR, "voice_config.json")]
    cfg = {}
    for cp in cfg_candidates:
        if os.path.exists(cp):
            try:
                with open(cp, "r", encoding="utf-8") as f:
                    cfg = json.load(f)
                break
            except Exception:
                pass

    # Merge local uncommitted secrets and config overrides if present
    local_candidates = [os.path.join(VOICE_DIR, "voice_config.local.json")]
    for lp in local_candidates:
        if os.path.exists(lp):
            try:
                with open(lp, "r", encoding="utf-8") as f:
                    local_cfg = json.load(f)
                    if isinstance(local_cfg, dict):
                        if "provider" in local_cfg:
                            cfg["provider"] = local_cfg["provider"]
                        if "synth_preset" in local_cfg:
                            cfg["synth_preset"] = local_cfg["synth_preset"]
                        if "fish_audio" in local_cfg and isinstance(local_cfg["fish_audio"], dict):
                            cfg.setdefault("fish_audio", {}).update(local_cfg["fish_audio"])
                        if "elevenlabs" in local_cfg and isinstance(local_cfg["elevenlabs"], dict):
                            cfg.setdefault("elevenlabs", {}).update(local_cfg["elevenlabs"])
                        if "qwen3_tts" in local_cfg and isinstance(local_cfg["qwen3_tts"], dict):
                            cfg.setdefault("qwen3_tts", {}).update(local_cfg["qwen3_tts"])
                break
            except Exception:
                pass

    for key, value in (cfg_override or {}).items():
        if isinstance(value, dict):
            cfg.setdefault(key, {}).update(value)
        else:
            cfg[key] = value

    load_env_file()

    active_voice = cfg.get("active_voice", "en-US-AriaNeural")
    pitch = cfg.get("pitch", "+28Hz")
    rate = cfg.get("rate", "+25%")
    synth_preset = cfg.get("synth_preset", "cyber_android")
    voice = select_voice(cleaned, cfg, lang_override)
    provider = cfg.get("provider", "edge-tts").lower().strip()

    # Disk cache lookup with provider partition to prevent cross-provider stale audio
    # Disk cache lookup with provider partition and ttl handling
    cache_dir = os.path.join(VOICE_DIR, "cache")
    CACHE_TTL_SECONDS = 30 * 24 * 3600  # phrases are deterministic: keep them for 30 days
    cached_file = None
    if use_cache:
        try:
            os.makedirs(cache_dir, exist_ok=True)
            fish_id = ""
            if provider in ("fish-audio", "fish_audio", "fishaudio"):
                fcfg = cfg.get("fish_audio", {}) or {}
                fish_id = f"{fcfg.get('reference_id', '')}|{fcfg.get('model', '')}"
            if provider in QWEN_PROVIDERS:
                fish_id = qwen_cache_id(cfg.get("qwen3_tts", {}) or {}, lang_override or "")
            raw_key = f"{provider}|{cleaned.lower()}|{voice}|{pitch}|{rate}|{synth_preset}|{fish_id}"
            cache_hash = hashlib.md5(raw_key.encode("utf-8")).hexdigest()
            cached_file = os.path.join(cache_dir, f"{cache_hash}.mp3")
            if os.path.exists(cached_file) and os.path.getsize(cached_file) > 1024:
                # Verify ttl – discard stale files
                mtime = os.path.getmtime(cached_file)
                if time.time() - mtime < CACHE_TTL_SECONDS:
                    shutil.copyfile(cached_file, out_path)
                    print(json.dumps({"success": True, "path": out_path, "voice": voice, "cached": True, "provider": provider}))
                    return
                else:
                    # Stale cache – remove it so a fresh request happens
                    try:
                        os.remove(cached_file)
                    except Exception:
                        pass
        except Exception:
            cached_file = None
    if provider == "elevenlabs":
        pitch_mult = parse_pitch_multiplier(pitch)
        success = synthesize_elevenlabs(cleaned, out_path, cfg.get("elevenlabs", {}), synth_preset, pitch)
        if success:
            apply_audio_filter(out_path, out_path, synth_preset, pitch_mult=pitch_mult)
            if cached_file and os.path.exists(out_path) and os.path.getsize(out_path) > 1024:
                try:
                    shutil.copyfile(out_path, cached_file)
                except Exception:
                    pass
            print(json.dumps({"success": True, "path": out_path, "provider": "elevenlabs"}))
            return
        sys.stderr.write("[TTS] ElevenLabs failed or unconfigured, falling back to Edge-TTS\n")
    elif provider in QWEN_PROVIDERS:
        qwen_text = plain_speech_text(cleaned, voice) or cleaned
        qlang = (lang_override or "").lower().strip()
        success = synthesize_qwen3(qwen_text, out_path, cfg.get("qwen3_tts", {}), "" if qlang in ("", "auto") else qlang, synth_preset, pitch)
        if success:
            if cached_file and os.path.exists(out_path) and os.path.getsize(out_path) > 1024:
                try:
                    shutil.copyfile(out_path, cached_file)
                except Exception:
                    pass
            print(json.dumps({"success": True, "path": out_path, "provider": "qwen3-tts"}))
            return
        if cfg.get("_strict"):
            print(json.dumps({"success": False, "error": _qwen_last_error or "Qwen3-TTS failed"}))
            return
        sys.stderr.write("[TTS] Qwen3-TTS failed or unavailable, falling back to Edge-TTS\n")
    elif provider in ("fish-audio", "fish_audio", "fishaudio"):
        # For Fish Audio, keep full emotion tags intact (e.g. [excited], [giggles], [playful])
        success = synthesize_fish_audio(cleaned, out_path, cfg.get("fish_audio", {}), synth_preset, pitch)
        if success:
            if cached_file and os.path.exists(out_path) and os.path.getsize(out_path) > 1024:
                try:
                    shutil.copyfile(out_path, cached_file)
                except Exception:
                    pass
            print(json.dumps({"success": True, "path": out_path, "provider": "fish-audio"}))
            return
        sys.stderr.write("[TTS] Fish Audio failed or unconfigured, falling back to Edge-TTS\n")

    # Edge-TTS Synthesis: Strip square bracket emotion tags so Edge-TTS does not speak them
    emotions = re.findall(r'\[[a-zA-Z0-9_\s\-]+\]', cleaned)
    # Fish Audio performs [laugh]/[giggles] as real laughter; Edge-TTS would read the tag or drop it,
    # so laughter is written out instead ("jajaja" for Spanish voices, "hahaha" otherwise).
    edge_text = plain_speech_text(cleaned, voice)
    if not edge_text:
        edge_text = cleaned

    # Guard: if edge_text has no pronounceable words, discard to prevent speaking stray symbols
    if not re.search(r'[\w\u00C0-\u024F\u0400-\u04FF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]', edge_text):
        sys.stderr.write(f"[Edge-TTS Guard] Discarding text with no pronounceable words: '{edge_text}'\n")
        print(json.dumps({"success": False, "error": "No pronounceable text"}))
        return

    sys.stderr.write(
        f"\n==================================================\n"
        f"[Edge-TTS Request]\n"
        f"  Voice: {voice}\n"
        f"  Pitch: {pitch} | Rate: {rate}\n"
        f"  DSP Preset: {synth_preset}\n"
        f"  Emotions in text: {emotions}\n"
        f"  Clean Text Spoken by Edge-TTS:\n"
        f"    \"{edge_text}\"\n"
        f"==================================================\n"
    )
    sys.stderr.flush()

    try:
        import edge_tts  # Only this voice needs it: a missing package can't take down the others

        temp_raw = out_path + ".raw.mp3"
        communicate = edge_tts.Communicate(edge_text, voice, pitch=pitch, rate=rate)
        await communicate.save(temp_raw)

        # Apply robotic filter (pitch shift already handled natively by Edge-TTS)
        apply_audio_filter(temp_raw, out_path, synth_preset, pitch_mult=1.0)
        if os.path.exists(temp_raw):
            try:
                os.remove(temp_raw)
            except Exception:
                pass
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        return

    is_fallback = provider not in ("edge-tts", "edge_tts", "edge")

    # Save to disk cache for future instant playback (only real output of the selected provider)
    if not is_fallback and cached_file and os.path.exists(out_path) and os.path.getsize(out_path) > 1024:
        try:
            shutil.copyfile(out_path, cached_file)
        except Exception:
            pass

    print(json.dumps({"success": True, "path": out_path, "voice": voice, "provider": "edge-tts", "fallback": is_fallback}))

_whisper_models = {}

def whisper_model_name(requested: str = None) -> str:
    # "small" understands accented English and mixed ES/EN far better than "base"; "base" takes about
    # a third of the time on a CPU. CAPRI_WHISPER_MODEL (e.g. "medium", "large-v3-turbo") overrides both.
    explicit = os.environ.get("CAPRI_WHISPER_MODEL", "").strip() or (requested or "").strip()
    if explicit:
        return explicit
    if sys.platform == "darwin":
        try:
            with open(os.path.join(VOICE_DIR, "speech-recognition.json"), encoding="utf-8") as f:
                selected = json.load(f).get("model")
            if selected in ("base", "small"):
                return selected
        except (OSError, ValueError):
            pass
        return "base"
    return "small"

def mac_model_options() -> dict:
    # On a Mac the model is downloaded once from the settings, never in the middle of a sentence
    if sys.platform != "darwin":
        return {}
    return {"download_root": os.environ.get("CAPRI_WHISPER_DIR"), "local_files_only": os.environ.get("CAPRI_ALLOW_MODEL_DOWNLOAD") != "1"}

def get_whisper_model(requested: str = None):
    """Each model is loaded once and kept: switching between them in the settings is instant after that."""
    model_name = whisper_model_name(requested)
    if model_name not in _whisper_models:
        try:
            from faster_whisper import WhisperModel
            import ctranslate2  # ships with faster-whisper; avoids pulling in PyTorch just to detect the GPU
            if sys.platform == "darwin" or ctranslate2.get_cuda_device_count() == 0:
                _whisper_models[model_name] = cpu_whisper_model(model_name)
                return _whisper_models[model_name]
            model = WhisperModel(model_name, device="cuda", compute_type="float16")
            # The model loads fine without NVIDIA's libraries and only fails when it first works.
            # After that failure the same model hangs forever, so it's tried once, right here.
            import numpy
            model.detect_language(numpy.zeros(16000, dtype=numpy.float32))
            _whisper_models[model_name] = model
        except Exception as gpu_err:
            if sys.platform == "darwin":
                raise RuntimeError("Speech model unavailable. Open Mac settings and choose Set up voice recognition.") from gpu_err
            sys.stderr.write(f"[STT] Using the CPU: {gpu_err}\n")
            _whisper_models[model_name] = cpu_whisper_model(model_name)
    return _whisper_models[model_name]

def cpu_whisper_model(model_name: str = None):
    """Same model on the CPU: used when CUDA/cuBLAS is not available on this machine."""
    from faster_whisper import WhisperModel
    # Up to 8 threads: measured a bit quicker than the default on an 8-core laptop
    threads = min(8, os.cpu_count() or 4)
    return WhisperModel(whisper_model_name(model_name), device="cpu", compute_type="int8", cpu_threads=threads, **mac_model_options())

# Names Whisper would otherwise mishear. The prompt also pulls it towards its own language, so the
# Spanish and English phrases only go to those two.
WHISPER_NAMES = (
    "Capri, Cyberpunk 2077, Night City, ripperdoc, cyberware, choom, choomba, netrunner, edgerunner, "
    "Vik Vector, Arasaka, Militech, NCPD, Afterlife, MaxTac, ShadowPlay, Nvidia, F8, League of Legends, Spotify."
)
WHISPER_PHRASES = {
    "en": " Nearest ripperdoc, drop point, game mode, clip that, what should we do next? Recommend a gig, mark Lizzie's Bar, quickhack, cyberpsycho, tarot card, gank, jungle, can we beat that Garen?",
    "es": " Matasanos, clipea eso, clipealo, guardá el clip, ¿qué hacemos ahora? Recomendame un gig, marcá el bar de Lizzie.",
}


def whisper_prompt(language):
    return WHISPER_NAMES + WHISPER_PHRASES.get(language, "")


def choose_language(probs: dict, hint: str = None) -> str:
    """
    The language of the audio. With a clear winner, that one. In a close call accented English
    tends to come out as Spanish, so it's settled between the language she expects and English.
    """
    best = max(probs, key=probs.get)
    if probs[best] >= 0.7:
        return best
    expected = [c for c in (hint, "en") if c and probs.get(c, 0.0) >= 0.1]
    return max(expected, key=lambda c: probs[c]) if expected else best


def clean_cyberpunk_transcription(text: str) -> str:
    if not text:
        return text
    # Fix phonetically misheard Cyberpunk phrases from Whisper:
    # "newest repair dock", "nearest repair dock", "newest ripper dock", "repair dock", "reaper doc", "river doc"
    text = re.sub(r'\b(?:newest|nearest|new|near)\s+(?:repair|reaper|ripper|river)\s+(?:dock|doc|dog)s?\b', 'nearest ripperdoc', text, flags=re.IGNORECASE)
    text = re.sub(r'\b(?:repair|reaper|ripper|river)\s+(?:dock|doc|dog)s?\b', 'ripperdoc', text, flags=re.IGNORECASE)
    text = re.sub(r'\b(?:repairdoc|reaperdoc|ripperdock|reaperdock)\b', 'ripperdoc', text, flags=re.IGNORECASE)
    text = re.sub(r'\b(?:drop\s*box|dropbox)\b', 'drop point', text, flags=re.IGNORECASE)
    text = re.sub(r'\b(?:game\s*mod|game\s*mode|gamemode)\b', 'game mode', text, flags=re.IGNORECASE)
    text = re.sub(r'\b(?:cleap|clic|clipp?)\s+(?:that|dat|dis|this)\b', 'clip that', text, flags=re.IGNORECASE)
    text = re.sub(r'\b(?:clipe[aá]|clipeate)\s+(?:eso|esto)\b', 'clipea eso', text, flags=re.IGNORECASE)
    return text.strip()

def transcribe_audio_internal(input_file: str, language: str = None, hint: str = None, model_name: str = None) -> dict:
    temp_wav = input_file + ".16k.wav"
    try:
        # The always-on mic already sends 16kHz mono WAV: Whisper reads it as is, no FFmpeg process.
        # Anything else (webm/ogg from the recorder) is converted first
        with open(input_file, "rb") as fh:
            is_wav = fh.read(4) == b"RIFF"
        audio_file = input_file if is_wav else temp_wav
        if not is_wav:
            cmd = [FFMPEG, "-y", "-i", input_file, "-ar", "16000", "-ac", "1", temp_wav]
            try:
                subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
            except Exception as ffmpeg_err:
                # Whisper can read the recording by itself: FFmpeg only makes it a bit faster
                sys.stderr.write(f"[STT] FFmpeg failed, reading the recording directly: {ffmpeg_err}\n")
                audio_file = input_file

        model = get_whisper_model(model_name)
        lang_arg = None
        if language and language != "auto":
            lang_arg = language.split("-")[0].lower()
            lang_arg = {"spanish": "es", "english": "en"}.get(lang_arg, lang_arg)

        if not lang_arg:
            try:
                from faster_whisper.audio import decode_audio
                _lang, _prob, all_probs = model.detect_language(decode_audio(audio_file, sampling_rate=16000))
                lang_arg = choose_language(dict(all_probs), hint)
            except Exception:
                lang_arg = None

        def run(m):
            segs, inf = m.transcribe(
                audio_file,
                language=lang_arg,
                initial_prompt="Hey Capri. Open Spotify. What is on my screen?" if sys.platform == "darwin" else whisper_prompt(lang_arg),
                beam_size=5,
                vad_filter=True,
                vad_parameters=dict(min_silence_duration_ms=250)
            )
            return " ".join([segment.text.strip() for segment in segs]).strip(), inf

        try:
            raw_text, info = run(model)
        except RuntimeError as cuda_err:
            # GPU detected but its CUDA libraries are missing: switch to the CPU for good
            if not re.search(r"cuda|cublas|cudnn", str(cuda_err), re.IGNORECASE):
                raise
            cpu_model = cpu_whisper_model(model_name)
            _whisper_models[whisper_model_name(model_name)] = cpu_model
            raw_text, info = run(cpu_model)
        full_text = raw_text.strip() if sys.platform == "darwin" else clean_cyberpunk_transcription(raw_text)

        if full_text:
            return {"success": True, "text": full_text, "language": info.language}
        else:
            return {"success": False, "error": "No speech detected"}
    except Exception as e:
        return {"success": False, "error": str(e)}
    finally:
        if os.path.exists(temp_wav):
            try:
                os.remove(temp_wav)
            except Exception:
                pass

def transcribe_audio(input_file: str, language: str = None):
    res = transcribe_audio_internal(input_file, language)
    print(json.dumps(res), flush=True)

def run_stt_worker(model_name: str = None):
    # Warm up the chosen Whisper model on launch
    try:
        get_whisper_model(model_name)
        print(json.dumps({"ready": True, "engine": "faster-whisper-local"}), flush=True)
    except Exception as e:
        print(json.dumps({"ready": False, "error": str(e)}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            req_id = req.get("id")
            file_path = req.get("file")
            lang = req.get("lang")
            if not file_path or not os.path.exists(file_path):
                out = {"success": False, "error": "File not found"}
                if req_id is not None:
                    out["id"] = req_id
                print(json.dumps(out), flush=True)
                continue
            res = transcribe_audio_internal(file_path, lang, req.get("hint"), req.get("model"))
            if req_id is not None:
                res["id"] = req_id
            print(json.dumps(res), flush=True)
        except Exception as e:
            err_out = {"success": False, "error": str(e)}
            if "req_id" in locals() and req_id is not None:
                err_out["id"] = req_id
            print(json.dumps(err_out), flush=True)

def run_tts_worker():
    """Keeps the voice model loaded and answers one json line per request."""
    import io
    import contextlib

    os.environ["CAPRI_TTS_WORKER"] = "1"
    if os.environ.get("CAPRI_ALLOW_MODEL_DOWNLOAD") != "1":
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    print(json.dumps({"ready": True, "engine": "tts-worker"}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            if req.get("op") == "design_reference":
                buf = io.StringIO()
                with contextlib.redirect_stdout(buf):
                    res = design_reference(req["text"], req.get("description", ""), req.get("lang") or "", req["out"])
            else:
                buf = io.StringIO()
                with contextlib.redirect_stdout(buf):
                    loop.run_until_complete(
                        synthesize_speech(req["text"], req["out"], req.get("lang"), not req.get("noCache", False), req.get("cfg"))
                    )
                lines = [l for l in buf.getvalue().splitlines() if l.strip().startswith("{")]
                res = json.loads(lines[-1]) if lines else {"success": False, "error": "No result"}
        except Exception as e:
            res = {"success": False, "error": str(e)}
        if req_id is not None:
            res["id"] = req_id
        if _qwen_state.get("device"):
            res["device"] = _qwen_state["device"]
        print(json.dumps(res), flush=True)


QWEN_PENDING_MARK = ".capri-download-pending"


def qwen_repo_dir(repo: str) -> str:
    from huggingface_hub import constants
    return os.path.join(constants.HF_HUB_CACHE, "models--" + repo.replace("/", "--"))


def qwen_snapshot_problem(snap: str) -> str:
    """Why a downloaded snapshot cannot be used, or an empty string when it looks complete."""
    if not os.path.isdir(snap):
        return "snapshot folder missing"
    blobs = os.path.join(os.path.dirname(os.path.dirname(snap)), "blobs")
    if os.path.isdir(blobs) and any(n.endswith(".incomplete") for n in os.listdir(blobs)):
        return "download unfinished"
    weights = 0
    for root, _dirs, files in os.walk(snap):
        for name in files:
            if not os.path.exists(os.path.join(root, name)):  # a link whose file never arrived
                return f"{name} is missing"
            if name.endswith((".safetensors", ".bin")):
                weights += 1
    if not os.path.exists(os.path.join(snap, "config.json")):
        return "config.json is missing"
    if not weights:
        return "no model weights"
    index = os.path.join(snap, "model.safetensors.index.json")
    if os.path.exists(index):
        try:
            with open(index, "r", encoding="utf-8") as f:
                shards = set(json.load(f).get("weight_map", {}).values())
        except Exception:
            return "weights index unreadable"
        for shard in shards:
            if not os.path.exists(os.path.join(snap, shard)):
                return f"{shard} is missing"
    return ""


def check_qwen(mode: str, size: str):
    """Offline: is this model fully on disk? Prints {"ready": bool, "reason": str}."""
    from huggingface_hub import snapshot_download

    mode = mode if mode in ("custom", "clone", "design") else "custom"
    size = "1.7B" if mode == "design" or size == "1.7B" else "0.6B"
    repo = QWEN_TTS_REPOS[(mode, size)]
    reason = ""
    if os.path.exists(os.path.join(qwen_repo_dir(repo), QWEN_PENDING_MARK)):
        reason = "download unfinished"
    else:
        try:
            snap = snapshot_download(repo, local_files_only=True)
            reason = qwen_snapshot_problem(snap)
        except Exception:
            reason = "not downloaded"
    print(json.dumps({"ready": not reason, "reason": reason, "mode": mode, "size": size}), flush=True)


def prepare_qwen(mode: str, size: str):
    from huggingface_hub import snapshot_download
    import qwen_tts  # noqa: F401
    import soundfile  # noqa: F401

    mode = mode if mode in ("custom", "clone", "design") else "custom"
    size = "1.7B" if mode == "design" or size == "1.7B" else "0.6B"
    repo = QWEN_TTS_REPOS[(mode, size)]
    # Left behind if the download stops half way, so the app knows the folder is not usable yet
    repo_dir = qwen_repo_dir(repo)
    os.makedirs(repo_dir, exist_ok=True)
    pending = os.path.join(repo_dir, QWEN_PENDING_MARK)
    with open(pending, "w", encoding="utf-8") as f:
        f.write("downloading")
    path = snapshot_download(repo)
    problem = qwen_snapshot_problem(path)
    if problem:
        raise RuntimeError(f"The Qwen3-TTS download is incomplete: {problem}")
    os.remove(pending)
    print(json.dumps({"ready": True, "mode": mode, "size": size, "path": path}), flush=True)


def main():
    parser = argparse.ArgumentParser(description="Capri Voice Engine")
    subparsers = parser.add_subparsers(dest="command")

    # TTS
    tts_parser = subparsers.add_parser("tts")
    tts_parser.add_argument("--text", required=True, help="Text to speak")
    tts_parser.add_argument("--out", required=True, help="Output audio file path")
    tts_parser.add_argument("--lang", default=None, help="Explicit language override (e.g. es, en, ja)")
    tts_parser.add_argument("--no-cache", action="store_true", help="Skip the disk cache, both the lookup and the write")

    # STT (one-shot)
    stt_parser = subparsers.add_parser("stt")
    stt_parser.add_argument("--file", required=True, help="Input recorded audio file")
    stt_parser.add_argument("--lang", default=None, help="Language code (e.g. es, en)")

    # STT Worker (persistent local process)
    worker_parser = subparsers.add_parser("stt-worker")
    worker_parser.add_argument("--model", default=None, help="Whisper model to load first (small, base)")
    subparsers.add_parser("prepare-whisper")

    subparsers.add_parser("tts-worker")
    qwen_parser = subparsers.add_parser("prepare-qwen")
    qwen_parser.add_argument("--size", default="0.6B", choices=["0.6B", "1.7B"])
    qwen_parser.add_argument("--mode", default="custom", choices=["custom", "clone", "design"])
    check_parser = subparsers.add_parser("check-qwen")
    check_parser.add_argument("--size", default="0.6B", choices=["0.6B", "1.7B"])
    check_parser.add_argument("--mode", default="custom", choices=["custom", "clone", "design"])

    args = parser.parse_args()

    if args.command == "tts":
        asyncio.run(synthesize_speech(args.text, args.out, getattr(args, 'lang', None), not args.no_cache))
    elif args.command == "stt":
        transcribe_audio(args.file, getattr(args, 'lang', None))
    elif args.command == "prepare-whisper":
        os.environ["CAPRI_ALLOW_MODEL_DOWNLOAD"] = "1"
        get_whisper_model()
        print(json.dumps({"ready": True}), flush=True)
    elif args.command == "tts-worker":
        run_tts_worker()
    elif args.command == "prepare-qwen":
        prepare_qwen(args.mode, args.size)
    elif args.command == "check-qwen":
        check_qwen(args.mode, args.size)
    elif args.command == "stt-worker":
        run_stt_worker(getattr(args, 'model', None))
    else:
        parser.print_help()

if __name__ == "__main__":
    main()
