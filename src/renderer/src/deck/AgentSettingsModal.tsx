import React, { useEffect, useRef, useState } from 'react'
import { Cpu, RefreshCw, RotateCcw, X } from 'lucide-react' // RotateCcw added
import { LlmProviderForm, LlmProviderFormHandle } from '../components/LlmProviderForm'
import { useAgentStore } from '../stores/useAgentStore'
import { useT } from '../utils/useUiLang'

interface AgentSettingsModalProps {
  isOpen: boolean
  onClose: () => void
}

/** Who does Capri's thinking: the local Ollama or a cloud API */
export const AgentSettingsModal: React.FC<AgentSettingsModalProps> = ({ isOpen, onClose }) => {
  const t = useT()
  const { llmModel, ollamaRunning, ollamaModels, setLlmConfig, setOllamaStatus } = useAgentStore()
  const [provider, setProvider] = useState<'local' | 'cloud'>('local')
  const [modelInput, setModelInput] = useState(llmModel)
  const [isScanning, setIsScanning] = useState(false)
  const formRef = useRef<LlmProviderFormHandle>(null)
  // System prompt editor states, `savedPrompt` is what is stored now, `promptText` is what is being edited.
  const [promptText, setPromptText] = useState('')
  const [savedPrompt, setSavedPrompt] = useState('')
  const [defaultPrompt, setDefaultPrompt] = useState('')
  const [promptLoaded, setPromptLoaded] = useState(false)

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
    setPromptLoaded(false)
    window.api.agent
      .getSystemPrompt()
      .then((info) => {
        setPromptText(info.prompt)
        setSavedPrompt(info.prompt)
        setDefaultPrompt(info.defaultPrompt)
        setPromptLoaded(true)
      })
      .catch(() => setPromptLoaded(false))
  }, [isOpen])

  const handleSave = async () => {
    if (!(await formRef.current?.save())) return
 try {
    // Save the system prompt only if it was loaded and changed (applies from the next message)
    if (promptLoaded && promptText !== savedPrompt) await window.api.agent.setSystemPrompt(promptText)
    if (provider === 'local' && modelInput) {
      setLlmConfig({ model: modelInput })
      await window.api.agent.setConfig({ model: modelInput })
    }
    onClose()
  } catch (error) {
    console.error("Failed to save configuration:", error)
    
    // Keeps the modal open and gives the user explicit feedback
    alert("Failed to save changes. Please check file permissions and try again.")
  }
}

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
          <LlmProviderForm ref={formRef} onProviderChange={setProvider} />

          {provider === 'local' && (
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
            </div>
          )}

          {/* System prompt editor */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="cp-label">
                {t('sp_title')} <span className="text-[var(--cp-muted)]">({promptIsCustom ? t('sp_custom') : t('sp_default')})</span>
              </span>
              <button
                onClick={() => setPromptText(defaultPrompt)}
                disabled={!promptLoaded || !promptIsCustom}
                className="flex items-center gap-1 text-[13px] text-[var(--cp-red)] hover:text-[var(--cp-red-hi)] cursor-pointer disabled:opacity-40"
              >
                <RotateCcw size={12} /> {t('sp_reset')}
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
              <span>{t('sp_hint')}</span>
              <span className="shrink-0">{t('sp_chars', { n: promptText.length })}</span>
            </div>
          </div>
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
