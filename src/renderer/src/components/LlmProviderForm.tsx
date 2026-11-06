import type { CloudRequestStatus } from '../../../main/services/cloud-request-status'
import React, { forwardRef, useEffect, useImperativeHandle, useState } from 'react'
import { Check, Cloud, Cpu, Key, List, Loader2, Server, ShieldAlert, X } from 'lucide-react'
import { MessageKey } from '../i18n'
import { useT } from '../utils/useUiLang'

/** Any OpenAI-compatible server works: these only save the user from looking up the address */
const PRESETS: { id: string; label: string; baseUrl: string }[] = [
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { id: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1' },
  { id: 'google', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' },
  { id: 'mistral', label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1' },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  { id: 'xai', label: 'xAI', baseUrl: 'https://api.x.ai/v1' },
  { id: 'together', label: 'Together AI', baseUrl: 'https://api.together.xyz/v1' },
  { id: 'custom', label: '', baseUrl: '' }
]

const ERROR_KEYS: Record<string, MessageKey> = {
  auth: 'llm_errAuth',
  quota: 'llm_errQuota',
  model: 'llm_errModel',
  network: 'llm_errNetwork',
  insecure: 'llm_errInsecure',
  other: 'llm_errOther',
  'invalid-url': 'llm_errInvalidUrl',
  'missing-model': 'llm_errMissingModel',
  'no-encryption': 'llm_errNoEncryption'
}

export interface LlmProviderFormHandle {
  /** Validates and stores the choice; false if something needs fixing */
  save: () => Promise<boolean>
}

export const LlmProviderForm = forwardRef<LlmProviderFormHandle, { onProviderChange?: (provider: 'local' | 'cloud') => void }>(
  ({ onProviderChange }, ref) => {
    const t = useT()
    const [provider, setProvider] = useState<'local' | 'cloud'>('local')
    const [preset, setPreset] = useState('openai')
    const [baseUrl, setBaseUrl] = useState(PRESETS[0].baseUrl)
    const [model, setModel] = useState('')
    const [visionModel,setVisionModel]=useState('')
    const [apiKey, setApiKey] = useState('')
    const [hasKey, setHasKey] = useState(false)
    const [lastRequest,setLastRequest]=useState<CloudRequestStatus|null>(null)
    const [models, setModels] = useState<string[]>([])
    const [busy, setBusy] = useState<'models' | 'test' | null>(null)
    const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)

    useEffect(() => {
      window.api?.agent?.getLlmSettings?.().then((s) => {
        if (!s) return
        setProvider(s.provider)
        if (s.preset) setPreset(s.preset)
        if (s.baseUrl) setBaseUrl(s.baseUrl)
        setModel(s.model)
        setVisionModel(s.visionModel || '')
        setHasKey(s.hasKey)
        setLastRequest(s.lastRequest || null)
        onProviderChange?.(s.provider)
      })
    }, [])

    const choose = (next: 'local' | 'cloud') => {
      setProvider(next)
      setNotice(null)
      onProviderChange?.(next)
    }

    const choosePreset = (id: string) => {
      setPreset(id)
      setModels([])
      setNotice(null)
      const found = PRESETS.find((p) => p.id === id)
      if (found && id !== 'custom') setBaseUrl(found.baseUrl)
    }

    const fail = (code?: string) => setNotice({ ok: false, text: t(ERROR_KEYS[code || 'other'] || 'llm_errOther') })

    const loadModels = async () => {
      setBusy('models')
      setNotice(null)
      const res = await window.api.agent.listLlmModels(baseUrl, apiKey || undefined)
      setBusy(null)
      if (!res.ok) return fail(res.error)
      setModels(res.models)
      if (res.models.length === 0) setNotice({ ok: false, text: t('llm_noModels') })
    }

    const test = async () => {
      if (!model.trim()) return fail('missing-model')
      setBusy('test')
      setNotice(null)
      const res = await window.api.agent.testLlm(baseUrl, model.trim(), apiKey || undefined)
      setBusy(null)
      if (res.ok) setNotice({ ok: true, text: t('llm_testOk') })
      else fail(res.error)
    }

    const removeKey = async () => {
      const res = await window.api.agent.setLlmSettings({ apiKey: '' })
      if (res.success) setHasKey(false)
    }

    useImperativeHandle(ref, () => ({
      save: async () => {
        const res = await window.api.agent.setLlmSettings(
          provider === 'local'
            ? { provider: 'local' }
            : { provider: 'cloud', preset, baseUrl, model: model.trim(), visionModel:visionModel.trim(), apiKey: apiKey || undefined }
        )
        if (!res.success) {
          fail(res.error)
          return false
        }
        setHasKey(res.settings.hasKey)
        setApiKey('')
        return true
      }
    }))

    const field = 'cp-input w-full px-3 py-2 text-[15px] select-text'

    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2.5">
          {(
            [
              ['local', 'llm_local', 'llm_localDesc', <Cpu size={16} key="i" />],
              ['cloud', 'llm_cloud', 'llm_cloudDesc', <Cloud size={16} key="i" />]
            ] as const
          ).map(([id, title, desc, icon]) => {
            const active = provider === id
            return (
              <button
                key={id}
                type="button"
                onClick={() => choose(id)}
                className={`cp-frame cp-option cp-plain text-left px-3.5 py-3 cursor-pointer ${active ? 'is-active' : ''}`}
              >
                {active && <span className="cp-marker" />}
                <span className={`flex items-center gap-2 text-[15px] font-bold uppercase tracking-[0.06em] ${active ? 'text-[var(--cp-red-hi)]' : 'text-[var(--cp-red-dim)]'}`}>
                  {icon} {t(title)}
                </span>
                <span className="block mt-1.5 text-[13px] leading-snug text-[var(--cp-muted)]">{t(desc)}</span>
              </button>
            )
          })}
        </div>

        {provider === 'cloud' && (
          <div className="space-y-3">
            <label className="block">
              <span className="cp-label block mb-1.5">{t('llm_provider')}</span>
              <div className="cp-frame">
                <select value={preset} onChange={(e) => choosePreset(e.target.value)} className={`${field} cursor-pointer`} style={{ colorScheme: 'dark' }}>
                  {PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label || t('llm_custom')}
                    </option>
                  ))}
                </select>
              </div>
            </label>

            <label className="block">
              <span className="cp-label flex items-center gap-1.5 mb-1.5">
                <Server size={12} /> {t('llm_baseUrl')}
              </span>
              <div className="cp-frame">
                <input
                  value={baseUrl}
                  onChange={(e) => {
                    setBaseUrl(e.target.value)
                    setPreset('custom')
                  }}
                  spellCheck={false}
                  placeholder="https://..."
                  className={`${field} cp-mono`}
                />
              </div>
            </label>

            <label className="block">
              <span className="cp-label flex items-center justify-between mb-1.5">
                <span className="flex items-center gap-1.5">
                  <Key size={12} /> {t('llm_apiKey')}
                </span>
                {hasKey && (
                  <button type="button" onClick={removeKey} className="cp-plain text-[12px] text-[var(--cp-muted)] hover:text-[var(--cp-red)] underline cursor-pointer normal-case tracking-normal">
                    {t('llm_removeKey')}
                  </button>
                )}
              </span>
              <div className="cp-frame">
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={hasKey ? `•••••••• ${t('llm_apiKeySaved')}` : t('llm_apiKeyPlaceholder')}
                  className={`${field} cp-mono`}
                />
              </div>
            </label>

            <div className="block">
              <span className="cp-label block mb-1.5">{t('llm_model')}</span>
              <div className="flex gap-2">
                <div className="cp-frame flex-1 min-w-0">
                  <input
                    list="capri-llm-models"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    spellCheck={false}
                    placeholder={t('llm_modelPlaceholder')}
                    className={`${field} cp-mono`}
                  />
                  <datalist id="capri-llm-models">
                    {models.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                </div>
                <button type="button" onClick={loadModels} disabled={!!busy} className="cp-frame cp-btn-ghost flex items-center gap-1.5 px-3 text-[13px] shrink-0">
                  {busy === 'models' ? <Loader2 size={13} className="animate-spin" /> : <List size={13} />} {t('llm_loadModels')}
                </button>
              </div>
            </div>

            <label className="block text-sm">Vision model
              <input aria-label="Cloud vision model" className={`${field} cp-mono mt-1`} value={visionModel} onChange={e=>setVisionModel(e.target.value)} placeholder="Image-capable model ID" />
              <span className="block text-xs mt-1">Uses this cloud server and API key. Manual scans send the selected screen image. Live Scan and automatic screen comments send images only after you enable them. Chat keeps its own model.</span>
            </label>

            <div className="flex items-center gap-3">
              <button type="button" onClick={test} disabled={!!busy} className="cp-frame cp-btn-ghost flex items-center gap-1.5 px-3 py-2 text-[13px] shrink-0">
                {busy === 'test' ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} {busy === 'test' ? t('llm_testing') : t('llm_test')}
              </button>
              {notice && (
                <span className={`flex items-start gap-1.5 text-[14px] leading-snug ${notice.ok ? 'text-[var(--cp-cyan)]' : 'text-[var(--cp-yellow)]'}`}>
                  {notice.ok ? <Check size={14} className="mt-0.5 shrink-0" /> : <X size={14} className="mt-0.5 shrink-0" />} {notice.text}
                </span>
              )}
            </div>

            <div className="text-xs space-y-1 select-text" role="status">
              <p>{lastRequest ? `Last cloud request: ${lastRequest.host} · ${lastRequest.model} · ${lastRequest.state}${lastRequest.httpStatus ? ` · HTTP ${lastRequest.httpStatus}` : ''}${lastRequest.elapsedMs !== undefined ? ` · ${lastRequest.elapsedMs} ms` : ''} · ${new Date(lastRequest.startedAt).toLocaleTimeString()}` : 'No cloud request recorded yet.'}</p>
              <button type="button" className="cp-btn-ghost px-2 py-1" onClick={async()=>setLastRequest((await window.api.agent.getLlmSettings()).lastRequest || null)}>Refresh request status</button>
            </div>

            <div className="cp-frame is-warn flex gap-2 px-3 py-2.5 text-[13px] leading-snug text-[var(--cp-text)]">
              <ShieldAlert size={15} className="shrink-0 mt-0.5 text-[var(--cp-yellow)]" />
              <span>
                {t('llm_privacy')} {t('llm_voiceLocal')}
              </span>
            </div>
          </div>
        )}
      </div>
    )
  }
)
LlmProviderForm.displayName = 'LlmProviderForm'
