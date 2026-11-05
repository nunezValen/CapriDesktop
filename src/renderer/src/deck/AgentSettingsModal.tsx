import React, { useEffect, useRef, useState } from 'react'
import { Cpu, RefreshCw, X } from 'lucide-react'
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
  const [provider, setProvider] = useState<'local' | 'cloud' | 'claude-code'>('local')
  const [modelInput, setModelInput] = useState(llmModel)
  const [isScanning, setIsScanning] = useState(false)
  const formRef = useRef<LlmProviderFormHandle>(null)

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

  const handleSave = async () => {
    if (!(await formRef.current?.save())) return
    if (provider === 'local' && modelInput) {
      setLlmConfig({ model: modelInput })
      await window.api.agent.setConfig({ model: modelInput })
    }
    onClose()
  }

  if (!isOpen) return null

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
