import React, { useEffect, useRef, useState } from 'react'
import { Cpu, Download, FileAudio, Mic, Play, RefreshCw, Sparkles, Square, Wand2 } from 'lucide-react'
import { QWEN_SPEAKERS, qwenDownloadSize, qwenModelFolder, type QwenMode, type QwenTtsConfig } from '../../../shared/qwen-tts'
import { useT } from '../utils/useUiLang'

interface Props {
  value: QwenTtsConfig
  onChange: (patch: Partial<QwenTtsConfig>) => void
  phrase: string
  onStatus: (message: string) => void
}

const MODES: { id: QwenMode; key: 'vs_qwenModeCustom' | 'vs_qwenModeClone' | 'vs_qwenModeDesign'; Icon: typeof Cpu }[] = [
  { id: 'custom', key: 'vs_qwenModeCustom', Icon: Mic },
  { id: 'clone', key: 'vs_qwenModeClone', Icon: FileAudio },
  { id: 'design', key: 'vs_qwenModeDesign', Icon: Wand2 }
]

const FIELD = 'w-full bg-[#1f0e0e] border border-cyan-500/40 rounded-none px-3 py-2 text-white outline-none focus:border-cyan-400 placeholder:text-stone-600 disabled:opacity-40'
const BUTTON = 'px-3 py-2 rounded-none font-bold flex items-center gap-2 text-[13px] cursor-pointer disabled:cursor-not-allowed disabled:opacity-40'

export const QwenTtsPanel: React.FC<Props> = ({ value, onChange, phrase, onStatus }) => {
  const t = useT()
  // Not installed until the check says so: the download button must stay reachable when it cannot answer
  const [installed, setInstalled] = useState(false)
  const [checking, setChecking] = useState(true)
  const [installing, setInstalling] = useState(false)
  const [installLog, setInstallLog] = useState('')
  const [playing, setPlaying] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const cancelRef = useRef(false)
  // Settles the promise of the sample being played: pause() fires neither "ended" nor "error"
  const playDoneRef = useRef<(() => void) | null>(null)
  const checkRef = useRef(0)
  // The check that ends an install must ask about what is selected now, not when it started
  const valueRef = useRef(value)
  valueRef.current = value

  const folder = qwenModelFolder(value)

  // Ready means the Python packages import and the whole model is on disk, not just that its folder exists
  const refreshInstalled = (): void => {
    const check = ++checkRef.current
    setChecking(true)
    window.api.setup
      .qwenStatus({ mode: valueRef.current.mode, model_size: valueRef.current.model_size })
      .then((status) => {
        if (check === checkRef.current) setInstalled(!!status.ready)
      })
      .catch(() => {
        if (check === checkRef.current) setInstalled(false)
      })
      .finally(() => {
        if (check === checkRef.current) setChecking(false)
      })
  }
  useEffect(refreshInstalled, [folder])

  const stopAudio = (): void => {
    audioRef.current?.pause()
    audioRef.current = null
    playDoneRef.current?.()
  }

  useEffect(
    () => () => {
      cancelRef.current = true
      checkRef.current++
      stopAudio()
    },
    []
  )

  const stop = (): void => {
    cancelRef.current = true
    stopAudio()
    setPlaying('')
  }

  const play = (url: string): Promise<void> =>
    new Promise((resolve) => {
      const audio = new Audio(url)
      audioRef.current = audio
      const done = (): void => {
        if (playDoneRef.current === done) playDoneRef.current = null
        resolve()
      }
      playDoneRef.current = done
      audio.onended = done
      audio.onerror = done
      audio.play().catch(done)
    })

  const speak = async (patch: Partial<QwenTtsConfig>, label: string): Promise<boolean> => {
    setPlaying(label)
    const res = await window.api.voice.previewQwen(phrase, { ...value, ...patch })
    if (cancelRef.current) return false
    if (!res.success || !res.audioDataUrl) {
      setError(t('vs_qwenFailed', { error: res.error || '' }))
      return false
    }
    setError('')
    await play(res.audioDataUrl)
    return !cancelRef.current
  }

  const preview = async (): Promise<void> => {
    cancelRef.current = false
    setBusy(true)
    await speak({}, t('vs_qwenPreviewing'))
    setPlaying('')
    setBusy(false)
  }

  const audition = async (): Promise<void> => {
    cancelRef.current = false
    setBusy(true)
    for (let i = 0; i < QWEN_SPEAKERS.length; i++) {
      const speaker = QWEN_SPEAKERS[i]
      const ok = await speak({ mode: 'custom', speaker: speaker.id }, t('vs_qwenAuditionNow', { name: speaker.id, n: i + 1, total: QWEN_SPEAKERS.length }))
      if (!ok) break
    }
    setPlaying('')
    setBusy(false)
  }

  const install = async (): Promise<void> => {
    if (installing) return
    // Installs what is selected here. Nothing is saved or switched to Qwen: that waits for Save
    setInstalling(true)
    setInstallLog('')
    const off = window.api.setup.onLog((entry) => {
      if (entry.step === 'qwen3tts') setInstallLog(entry.line.slice(0, 160))
    })
    try {
      const res = await window.api.setup.run('qwen3tts', { qwen: { mode: value.mode, model_size: value.model_size } })
      onStatus(res.ok ? t('vs_qwenInstalled') : t('vs_qwenInstallFail'))
    } catch {
      onStatus(t('vs_qwenInstallFail'))
    } finally {
      off()
      setInstalling(false)
      refreshInstalled()
    }
  }

  const pickAudio = async (): Promise<void> => {
    const picked = await window.api.voice.pickReference()
    if (picked) onChange({ clone_ref_audio: picked.path, clone_ref_text: '' })
  }

  const transcribe = async (): Promise<void> => {
    setBusy(true)
    setPlaying(t('vs_qwenTranscribing'))
    const res = await window.api.voice.transcribeReference(value.clone_ref_audio)
    if (res.success && res.text) onChange({ clone_ref_text: res.text.trim() })
    else setError(t('vs_qwenFailed', { error: res.error || '' }))
    setPlaying('')
    setBusy(false)
  }

  const keepDesign = async (): Promise<void> => {
    setBusy(true)
    setPlaying(t('vs_qwenPreviewing'))
    const res = await window.api.voice.designReference(phrase, value.design_description)
    if (res.success && res.path) {
      onChange({ mode: 'clone', clone_ref_audio: res.path, clone_ref_text: phrase, clone_xvector_only: false })
      onStatus(t('vs_qwenKept'))
    } else {
      setError(t('vs_qwenFailed', { error: res.error || '' }))
    }
    setPlaying('')
    setBusy(false)
  }

  const refName = value.clone_ref_audio ? value.clone_ref_audio.split(/[\\/]/).pop() : ''
  const canPreview = installed && !busy && (value.mode !== 'clone' || !!value.clone_ref_audio) && (value.mode !== 'design' || !!value.design_description.trim())

  const sizeSelect = (
    <div>
      <label className="text-stone-300 block mb-1 font-semibold">{t('vs_qwenModel')}</label>
      <select value={value.model_size} onChange={(e) => onChange({ model_size: e.target.value === '1.7B' ? '1.7B' : '0.6B' })} className={FIELD}>
        <option value="0.6B">{t('vs_qwenSize06')}</option>
        <option value="1.7B">{t('vs_qwenSize17')}</option>
      </select>
    </div>
  )

  const previewButton = (
    <button type="button" onClick={preview} disabled={!canPreview} className={`${BUTTON} bg-cyan-400 hover:bg-cyan-300 text-black`}>
      <Play size={14} />
      <span>{t('vs_qwenPreview')}</span>
    </button>
  )

  return (
    <div className="space-y-4 p-4 bg-black/50 border border-cyan-500/30 rounded-none">
      <div className="flex items-center justify-between text-cyan-300 font-bold border-b border-cyan-500/20 pb-2">
        <span className="flex items-center gap-1.5">
          <Cpu size={14} className="text-cyan-400" />
          <span>{t('vs_qwenConfig')}</span>
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {MODES.map(({ id, key, Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => onChange({ mode: id })}
            className={`p-2 border flex items-center justify-center gap-1.5 text-[13px] cursor-pointer ${value.mode === id ? 'bg-cyan-500/15 border-cyan-400 text-white' : 'bg-black/60 border-stone-800 text-stone-400 hover:border-stone-600'}`}
          >
            <Icon size={13} />
            <span>{t(key)}</span>
          </button>
        ))}
      </div>

      {value.mode === 'custom' && (
        <>
          {sizeSelect}
          <div>
            <label className="text-stone-300 block mb-1 font-semibold">{t('vs_qwenSpeaker')}</label>
            <div className="flex gap-2">
              <select value={value.speaker} onChange={(e) => onChange({ speaker: e.target.value })} className={FIELD}>
                {QWEN_SPEAKERS.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
              {previewButton}
            </div>
          </div>
          <button type="button" onClick={audition} disabled={!installed || busy} className={`${BUTTON} border border-cyan-500/50 text-cyan-300 hover:bg-cyan-500/10`}>
            <Sparkles size={14} />
            <span>{t('vs_qwenAudition')}</span>
          </button>
          <div>
            <label className="text-stone-300 block mb-1 font-semibold">{t('vs_qwenInstruct')}</label>
            <input type="text" disabled={value.model_size !== '1.7B'} placeholder={t('vs_qwenInstructPh')} value={value.instruct} onChange={(e) => onChange({ instruct: e.target.value })} className={FIELD} />
          </div>
        </>
      )}

      {value.mode === 'clone' && (
        <>
          {sizeSelect}
          <div className="flex items-center gap-2">
            <button type="button" onClick={pickAudio} disabled={busy} className={`${BUTTON} border border-cyan-500/50 text-cyan-300 hover:bg-cyan-500/10`}>
              <FileAudio size={14} />
              <span>{t('vs_qwenPickAudio')}</span>
            </button>
            <span className="text-[13px] text-stone-400 truncate">{refName || t('vs_qwenNoAudio')}</span>
          </div>
          <div>
            <label className="text-stone-300 block mb-1 font-semibold">{t('vs_qwenRefText')}</label>
            <textarea rows={2} value={value.clone_ref_text} placeholder={t('vs_qwenRefTextPh')} onChange={(e) => onChange({ clone_ref_text: e.target.value })} className={FIELD} />
            <button type="button" onClick={transcribe} disabled={!value.clone_ref_audio || busy} className={`${BUTTON} mt-2 border border-cyan-500/50 text-cyan-300 hover:bg-cyan-500/10`}>
              <Mic size={14} />
              <span>{t('vs_qwenTranscribe')}</span>
            </button>
          </div>
          <label className="flex items-center gap-2 text-[13px] text-stone-300 cursor-pointer">
            <input type="checkbox" checked={value.clone_xvector_only} onChange={(e) => onChange({ clone_xvector_only: e.target.checked })} />
            <span>{t('vs_qwenXvec')}</span>
          </label>
          <p className="text-[12px] text-stone-500">{t('vs_qwenCloneHelp')}</p>
          {previewButton}
        </>
      )}

      {value.mode === 'design' && (
        <>
          <p className="text-[12px] text-stone-500">{t('vs_qwenDesignNeeds')}</p>
          <div>
            <label className="text-stone-300 block mb-1 font-semibold">{t('vs_qwenDescribe')}</label>
            <textarea rows={3} value={value.design_description} placeholder={t('vs_qwenDescribePh')} onChange={(e) => onChange({ design_description: e.target.value })} className={FIELD} />
          </div>
          <div className="flex flex-wrap gap-2">
            {previewButton}
            <button type="button" onClick={keepDesign} disabled={!canPreview} className={`${BUTTON} border border-cyan-500/50 text-cyan-300 hover:bg-cyan-500/10`}>
              <Wand2 size={14} />
              <span>{t('vs_qwenKeep')}</span>
            </button>
          </div>
        </>
      )}

      {playing && (
        <div className="flex items-center gap-2 text-[13px] text-cyan-300">
          <span className="cp-mono">{playing}</span>
          <button type="button" onClick={stop} className="flex items-center gap-1 px-2 py-1 border border-stone-700 text-stone-300 hover:text-white cursor-pointer">
            <Square size={11} />
            <span>{t('vs_qwenStop')}</span>
          </button>
        </div>
      )}
      {error && <p className="text-[13px] text-red-400 break-words">{error}</p>}
      <p className="text-[13px] text-stone-400">{t('vs_qwenNote')}</p>

      {!installed && !checking && (
        <div className="space-y-1.5">
          <button type="button" onClick={install} disabled={installing} className={`${BUTTON} bg-cyan-400 hover:bg-cyan-300 text-black`}>
            {installing ? <RefreshCw size={14} className="animate-spin" /> : <Download size={14} />}
            <span>{installing ? t('vs_qwenInstalling') : t('vs_qwenInstall')}</span>
          </button>
          <span className="text-[12px] text-stone-500 block">{t('vs_qwenInstallHelp', { size: qwenDownloadSize(value) })}</span>
          {installLog && <span className="text-[12px] text-stone-400 block cp-mono truncate">{installLog}</span>}
        </div>
      )}
    </div>
  )
}
