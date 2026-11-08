import React, { useEffect, useState } from 'react'
import { Download, FileInput, X } from 'lucide-react'
import type { ModelPullProgress } from '../../../main/services/ollama-service'
import { useT } from '../utils/useUiLang'

/** Local models that work well with her, for who doesn't know the names */
const SUGGESTED = ['gemma3:4b', 'gemma3:12b', 'llama3.2:3b', 'qwen3:8b', 'mistral:7b', 'phi4-mini']

interface ModelDownloadProps {
  /** Called when a download finishes, with the model's name */
  onDownloaded: (model: string) => void
}

/** Any model from the Ollama library, downloaded from here: Gemma, Llama, Qwen, Mistral... */
export const ModelDownload: React.FC<ModelDownloadProps> = ({ onDownloaded }) => {
  const t = useT()
  const [name, setName] = useState('')
  const [progress, setProgress] = useState<ModelPullProgress | null>(null)

  useEffect(
    () =>
      window.api.agent.onPullProgress((p) => {
        setProgress(p)
        if (p.state === 'done') onDownloaded(p.model)
      }),
    [onDownloaded]
  )

  const downloading = progress?.state === 'downloading'
  const start = () => {
    const model = name.trim()
    if (!model || downloading) return
    setProgress({ model, state: 'downloading' })
    void window.api.agent.pullModel(model)
  }

  return (
    <div className="space-y-1.5">
      <span className="cp-label block">{t('pull_title')}</span>
      <div className="flex gap-2">
        <div className="cp-frame flex-1">
          <input
            value={name}
            list="capri-model-suggestions"
            disabled={downloading}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && start()}
            placeholder="gemma3:4b"
            className="cp-input w-full px-3 py-1.5 text-[14px]"
          />
          <datalist id="capri-model-suggestions">
            {SUGGESTED.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </div>
        {downloading ? (
          <button type="button" onClick={() => void window.api.agent.cancelPullModel()} className="cp-frame cp-btn-ghost px-3 py-1.5 text-[13px] flex items-center gap-1">
            <X size={12} /> {t('cancel')}
          </button>
        ) : (
          <button type="button" onClick={start} disabled={!name.trim()} className="cp-frame cp-btn-ghost px-3 py-1.5 text-[13px] flex items-center gap-1 disabled:opacity-40">
            <Download size={12} /> {t('pull_start')}
          </button>
        )}
      </div>
      {progress && (
        <div className="space-y-1">
          {downloading && (
            <div className="h-1.5 bg-black/60 border border-[var(--cp-red-line)]">
              <div className="h-full bg-[var(--cp-cyan)] transition-all" style={{ width: `${progress.percent ?? 0}%` }} />
            </div>
          )}
          <p className={`text-[12px] ${progress.state === 'failed' ? 'text-amber-400' : 'text-[var(--cp-muted)]'}`}>
            {progress.state === 'downloading' && (progress.status === 'importing' || (progress.status && !progress.percent) ? t('pull_importing', { model: progress.model }) : t('pull_progress', { model: progress.model, n: progress.percent ?? 0 }))}
            {progress.state === 'done' && t('pull_done', { model: progress.model })}
            {progress.state === 'cancelled' && t('pull_cancelled')}
            {progress.state === 'failed' &&
              (progress.error === 'offline' ? t('pull_offline') : progress.error === 'invalid-name' ? t('pull_badName') : progress.error === 'missing-file' ? t('pull_missingFile') : `${t('pull_failed')} ${progress.error ?? ''}`)}
          </p>
        </div>
      )}
      <p className="text-[12px] text-[var(--cp-muted)]">{t('pull_hint')}</p>
      {/* A .gguf file already on this PC, added to Ollama as its own model */}
      <button
        type="button"
        disabled={downloading}
        onClick={() => void window.api.agent.importGgufModel()}
        className="flex items-center gap-1.5 text-[13px] text-[var(--cp-red)] hover:text-[var(--cp-red-hi)] cursor-pointer disabled:opacity-40"
      >
        <FileInput size={13} /> {t('pull_importGguf')}
      </button>
    </div>
  )
}
