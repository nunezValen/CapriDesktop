import React, { useState, useEffect, useRef } from 'react'
import { MicPicker } from './MicPicker'
import { SoundSettings } from './SoundSettings'
import { BehaviorSettings } from './BehaviorSettings'
import { HotkeySettings } from './HotkeySettings'
import { voiceVolume } from '../utils/soundSettings'
import { useT } from '../utils/useUiLang'
import {
  X,
  Volume2,
  Sliders,
  Key,
  Play,
  Square,
  Check,
  RefreshCw,
  Eye,
  EyeOff,
  ExternalLink,
  Sparkles,
  Cpu,
  Layers,
  Radio
} from 'lucide-react'

export interface VoiceConfigData {
  provider: 'edge-tts' | 'elevenlabs' | 'fish-audio'
  active_voice: string
  voice_es: string
  voice_ja?: string
  pitch: string
  rate: string
  synth_preset: string
  elevenlabs?: {
    api_key: string
    voice_id: string
    model_id: string
    stability: number
    similarity_boost: number
  }
  fish_audio?: {
    api_key: string
    reference_id: string
    model?: string
    format: string
  }
}

const EDGE_VOICES_EN = [
  { id: 'en-US-AriaNeural', label: 'Aria (Capri Original - Expressive & Confident)' },
  { id: 'en-US-AnaNeural', label: 'Ana (Cute & Cartoon)' },
  { id: 'en-US-JennyNeural', label: 'Jenny (Warm & Friendly)' },
  { id: 'en-US-EmmaMultilingualNeural', label: 'Emma (Multilingual & Cheerful)' },
  { id: 'en-US-AvaMultilingualNeural', label: 'Ava (Conversational & Expressive)' },
  { id: 'en-GB-SoniaNeural', label: 'Sonia (British English - Pleasant)' },
  { id: 'en-US-MichelleNeural', label: 'Michelle (Smooth & Clear)' }
]

const EDGE_VOICES_ES = [
  { id: 'es-AR-ElenaNeural', label: 'Elena (Capri Original Argentina - Amigable)' },
  { id: 'es-MX-DaliaNeural', label: 'Dalia (México - Expresiva y Natural)' },
  { id: 'es-ES-ElviraNeural', label: 'Elvira (España - Positiva y Clara)' },
  { id: 'es-CO-SalomeNeural', label: 'Salomé (Colombia - Cálida)' },
  { id: 'es-CL-CatalinaNeural', label: 'Catalina (Chile - Amable)' },
  { id: 'es-US-PalomaNeural', label: 'Paloma (US Spanish - Dinámica)' }
]

const ELEVENLABS_POPULAR_VOICES = [
  { id: '21m00Tcm4TlvDq8ikWAM', label: 'Rachel (Calm, young female)' },
  { id: 'AZnzlk1XvdvUeBnXmlld', label: 'Domi (Strong, confident female)' },
  { id: 'EXAVITQu4vr4xnSDxMaL', label: 'Bella (Sweet, expressive female)' },
  { id: 'MF3mGyEYCl7XYWbV9V6O', label: 'Elli (Youthful, playful female)' },
  { id: 'XB0fDUnXU5powFXDhCwa', label: 'Charlotte (Seductive, soft female)' },
  { id: 'Xb7hH8MSUJpSbSDYk0k2', label: 'Alice (Clear, confident female)' }
]

interface VoiceSettingsModalProps {
  isOpen: boolean
  onClose: () => void
}

export const VoiceSettingsModal: React.FC<VoiceSettingsModalProps> = ({ isOpen, onClose }) => {
  const t = useT()
  const [musicPlatform, setMusicPlatform] = useState<'youtube_music' | 'spotify'>('spotify')
  const [provider, setProvider] = useState<'edge-tts' | 'elevenlabs' | 'fish-audio'>('edge-tts')

  // Edge-TTS State
  const [activeVoiceEn, setActiveVoiceEn] = useState('en-US-AriaNeural')
  const [activeVoiceEs, setActiveVoiceEs] = useState('es-AR-ElenaNeural')
  const [pitchHz, setPitchHz] = useState(32)
  const [ratePercent, setRatePercent] = useState(25)
  const [synthPreset, setSynthPreset] = useState('none')

  // ElevenLabs State
  const [elApiKey, setElApiKey] = useState('')
  const [elVoiceId, setElVoiceId] = useState('21m00Tcm4TlvDq8ikWAM')
  const [elModelId, setElModelId] = useState('eleven_multilingual_v2')
  const [elStability, setElStability] = useState(0.5)
  const [elSimilarity, setElSimilarity] = useState(0.75)
  const [showElKey, setShowElKey] = useState(false)

  // Fish Audio State
  const [fishApiKey, setFishApiKey] = useState('')
  const [fishRefId, setFishRefId] = useState('')
  const [fishModel, setFishModel] = useState('s2.1-pro-free')
  const [fishFormat, setFishFormat] = useState('mp3')
  const [showFishKey, setShowFishKey] = useState(false)

  // Test Voice & Status
  const [testPhrase, setTestPhrase] = useState('')
  const [isTesting, setIsTesting] = useState(false)
  const [isPlayingAudio, setIsPlayingAudio] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)

  const activeAudioRef = useRef<HTMLAudioElement | null>(null)

  // Load configuration on mount or open
  useEffect(() => {
    if (!isOpen) return

    window.api.companion.getMusicPlatform().then(setMusicPlatform).catch(() => {})

    if (window.api?.voice?.getConfig) {
      window.api.voice.getConfig().then((cfg) => {
        if (!cfg) return
        setProvider(cfg.provider || 'edge-tts')
        setActiveVoiceEn(cfg.active_voice || 'en-US-AriaNeural')
        setActiveVoiceEs(cfg.voice_es || 'es-AR-ElenaNeural')

        const parsedPitch = parseInt((cfg.pitch || '+32Hz').replace(/[^\d-]/g, ''), 10)
        setPitchHz(isNaN(parsedPitch) ? 32 : parsedPitch)

        const parsedRate = parseInt((cfg.rate || '+25%').replace(/[^\d-]/g, ''), 10)
        setRatePercent(isNaN(parsedRate) ? 25 : parsedRate)

        setSynthPreset(cfg.synth_preset || 'none')

        if (cfg.elevenlabs) {
          setElApiKey(cfg.elevenlabs.api_key || '')
          setElVoiceId(cfg.elevenlabs.voice_id || '21m00Tcm4TlvDq8ikWAM')
          setElModelId(cfg.elevenlabs.model_id || 'eleven_multilingual_v2')
          setElStability(cfg.elevenlabs.stability ?? 0.5)
          setElSimilarity(cfg.elevenlabs.similarity_boost ?? 0.75)
        }

        if (cfg.fish_audio) {
          setFishApiKey(cfg.fish_audio.api_key || '')
          setFishRefId(cfg.fish_audio.reference_id || '')
          setFishModel(cfg.fish_audio.model || 's2.1-pro-free')
          setFishFormat(cfg.fish_audio.format || 'mp3')
        }
      })
    }
  }, [isOpen])

  // Stop active test audio when modal closes
  useEffect(() => {
    if (!isOpen && activeAudioRef.current) {
      activeAudioRef.current.pause()
      activeAudioRef.current = null
      setIsPlayingAudio(false)
    }
  }, [isOpen])

  const buildConfigPayload = (): VoiceConfigData => {
    return {
      provider,
      active_voice: activeVoiceEn,
      voice_es: activeVoiceEs,
      pitch: `${pitchHz >= 0 ? '+' : ''}${pitchHz}Hz`,
      rate: `${ratePercent >= 0 ? '+' : ''}${ratePercent}%`,
      synth_preset: synthPreset,
      elevenlabs: {
        api_key: elApiKey.trim(),
        voice_id: elVoiceId.trim() || '21m00Tcm4TlvDq8ikWAM',
        model_id: elModelId,
        stability: elStability,
        similarity_boost: elSimilarity
      },
      fish_audio: {
        api_key: fishApiKey.trim(),
        reference_id: fishRefId.trim(),
        model: fishModel.trim() || 's2.1-pro-free',
        format: fishFormat
      }
    }
  }

  const handleSave = async () => {
    if (!window.api?.voice?.setConfig) return

    const payload = buildConfigPayload()
    setStatusMessage(t('vs_stSaving'))
    try {
      const res = await window.api.voice.setConfig(payload)
      if (res.success) {
        await window.api.companion.setMusicPlatform(musicPlatform)
        setSaveSuccess(true)
        setStatusMessage(t('vs_stSaved'))
        setTimeout(() => setSaveSuccess(false), 2500)
      } else {
        setStatusMessage(t('vs_stSaveError', { error: res.error || '' }))
      }
    } catch (err: any) {
      setStatusMessage(t('vs_stSaveError', { error: err.message }))
    }
  }

  const handleTestVoice = async () => {
    if (isPlayingAudio && activeAudioRef.current) {
      activeAudioRef.current.pause()
      activeAudioRef.current = null
      setIsPlayingAudio(false)
      return
    }

    // Save temporary config first so synthesizer uses current settings
    if (window.api?.voice?.setConfig) {
      await window.api.voice.setConfig(buildConfigPayload())
    }

    setIsTesting(true)
    setStatusMessage(t('vs_stTesting'))

    try {
      const res = await window.api.voice.synthesize(testPhrase || t('vs_testPhrase'))
      if (res.success && res.audioDataUrl) {
        setStatusMessage(t('vs_stPlaying'))
        const audio = new Audio(res.audioDataUrl)
        audio.volume = voiceVolume()
        activeAudioRef.current = audio
        setIsPlayingAudio(true)

        audio.onended = () => {
          setIsPlayingAudio(false)
          activeAudioRef.current = null
          setStatusMessage(t('vs_stDone'))
        }

        audio.onerror = () => {
          setIsPlayingAudio(false)
          activeAudioRef.current = null
          setStatusMessage(t('vs_stPlayError'))
        }

        await audio.play()
      } else {
        setStatusMessage(t('vs_stSynthError', { error: res.error || '' }))
      }
    } catch (err: any) {
      setStatusMessage(t('vs_stSynthError', { error: err.message }))
    } finally {
      setIsTesting(false)
    }
  }

  const handleResetDefaults = () => {
    setProvider('edge-tts')
    setActiveVoiceEn('en-US-AriaNeural')
    setActiveVoiceEs('es-AR-ElenaNeural')
    setPitchHz(28)
    setRatePercent(25)
    setSynthPreset('none')
    setStatusMessage(t('vs_stReset'))
  }

  if (!isOpen) return null

  return (
    <div className="cp-vars fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-4 select-none text-[14px]">
      {/* Outer Cyber Frame */}
      <div className="cp-frame w-full max-w-2xl flex flex-col overflow-hidden animate-fade-in" style={{ ['--c' as string]: '14px' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 bg-black/90 border-b border-[#ff5f57]/30">
          <div className="flex items-center gap-2.5 text-[#ff5f57] font-bold tracking-wider">
            <Volume2 size={18} className="text-[#ff5f57] animate-pulse" />
            <span className="cp-title text-[18px]">{t('vs_title')}</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-stone-400 hover:text-white hover:bg-white/10 rounded-none transition-colors"
            title={t('close')}
          >
            <X size={18} />
          </button>
        </div>

        {/* Modal Content */}
        <div className="p-5 space-y-5 max-h-[78vh] overflow-y-auto">
          <MicPicker />
          <SoundSettings />
          <HotkeySettings />
          <BehaviorSettings />
          <label className="block space-y-2">
            <span className="text-stone-300 font-bold tracking-wide">{t('music_platformTitle')}</span>
            <select
              value={musicPlatform}
              onChange={(e) => setMusicPlatform(e.target.value as 'youtube_music' | 'spotify')}
              className="cp-input w-full px-3 py-2 text-[15px] cursor-pointer"
              style={{ colorScheme: 'dark' }}
            >
              <option value="spotify">Spotify</option>
              <option value="youtube_music">YouTube Music</option>
            </select>
            <span className="block text-[13px] text-stone-400">{t('music_platformHelp')}</span>
          </label>

          {/* Provider Tabs */}
          <div>
            <label className="text-stone-300 font-bold tracking-wide block mb-2 flex items-center gap-2">
              <Layers size={14} className="text-cp-400" />
              <span>{t('vs_engine')}</span>
            </label>

            <div className="grid grid-cols-3 gap-2.5">
              {/* Edge-TTS Tab */}
              <button
                type="button"
                onClick={() => setProvider('edge-tts')}
                className={`p-3 rounded-none border flex flex-col items-center justify-center text-center transition-all cursor-pointer ${
                  provider === 'edge-tts'
                    ? 'bg-[#ff5f57]/15 border-[#ff5f57] text-white'
                    : 'bg-black/60 border-stone-800 text-stone-400 hover:border-stone-600 hover:text-stone-200'
                }`}
              >
                <div className="flex items-center gap-1.5 font-bold mb-1">
                  <Radio size={14} className={provider === 'edge-tts' ? 'text-[#ff5f57]' : 'text-stone-500'} />
                  <span>Edge-TTS</span>
                </div>
                <span className="text-[12px] text-stone-400">{t('vs_edgeDesc')}</span>
              </button>

              {/* ElevenLabs Tab */}
              <button
                type="button"
                onClick={() => setProvider('elevenlabs')}
                className={`p-3 rounded-none border flex flex-col items-center justify-center text-center transition-all cursor-pointer ${
                  provider === 'elevenlabs'
                    ? 'bg-cp-500/15 border-cp-500 text-white'
                    : 'bg-black/60 border-stone-800 text-stone-400 hover:border-stone-600 hover:text-stone-200'
                }`}
              >
                <div className="flex items-center gap-1.5 font-bold mb-1">
                  <Sparkles size={14} className={provider === 'elevenlabs' ? 'text-cp-400' : 'text-stone-500'} />
                  <span>ElevenLabs API</span>
                </div>
                <span className="text-[12px] text-stone-400">{t('vs_elevenDesc')}</span>
              </button>

              {/* Fish Audio Tab */}
              <button
                type="button"
                onClick={() => setProvider('fish-audio')}
                className={`p-3 rounded-none border flex flex-col items-center justify-center text-center transition-all cursor-pointer ${
                  provider === 'fish-audio'
                    ? 'bg-yellow-500/15 border-yellow-500 text-white'
                    : 'bg-black/60 border-stone-800 text-stone-400 hover:border-stone-600 hover:text-stone-200'
                }`}
              >
                <div className="flex items-center gap-1.5 font-bold mb-1">
                  <Cpu size={14} className={provider === 'fish-audio' ? 'text-yellow-400' : 'text-stone-500'} />
                  <span>Fish Audio API</span>
                </div>
                <span className="text-[12px] text-stone-400">{t('vs_fishDesc')}</span>
              </button>
            </div>
          </div>

          {/* Provider Specific Settings */}
          {provider === 'edge-tts' && (
            <div className="space-y-4 p-4 bg-black/50 border border-cp-500/30 rounded-none">
              <div className="flex items-center justify-between text-cp-300 font-bold border-b border-cp-500/20 pb-2">
                <span>{t('vs_edgeConfig')}</span>
                <span className="text-[12px] text-stone-400">{t('vs_edgeNote')}</span>
              </div>

              {/* English Voice Selector */}
              <div>
                <label className="text-stone-300 block mb-1 font-semibold">{t('vs_voiceEn')}</label>
                <select
                  value={activeVoiceEn}
                  onChange={(e) => setActiveVoiceEn(e.target.value)}
                  className="w-full bg-[#1f0e0e] border border-cp-500/40 rounded-none px-3 py-2 text-white outline-none focus:border-[#ff5f57]"
                >
                  {EDGE_VOICES_EN.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label} ({v.id})
                    </option>
                  ))}
                </select>
              </div>

              {/* Spanish Voice Selector */}
              <div>
                <label className="text-stone-300 block mb-1 font-semibold">{t('vs_voiceEs')}</label>
                <select
                  value={activeVoiceEs}
                  onChange={(e) => setActiveVoiceEs(e.target.value)}
                  className="w-full bg-[#1f0e0e] border border-cp-500/40 rounded-none px-3 py-2 text-white outline-none focus:border-[#ff5f57]"
                >
                  {EDGE_VOICES_ES.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label} ({v.id})
                    </option>
                  ))}
                </select>
              </div>

              {/* Rate Slider */}
              <div className="bg-black/60 p-3 rounded-none border border-stone-800">
                <div className="flex justify-between items-center mb-1.5">
                  <span className="text-stone-300 font-semibold text-[14px]">{t('vs_speed')}</span>
                  <span className="px-2 py-0.5 rounded-none bg-cp-950 text-cp-300 font-bold text-[14px] border border-cp-500/40">
                    {ratePercent >= 0 ? `+${ratePercent}%` : `${ratePercent}%`}
                  </span>
                </div>
                <input
                  type="range"
                  min="-20"
                  max="50"
                  step="5"
                  value={ratePercent}
                  onChange={(e) => setRatePercent(parseInt(e.target.value, 10))}
                  className="w-full accent-cp-400 cursor-pointer"
                />
                <div className="flex justify-between text-[11px] text-stone-500 mt-1">
                  <span>{t('vs_slow')}</span>
                  <span>{t('vs_capriSpeed')}</span>
                  <span>{t('vs_fast')}</span>
                </div>
              </div>
            </div>
          )}

          {provider === 'elevenlabs' && (
            <div className="space-y-4 p-4 bg-black/50 border border-cp-500/30 rounded-none">
              <div className="flex items-center justify-between text-cp-300 font-bold border-b border-cp-500/20 pb-2">
                <span>{t('vs_elevenConfig')}</span>
                <a
                  href="https://elevenlabs.io"
                  target="_blank"
                  rel="noreferrer"
                  className="text-[12px] text-cp-400 hover:text-cp-300 flex items-center gap-1 underline"
                >
                  <span>{t('vs_getKey')}</span>
                  <ExternalLink size={10} />
                </a>
              </div>

              {/* API Key Input */}
              <div>
                <label className="text-stone-300 block mb-1 font-semibold flex items-center gap-1.5">
                  <Key size={13} className="text-cp-400" />
                  <span>ElevenLabs API Key:</span>
                </label>
                <div className="relative">
                  <input
                    type={showElKey ? 'text' : 'password'}
                    placeholder="xi-api-key..."
                    value={elApiKey}
                    onChange={(e) => setElApiKey(e.target.value)}
                    className="w-full bg-[#1f0e0e] border border-cp-500/40 rounded-none px-3 py-2 pr-10 text-white outline-none focus:border-cp-500 placeholder:text-stone-600"
                  />
                  <button
                    type="button"
                    onClick={() => setShowElKey(!showElKey)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-stone-400 hover:text-white"
                  >
                    {showElKey ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </div>

              {/* Voice ID Selection & Input */}
              <div>
                <label className="text-stone-300 block mb-1 font-semibold">{t('vs_voiceId')}</label>
                <div className="space-y-1.5">
                  <select
                    value={elVoiceId}
                    onChange={(e) => setElVoiceId(e.target.value)}
                    className="w-full bg-[#1f0e0e] border border-cp-500/40 rounded-none px-3 py-2 text-white outline-none focus:border-cp-500"
                  >
                    {ELEVENLABS_POPULAR_VOICES.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label} ({v.id})
                      </option>
                    ))}
                    <option value={elVoiceId}>ID Personalizada: {elVoiceId}</option>
                  </select>

                  <input
                    type="text"
                    placeholder={t('vs_voiceIdPlaceholder')}
                    value={elVoiceId}
                    onChange={(e) => setElVoiceId(e.target.value)}
                    className="w-full bg-[#1f0e0e]/60 border border-stone-800 rounded-none px-3 py-1.5 text-stone-300 outline-none focus:border-cp-500 text-[13px]"
                  />
                </div>
              </div>

              {/* Model Selection */}
              <div>
                <label className="text-stone-300 block mb-1 font-semibold">{t('vs_synthModel')}</label>
                <select
                  value={elModelId}
                  onChange={(e) => setElModelId(e.target.value)}
                  className="w-full bg-[#1f0e0e] border border-cp-500/40 rounded-none px-3 py-2 text-white outline-none focus:border-cp-500"
                >
                  <option value="eleven_multilingual_v2">eleven_multilingual_v2 ({t('vs_mExpressive')})</option>
                  <option value="eleven_turbo_v2_5">eleven_turbo_v2_5 ({t('vs_mLatency')})</option>
                  <option value="eleven_flash_v2_5">eleven_flash_v2_5 ({t('vs_mFast')})</option>
                </select>
              </div>

              {/* Stability & Similarity */}
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-black/60 p-3 rounded-none border border-stone-800">
                  <div className="flex justify-between items-center mb-1.5">
                    <span className="text-stone-300 font-semibold">{t('vs_stability')}</span>
                    <span className="text-cp-400 font-bold">{Math.round(elStability * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={elStability}
                    onChange={(e) => setElStability(parseFloat(e.target.value))}
                    className="w-full accent-cp-500 cursor-pointer"
                  />
                </div>

                <div className="bg-black/60 p-3 rounded-none border border-stone-800">
                  <div className="flex justify-between items-center mb-1.5">
                    <span className="text-stone-300 font-semibold">{t('vs_clarity')}</span>
                    <span className="text-cp-400 font-bold">{Math.round(elSimilarity * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={elSimilarity}
                    onChange={(e) => setElSimilarity(parseFloat(e.target.value))}
                    className="w-full accent-cp-500 cursor-pointer"
                  />
                </div>
              </div>
            </div>
          )}

          {provider === 'fish-audio' && (
            <div className="space-y-4 p-4 bg-black/50 border border-yellow-500/30 rounded-none">
              <div className="flex items-center justify-between text-yellow-300 font-bold border-b border-yellow-500/20 pb-2">
                <span className="flex items-center gap-1.5">
                  <Cpu size={14} className="text-yellow-400" />
                  <span>{t('vs_fishConfig')}</span>
                </span>
                <a
                  href="https://fish.audio"
                  target="_blank"
                  rel="noreferrer"
                  className="text-[12px] text-yellow-400 hover:text-yellow-300 flex items-center gap-1 underline"
                >
                  <span>{t('vs_getKey')} (fish.audio)</span>
                  <ExternalLink size={10} />
                </a>
              </div>

              {/* Fish API Key */}
              <div>
                <label className="text-stone-300 block mb-1 font-semibold flex items-center gap-1.5">
                  <Key size={13} className="text-yellow-400" />
                  <span>Fish Audio API Key:</span>
                </label>
                <div className="relative">
                  <input
                    type={showFishKey ? 'text' : 'password'}
                    placeholder="Bearer fish audio key..."
                    value={fishApiKey}
                    onChange={(e) => setFishApiKey(e.target.value)}
                    className="w-full bg-[#1f0e0e] border border-yellow-500/40 rounded-none px-3 py-2 pr-10 text-white outline-none focus:border-yellow-500 placeholder:text-stone-600"
                  />
                  <button
                    type="button"
                    onClick={() => setShowFishKey(!showFishKey)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-stone-400 hover:text-white"
                  >
                    {showFishKey ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
                <span className="text-[12px] text-stone-500 mt-1 block">
                  Seguridad: La API Key se almacena localmente de forma segura y nunca se comparte en Git.
                </span>
              </div>

              {/* Reference ID (Voice model ID) */}
              <div>
                <label className="text-stone-300 block mb-1 font-semibold">{t('vs_refId')}</label>
                <input
                  type="text"
                  placeholder={t('vs_refIdPlaceholder')}
                  value={fishRefId}
                  onChange={(e) => setFishRefId(e.target.value)}
                  className="w-full bg-[#1f0e0e] border border-yellow-500/40 rounded-none px-3 py-2 text-white outline-none focus:border-yellow-500 placeholder:text-stone-600 cp-mono"
                />
                <span className="text-[12px] text-stone-500 mt-1 block">
                  {t('vs_fishHelp')}
                </span>
              </div>

              {/* Model Selection */}
              <div>
                <label className="text-stone-300 block mb-1 font-semibold">{t('vs_voiceModel')}</label>
                <select
                  value={fishModel}
                  onChange={(e) => setFishModel(e.target.value)}
                  className="w-full bg-[#1f0e0e] border border-yellow-500/40 rounded-none px-3 py-2 text-white outline-none focus:border-yellow-500"
                >
                  <option value="s2.1-pro-free">s2.1-pro-free ({t('vs_recommended')})</option>
                  <option value="s2.1-pro">s2.1-pro (Premium)</option>
                </select>
              </div>

              {/* Emotion Tags Info Box */}
              <div className="p-3 bg-yellow-950/20 border border-yellow-500/20 rounded-none text-[13px] text-yellow-200/90 space-y-1">
                <span className="font-bold flex items-center gap-1 text-yellow-400">
                  <Sparkles size={12} />
                  <span>{t('vs_emotions')}</span>
                </span>
                <p className="text-stone-400">
                  {t('vs_emotionHelp')}
                </p>
                <div className="flex flex-wrap gap-1 mt-1 text-[12px]">
                  <span className="px-1.5 py-0.5 rounded-none bg-black/60 border border-yellow-500/40 text-yellow-300 cp-mono">[excited]</span>
                  <span className="px-1.5 py-0.5 rounded-none bg-black/60 border border-yellow-500/40 text-yellow-300 cp-mono">[giggles]</span>
                  <span className="px-1.5 py-0.5 rounded-none bg-black/60 border border-yellow-500/40 text-yellow-300 cp-mono">[playful]</span>
                  <span className="px-1.5 py-0.5 rounded-none bg-black/60 border border-yellow-500/40 text-yellow-300 cp-mono">[whispering]</span>
                  <span className="px-1.5 py-0.5 rounded-none bg-black/60 border border-yellow-500/40 text-yellow-300 cp-mono">[pause]</span>
                  <span className="px-1.5 py-0.5 rounded-none bg-black/60 border border-yellow-500/40 text-yellow-300 cp-mono">[reading aloud]</span>
                  <span className="px-1.5 py-0.5 rounded-none bg-black/60 border border-yellow-500/40 text-yellow-300 cp-mono">[cheerful]</span>
                </div>
              </div>

              {/* Format */}
              <div>
                <label className="text-stone-300 block mb-1 font-semibold">{t('vs_audioFormat')}</label>
                <select
                  value={fishFormat}
                  onChange={(e) => setFishFormat(e.target.value)}
                  className="w-full bg-[#1f0e0e] border border-yellow-500/40 rounded-none px-3 py-2 text-white outline-none focus:border-yellow-500"
                >
                  <option value="mp3">mp3 ({t('vs_recommended')})</option>
                  <option value="wav">wav ({t('vs_fmtWav')})</option>
                  <option value="opus">opus ({t('vs_fmtOpus')})</option>
                </select>
              </div>
            </div>
          )}

          {/* Cyberpunk Robotic dsp Audio Filter & Pitch Shift (Shared across providers) */}
          <div className="p-4 bg-[#130808] border border-cp-500/30 rounded-none space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-cp-300 font-bold flex items-center gap-1.5">
                <Sliders size={13} className="text-cp-400" />
                <span>{t('vs_dsp')}</span>
              </label>
              <span className="text-[12px] text-stone-400">{t('vs_dspSub')}</span>
            </div>
            <select
              value={synthPreset}
              onChange={(e) => setSynthPreset(e.target.value)}
              className="w-full bg-[#1f0e0e] border border-cp-500/40 rounded-none px-3 py-2 text-white outline-none focus:border-[#ff5f57]"
            >
              <option value="cyber_android">cyber_android ({t('vs_dspAndroid')})</option>
              <option value="aguda_cyber">aguda_cyber ({t('vs_dspAguda')})</option>
              <option value="none">none ({t('vs_dspNone')})</option>
              <option value="synth_hologram">synth_hologram ({t('vs_dspHolo')})</option>
              <option value="robot_vocoder">robot_vocoder ({t('vs_dspRobot')})</option>
              <option value="glitch_mech">glitch_mech ({t('vs_dspGlitch')})</option>
            </select>

            {/* Pitch / Agudeza Slider */}
            <div className="bg-black/60 p-3 rounded-none border border-stone-800">
              <div className="flex justify-between items-center mb-1.5">
                <span className="text-stone-300 font-semibold text-[14px]">{t('vs_pitch')}</span>
                <span className="px-2 py-0.5 rounded-none bg-cp-950 text-cp-300 font-bold text-[14px] border border-cp-500/40">
                  {pitchHz >= 0 ? `+${pitchHz}Hz` : `${pitchHz}Hz`}
                </span>
              </div>
              <input
                type="range"
                min="-20"
                max="50"
                step="2"
                value={pitchHz}
                onChange={(e) => setPitchHz(parseInt(e.target.value, 10))}
                className="w-full accent-cp-400 cursor-pointer"
              />
              <div className="flex justify-between text-[11px] text-stone-500 mt-1">
                <span>{t('vs_low')}</span>
                <span>{t('vs_normal')}</span>
                <span>{t('vs_capriPitch')}</span>
                <span>{t('vs_extra')}</span>
              </div>
            </div>
          </div>

          {/* Test Voice Section */}
          <div className="p-4 bg-cp-950/20 border border-cp-500/30 rounded-none space-y-2.5">
            <label className="text-cp-300 font-bold block flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <Volume2 size={14} className="text-cp-400" />
                <span>{t('vs_testLive')}</span>
              </span>
              <span className="text-[12px] text-stone-400 font-normal">{t('vs_testSub')}</span>
            </label>

            <div className="flex gap-2">
              <input
                type="text"
                value={testPhrase}
                onChange={(e) => setTestPhrase(e.target.value)}
                className="flex-1 bg-black/70 border border-cp-500/40 rounded-none px-3 py-2 text-white outline-none focus:border-[#ff5f57]"
                placeholder={t('vs_testPhrase')}
              />
              <button
                type="button"
                onClick={handleTestVoice}
                disabled={isTesting}
                className={`px-4 py-2 rounded-none font-bold flex items-center gap-2 transition-all cursor-pointer ${
                  isPlayingAudio
                    ? 'bg-yellow-500 hover:bg-yellow-400 text-black'
                    : isTesting
                    ? 'bg-stone-700 text-stone-400 cursor-not-allowed'
                    : 'bg-[#ff5f57] hover:bg-cp-300 text-black'
                }`}
              >
                {isTesting ? (
                  <>
                    <RefreshCw size={14} className="animate-spin" />
                    <span>{t('vs_generating')}</span>
                  </>
                ) : isPlayingAudio ? (
                  <>
                    <Square size={14} className="fill-current" />
                    <span>{t('vs_stop')}</span>
                  </>
                ) : (
                  <>
                    <Play size={14} className="fill-current" />
                    <span>{t('vs_testVoice')}</span>
                  </>
                )}
              </button>
            </div>

            {statusMessage && (
              <div className="text-[13px] text-cp-200 bg-black/60 px-2.5 py-1.5 rounded-none border border-cp-500/20">
                {statusMessage}
              </div>
            )}
          </div>
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-between px-5 py-3.5 bg-black/90 border-t border-[#ff5f57]/30">
          <button
            type="button"
            onClick={handleResetDefaults}
            className="text-stone-400 hover:text-stone-200 underline text-[13px] transition-colors"
          >
            {t('vs_restore')}
          </button>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-1.5 rounded-none border border-stone-700 hover:border-stone-500 text-stone-300 transition-colors"
            >
              {t('close')}
            </button>

            <button
              type="button"
              onClick={handleSave}
              className={`px-5 py-1.5 rounded-none font-bold flex items-center gap-1.5 transition-all cursor-pointer ${
                saveSuccess
                  ? 'bg-cp-500 text-black'
                  : 'bg-[#ff5f57] hover:bg-cp-300 text-black'
              }`}
            >
              {saveSuccess ? <Check size={14} /> : <Sliders size={14} />}
              <span>{saveSuccess ? t('vs_savedShort') : t('vs_save')}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
