import React, { useCallback, useEffect, useState } from 'react'
import { Eye, HardDrive, Trash2 } from 'lucide-react'
import type { InstalledPart, LocalModelInfo } from '../../../main/services/installed-parts'
import { ModelDownload, RECOMMENDED_VISION_MODELS, VISION_MODEL_SUGGESTIONS } from './ModelDownload'
import { useT } from '../utils/useUiLang'

const size = (bytes: number): string => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`)

const PART_LABEL = { voiceEnv: 'parts_voiceEnv', whisper: 'parts_whisper', ffmpeg: 'parts_ffmpeg', qwen3tts: 'parts_qwen3tts' } as const

/**
 * Under the thinking models: the models that see (for the scanner and reading the screen), each
 * downloaded models' size with a button to delete it, and the parts of the setup that can be removed.
 */
export const LocalModelsPanel: React.FC<{ ollamaRunning: boolean; onModelsChanged: () => void }> = ({ ollamaRunning, onModelsChanged }) => {
  const t = useT()
  const [models, setModels] = useState<LocalModelInfo[]>([])
  const [vision, setVision] = useState('auto')
  const [parts, setParts] = useState<InstalledPart[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    setModels(await window.api.agent.listLocalModels().catch(() => []))
    setVision(await window.api.agent.getVisionModel().catch(() => 'auto'))
  }, [])

  useEffect(() => {
    void load()
    window.api.agent.listInstalledParts().then(setParts).catch(() => setParts([]))
  }, [load, ollamaRunning])

  const visionModels = models.filter((m) => m.vision)

  const removeModel = async (name: string) => {
    if (!window.confirm(t('models_deleteConfirm', { model: name }))) return
    setBusy(name)
    const next = await window.api.agent.deleteLocalModel(name).catch(() => null)
    setBusy(null)
    if (next) setModels(next)
    onModelsChanged()
  }

  const removePart = async (id: InstalledPart['id']) => {
    if (!window.confirm(t('parts_removeConfirm', { part: t(PART_LABEL[id]) }))) return
    setBusy(id)
    setParts(await window.api.agent.removeInstalledPart(id).catch(() => parts))
    setBusy(null)
  }

  return (
    <div className="space-y-4">
      {ollamaRunning && (
        <div className="space-y-3 pt-3 border-t border-[var(--cp-red-line)]">
          <span className="flex items-center gap-2 cp-label">
            <Eye size={13} /> {t('vision_title')}
          </span>
          <p className="text-[12px] text-[var(--cp-muted)]">{t('vision_hint')}</p>
          <label className="block">
            <span className="cp-label block mb-1.5">{t('vision_use')}</span>
            <div className="cp-frame">
              <select
                value={vision}
                onChange={async (e) => setVision(await window.api.agent.setVisionModel(e.target.value))}
                className="cp-input w-full px-3 py-2 text-[15px] cursor-pointer"
                style={{ colorScheme: 'dark' }}
              >
                <option value="auto">{t('vision_auto')}</option>
                {Array.from(new Set([...(vision !== 'auto' ? [vision] : []), ...visionModels.map((m) => m.name)])).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          </label>
          {visionModels.length === 0 && <p className="text-[12px] text-[var(--cp-yellow)]">{t('vision_none')}</p>}
          <ModelDownload
            listId="capri-vision-suggestions"
            suggestions={VISION_MODEL_SUGGESTIONS}
            quickPicks={RECOMMENDED_VISION_MODELS}
            installed={models.map((m) => m.name)}
            titleKey="vision_download"
            hintKey="vision_downloadHint"
            allowGguf={false}
            onDownloaded={(model) => {
              void load().then(() => window.api.agent.setVisionModel(model).then(setVision))
              onModelsChanged()
            }}
          />

          {models.length > 0 && (
            <div className="space-y-1">
              <span className="cp-label block">{t('models_installed')}</span>
              {models.map((m) => (
                <div key={m.name} className="flex items-center justify-between text-[13px] text-stone-300">
                  <span className="flex items-center gap-1.5 truncate">
                    {m.vision && <Eye size={12} className="text-[var(--cp-cyan)] shrink-0" />}
                    <span className="truncate">{m.name}</span>
                    <span className="text-[var(--cp-muted)] shrink-0">{size(m.bytes)}</span>
                  </span>
                  <button
                    type="button"
                    disabled={busy === m.name}
                    onClick={() => void removeModel(m.name)}
                    className="text-[var(--cp-muted)] hover:text-[var(--cp-red-hi)] cursor-pointer disabled:opacity-40 shrink-0"
                    title={t('models_delete')}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* What the first-run setup installed: removing it frees space, the setup puts it back */}
      {parts && parts.length > 0 && (
        <div className="space-y-1.5 pt-3 border-t border-[var(--cp-red-line)]">
          <span className="flex items-center gap-2 cp-label">
            <HardDrive size={13} /> {t('parts_title')}
          </span>
          <p className="text-[12px] text-[var(--cp-muted)]">{t('parts_hint')}</p>
          {parts.map((p) => (
            <div key={p.id} className="flex items-center justify-between text-[13px] text-stone-300">
              <span>
                {t(PART_LABEL[p.id])} <span className="text-[var(--cp-muted)]">{size(p.bytes)}</span>
              </span>
              <button
                type="button"
                disabled={busy === p.id}
                onClick={() => void removePart(p.id)}
                className="flex items-center gap-1 text-[12px] text-[var(--cp-muted)] hover:text-[var(--cp-red-hi)] cursor-pointer disabled:opacity-40"
              >
                <Trash2 size={12} /> {t('parts_remove')}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
