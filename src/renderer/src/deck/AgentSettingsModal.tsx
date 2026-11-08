import React, { useEffect, useRef, useState } from 'react'
import { Cpu, RefreshCw, RotateCcw, X } from 'lucide-react'
import { LlmProviderForm, LlmProviderFormHandle } from '../components/LlmProviderForm'
import { useAgentStore } from '../stores/useAgentStore'
import { useT } from '../utils/useUiLang'
import { MemorySettings } from './MemorySettings'
import { ModelDownload } from './ModelDownload'
import type { SystemPromptPayload } from '../../../main/ipc/channels'

interface AgentSettingsModalProps {
  isOpen: boolean
  onClose: () => void
}

/** Who does Capri's thinking: the local Ollama or a cloud API */
export const AgentSettingsModal: React.FC<AgentSettingsModalProps> = ({ isOpen, onClose }) => {
  const t = useT()
  const { llmModel, ollamaRunning, ollamaModels, setLlmConfig, setOllamaStatus } = useAgentStore()
  const [provider, setProvider] = useState<'local' | 'cloud'>('local')
  // On this PC: Ollama, or LM Studio for .gguf models
  const [engine, setEngine] = useState<'ollama' | 'lmstudio'>('ollama')
  const [modelInput, setModelInput] = useState(llmModel)
  const [isScanning, setIsScanning] = useState(false)
  const formRef = useRef<LlmProviderFormHandle>(null)
  // System prompt editor states, `savedPrompt` is what is stored now, `promptText` is what is being edited.
  const [promptText, setPromptText] = useState('')
  const [savedPrompt, setSavedPrompt] = useState('')
  const [defaultPrompt, setDefaultPrompt] = useState('')
  const [promptLoaded, setPromptLoaded] = useState(false)
  // Simple presets for who doesn't want to write a prompt, saved as soon as they change
  const [tone, setTone] = useState<SystemPromptPayload['tone']>('default')
  const [teasing, setTeasing] = useState<SystemPromptPayload['teasing']>('default')
  // How she calls the user, saved on its own button
  const [userName, setUserName] = useState('')
  const [nameDraft, setNameDraft] = useState('')
  const [nameSaved, setNameSaved] = useState(false)
  const [saveError, setSaveError] = useState(false)
  // Regenerating asks for a second click, since it throws away a prompt of her own
  const [confirmReset, setConfirmReset] = useState(false)
  const [resetDone, setResetDone] = useState(false)

  const scan = async () => {
    setIsScanning(true)
    try {
      const res = await window.api.agent.detectOllama()
      setOllamaStatus(res)
    } finally {
      setIsScanning(false)
    }
  }

  useEffect(() => {
    if (isOpen) void scan()
  }, [isOpen])

  // Load the current system prompt every time the window opens
  useEffect(() => {
    if (!isOpen) return
    setNameSaved(false)
    window.api.companion
      .getUserProfile()
      .then((profile) => {
        const current = profile.hasName ? profile.name : ''
        setUserName(current)
        setNameDraft(current)
      })
      .catch(() => {})
    setPromptLoaded(false)
    setSaveError(false)
    setConfirmReset(false)
    setResetDone(false)
    window.api.agent
      .getSystemPrompt()
      .then((info) => {
        setPromptText(info.prompt)
        setSavedPrompt(info.prompt)
        setDefaultPrompt(info.defaultPrompt)
        setTone(info.tone)
        setTeasing(info.teasing)
        setPromptLoaded(true)
      })
      .catch(() => setPromptLoaded(false))
  }, [isOpen])

  const handleSave = async () => {
    if (!(await formRef.current?.save())) return
    setSaveError(false)
    try {
      // The system prompt is saved only if it was loaded and changed (applies from the next message)
      if (promptLoaded && promptText !== savedPrompt) await window.api.agent.setSystemPrompt(promptText)
      if (provider === 'local' && engine === 'ollama' && modelInput) {
        setLlmConfig({ model: modelInput })
        await window.api.agent.setConfig({ model: modelInput })
      }
      onClose()
    } catch (error) {
      // The window stays open so nothing written is lost
      console.error('[AgentSettings] Could not save:', error)
      setSaveError(true)
    }
  }

  useEffect(() => {
    if (!confirmReset) return
    const timer = setTimeout(() => setConfirmReset(false), 4000)
    return () => clearTimeout(timer)
  }, [confirmReset])

  useEffect(() => {
    if (!resetDone) return
    const timer = setTimeout(() => setResetDone(false), 3000)
    return () => clearTimeout(timer)
  }, [resetDone])

  /** Puts the built-in prompt back and saves it right away */
  const regenerateDefault = async () => {
    if (!confirmReset) return setConfirmReset(true)
    setConfirmReset(false)
    try {
      const info = await window.api.agent.resetSystemPrompt()
      setPromptText(info.prompt)
      setSavedPrompt(info.prompt)
      setDefaultPrompt(info.defaultPrompt)
      setSaveError(false)
      setResetDone(true)
    } catch (error) {
      console.error('[AgentSettings] Could not restore the default prompt:', error)
      setSaveError(true)
    }
  }

  const saveName = async () => {
    const clean = nameDraft.trim()
    if (!clean || clean === userName) return
    const saved = await window.api.companion.setUserName(clean)
    setUserName(saved)
    setNameDraft(saved)
    setNameSaved(true)
  }

  if (!isOpen) return null

  // True when the text in the box is not the built-in prompt
  const promptIsCustom = promptLoaded && promptText.trim() !== defaultPrompt.trim()

  const localModels = (ollamaModels || []).filter((m) => !/llava|vision|-vl\b/i.test(m))

  return (
    <div className="cp-vars fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-4 select-none">
      <div className="cp-frame w-full max-w-xl flex flex-col max-h-[90vh] animate-fade-in" style={{ ['--c' as string]: '14px' }}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[var(--cp-red-line)] shrink-0">
          <span className="cp-title text-[18px] text-[var(--cp-red)]">{t('llm_title')}</span>
          <button onClick={onClose} className="text-[var(--cp-muted)] hover:text-[var(--cp-red-hi)] cursor-pointer" title={t('close')}>
            <X size={16} />
          </button>
        </div>

        <div className="cp-scroll p-5 space-y-4 overflow-y-auto">
          <LlmProviderForm
            ref={formRef}
            onProviderChange={(next, nextEngine) => {
              setProvider(next)
              setEngine(nextEngine ?? 'ollama')
            }}
          />

          {provider === 'local' && engine === 'ollama' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-[14px]">
                <span className={`flex items-center gap-2 ${ollamaRunning ? 'text-[var(--cp-cyan)]' : 'text-[var(--cp-yellow)]'}`}>
                  <Cpu size={14} />
                  {ollamaRunning ? t('llm_localOn', { n: ollamaModels.length }) : t('llm_localOff')}
                </span>
                <button onClick={scan} disabled={isScanning} className="flex items-center gap-1 text-[13px] text-[var(--cp-red)] hover:text-[var(--cp-red-hi)] cursor-pointer disabled:opacity-40">
                  <RefreshCw size={12} className={isScanning ? 'animate-spin' : ''} /> {t('llm_scan')}
                </button>
              </div>
              {localModels.length > 0 && (
                <label className="block">
                  <span className="cp-label block mb-1.5">{t('llm_localModel')}</span>
                  <div className="cp-frame">
                    <select
                      value={modelInput}
                      onChange={(e) => setModelInput(e.target.value)}
                      className="cp-input w-full px-3 py-2 text-[15px] cursor-pointer"
                      style={{ colorScheme: 'dark' }}
                    >
                      {Array.from(new Set([modelInput, ...localModels])).filter(Boolean).map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </div>
                </label>
              )}
              {/* Gemma, Llama, Qwen, Mistral... from the Ollama library: picked as soon as it arrives */}
              <ModelDownload
                onDownloaded={(model) => {
                  void scan()
                  setModelInput(model)
                }}
              />
            </div>
          )}

          {/* How she calls the user */}
          <div className="space-y-1">
            <span className="cp-label">{t('you_title')}</span>
            <div className="flex gap-2">
              <div className="cp-frame flex-1">
                <input
                  value={nameDraft}
                  maxLength={40}
                  onChange={(e) => {
                    setNameDraft(e.target.value)
                    setNameSaved(false)
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && void saveName()}
                  placeholder={t('you_placeholder')}
                  className="cp-input w-full px-3 py-1.5 text-[14px]"
                />
              </div>
              <button
                type="button"
                onClick={() => void saveName()}
                disabled={!nameDraft.trim() || nameDraft.trim() === userName}
                className="cp-frame cp-btn-ghost px-4 py-1.5 text-[13px] disabled:opacity-40"
              >
                {nameSaved ? t('you_saved') : t('you_save')}
              </button>
            </div>
            <p className="text-[12px] text-[var(--cp-muted)]">{t('you_hint')}</p>
          </div>

          {/* System prompt editor */}
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1">
                <span className="cp-label">{t('sp_tone')}</span>
                <div className="cp-frame">
                  <select
                    value={tone}
                    disabled={!promptLoaded}
                    onChange={async (e) => {
                      const value = e.target.value as SystemPromptPayload['tone']
                      setTone(value)
                      await window.api.agent.setPersonaStyle({ tone: value })
                    }}
                    className="cp-input w-full px-3 py-1.5 text-[13px] cursor-pointer"
                    style={{ colorScheme: 'dark' }}
                  >
                    {(['default', 'warm', 'calm', 'chaotic'] as const).map((v) => (
                      <option key={v} value={v}>
                        {t(`sp_tone_${v}`)}
                      </option>
                    ))}
                  </select>
                </div>
              </label>
              <label className="space-y-1">
                <span className="cp-label">{t('sp_teasing')}</span>
                <div className="cp-frame">
                  <select
                    value={teasing}
                    disabled={!promptLoaded}
                    onChange={async (e) => {
                      const value = e.target.value as SystemPromptPayload['teasing']
                      setTeasing(value)
                      await window.api.agent.setPersonaStyle({ teasing: value })
                    }}
                    className="cp-input w-full px-3 py-1.5 text-[13px] cursor-pointer"
                    style={{ colorScheme: 'dark' }}
                  >
                    {(['default', 'none', 'light', 'heavy'] as const).map((v) => (
                      <option key={v} value={v}>
                        {t(`sp_teasing_${v}`)}
                      </option>
                    ))}
                  </select>
                </div>
              </label>
            </div>
            <div className="flex items-center justify-between">
              <span className="cp-label">
                {t('sp_title')} <span className="text-[var(--cp-muted)]">({promptIsCustom ? t('sp_custom') : t('sp_default')})</span>
              </span>
              <button
                onClick={() => void regenerateDefault()}
                disabled={!promptLoaded || (!promptIsCustom && savedPrompt.trim() === defaultPrompt.trim())}
                className="flex items-center gap-1 text-[13px] text-[var(--cp-red)] hover:text-[var(--cp-red-hi)] cursor-pointer disabled:opacity-40"
              >
                <RotateCcw size={12} /> {confirmReset ? t('sp_resetConfirm') : resetDone ? t('sp_resetDone') : t('sp_reset')}
              </button>
            </div>
            <div className="cp-frame">
              <textarea
                maxLength={20000}
                value={promptText}
                onChange={(e) => setPromptText(e.target.value)}
                disabled={!promptLoaded}
                spellCheck={false}
                rows={12}
                className="cp-input w-full px-3 py-2 text-[13px] font-mono resize-y select-text"
                style={{ colorScheme: 'dark' }}
              />
            </div>
            <div className="flex justify-between gap-3 text-[12px] text-[var(--cp-muted)]">
              <span>
                {t('sp_hint')} {t('sp_fixedNote')}
              </span>
              <span className="shrink-0">{t('sp_chars', { n: promptText.length })}</span>
            </div>
          </div>

          {/* What she remembers about the user */}
          <MemorySettings isCloud={provider === 'cloud'} />
        </div>

        <div className="px-5 py-3.5 border-t border-[var(--cp-red-line)] flex justify-end gap-2 shrink-0">
          <button
            onClick={() => {
              void window.api.setup.open()
              onClose()
            }}
            className="cp-frame cp-btn-ghost px-4 py-2 text-[14px] mr-auto"
          >
            {t('llm_setupAgain')}
          </button>
          {saveError && <span className="self-center text-[13px] text-[var(--cp-red-hi)]">{t('sp_saveError')}</span>}
          <button onClick={onClose} className="cp-frame cp-btn-ghost px-4 py-2 text-[14px]">
            {t('cancel')}
          </button>
          <button onClick={handleSave} className="cp-btn px-6 py-2 text-[14px]">
            {t('llm_save')}
          </button>
        </div>
      </div>
    </div>
  )
}
