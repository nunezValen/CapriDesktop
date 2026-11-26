import React, { useEffect, useState } from 'react'
import { Gauge } from 'lucide-react'
import { formatGb, type BudgetComponent, type GpuBudget, type QwenTtsSize, type TtsOption, type TtsProviderId } from '../../../shared/gpu-budget'
import { useT } from '../utils/useUiLang'

const SEGMENT: Record<BudgetComponent['id'], { bar: string; dot: string }> = {
  stt: { bar: 'bg-cyan-400', dot: 'bg-cyan-400' },
  llm: { bar: 'bg-fuchsia-500', dot: 'bg-fuchsia-500' },
  tts: { bar: 'bg-yellow-400', dot: 'bg-yellow-400' }
}

const NOTE_KEY = {
  cloud: 'gpu_noteCloud',
  noGpu: 'gpu_noteCpu',
  whisper: 'gpu_noteWhisper',
  ollama: 'gpu_noteOllama',
  ollamaRough: 'gpu_noteOllamaRough',
  qwen: 'gpu_noteQwen'
} as const

const TITLE_KEY = { stt: 'gpu_stt', llm: 'gpu_llm', tts: 'gpu_tts' } as const

interface Props {
  /** The voice being previewed, even if it is not saved yet */
  provider: TtsProviderId
  qwenSize: QwenTtsSize
  onPick?: (option: TtsOption) => void
}

export const GpuBudgetBar: React.FC<Props> = ({ provider, qwenSize, onPick }) => {
  const t = useT()
  const [budget, setBudget] = useState<GpuBudget | null>(null)

  useEffect(() => {
    let alive = true
    window.api.gpu
      .budget({ provider, qwenSize })
      .then((b) => alive && setBudget(b))
      .catch(() => alive && setBudget(null))
    return () => {
      alive = false
    }
  }, [provider, qwenSize])

  if (!budget) return null
  const { gpu, components, usedBytes, reserveBytes, freeBytes, fits } = budget
  const total = gpu.totalBytes
  // Over capacity the bar grows so the overflow is visible
  const scale = Math.max(total ?? 0, usedBytes + reserveBytes) || 1
  const pct = (bytes: number): number => Math.max(0, (bytes / scale) * 100)

  const summary =
    gpu.kind === 'none'
      ? t('gpu_none')
      : total == null
        ? t('gpu_unknown')
        : fits
          ? t('gpu_fits', { used: formatGb(usedBytes + reserveBytes), total: formatGb(total), free: formatGb(freeBytes ?? 0) })
          : t('gpu_over', { used: formatGb(usedBytes + reserveBytes), total: formatGb(total), over: formatGb(-(freeBytes ?? 0)) })

  return (
    <div className="p-4 bg-black/50 border border-cp-500/30 rounded-none space-y-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-cp-300 font-bold flex items-center gap-1.5">
          <Gauge size={14} className="text-cp-400" />
          <span>{t('gpu_title')}</span>
        </span>
        {gpu.name && <span className="text-[12px] text-stone-400 truncate">{gpu.name}</span>}
      </div>

      <div
        className={`flex h-3.5 w-full overflow-hidden bg-stone-900 border ${fits === false ? 'border-red-500' : 'border-stone-700'}`}
        role="img"
        aria-label={summary}
      >
        {components.map((c) => c.onGpu && c.bytes > 0 && <div key={c.id} className={SEGMENT[c.id].bar} style={{ width: `${pct(c.bytes)}%` }} title={`${t(TITLE_KEY[c.id])}: ${formatGb(c.bytes)}`} />)}
        {reserveBytes > 0 && <div className="bg-stone-600" style={{ width: `${pct(reserveBytes)}%` }} title={`${t('gpu_system')}: ${formatGb(reserveBytes)}`} />}
      </div>

      <div className={`text-[13px] ${fits === false ? 'text-red-400' : 'text-stone-300'}`}>{summary}</div>

      <ul className="space-y-1">
        {components.map((c) => (
          <li key={c.id} className="flex items-baseline gap-2 text-[13px]">
            <span className={`inline-block w-2.5 h-2.5 shrink-0 ${SEGMENT[c.id].dot} ${c.onGpu ? '' : 'opacity-30'}`} />
            <span className="text-stone-300 font-semibold w-20 shrink-0">{t(TITLE_KEY[c.id])}</span>
            <span className="text-stone-200 truncate">{c.label}</span>
            <span className="ml-auto text-cp-300 font-bold cp-mono shrink-0">{c.onGpu ? `${c.rough ? '~' : ''}${formatGb(c.bytes)}` : '0 GB'}</span>
          </li>
        ))}
        {reserveBytes > 0 && (
          <li className="flex items-baseline gap-2 text-[13px] text-stone-500">
            <span className="inline-block w-2.5 h-2.5 shrink-0 bg-stone-600" />
            <span className="w-20 shrink-0">{t('gpu_system')}</span>
            <span className="ml-auto cp-mono">{formatGb(reserveBytes)}</span>
          </li>
        )}
      </ul>

      <ul className="space-y-0.5 text-[12px] text-stone-500">
        {components.map((c) => (
          <li key={c.id}>
            {t(TITLE_KEY[c.id])}: {t(NOTE_KEY[c.note])}
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap gap-1.5 pt-1">
        {budget.ttsOptions.map((o) => {
          const active = o.id === provider && (o.id !== 'qwen3-tts' || o.size === qwenSize)
          return (
            <button
              key={`${o.id}-${o.size ?? ''}`}
              type="button"
              onClick={() => onPick?.(o)}
              className={`px-2 py-1 text-[12px] border cursor-pointer transition-colors ${active ? 'border-yellow-400 bg-yellow-500/15 text-white' : 'border-stone-800 bg-black/60 text-stone-400 hover:border-stone-600 hover:text-stone-200'}`}
            >
              {o.label} · <span className="cp-mono">{o.onGpu ? formatGb(o.bytes) : o.id === 'qwen3-tts' ? 'CPU' : '0 GB'}</span>
            </button>
          )
        })}
      </div>
      <p className="text-[11px] text-stone-500">{t('gpu_help')}</p>
    </div>
  )
}
