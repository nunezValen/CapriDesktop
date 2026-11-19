/**
 * Works out how much GPU memory STT, the LLM and the voice would use.
 * It never runs any of them and only asks Ollama if it is already running.
 */

import { execFile } from 'child_process'
import * as os from 'os'
import {
  BudgetComponent,
  DEFAULT_LLM_CONTEXT,
  GpuBudget,
  GpuInfo,
  QwenTtsSize,
  TtsOption,
  TtsProviderId,
  budgetTotals,
  contextFromParameters,
  llmBytes,
  paramsFromName,
  qwenTtsBytes,
  roughLlmBytes,
  shapeFromModelInfo,
  sttRunsOnGpu,
  ttsRunsOnGpu,
  whisperBytes
} from '../../shared/gpu-budget'
import { effectiveQwenSize, normalizeQwenConfig } from '../../shared/qwen-tts'
import { consciousnessService } from './consciousness-service'
import { getLocalModel, isCloudMode } from './llm-gateway'
import { isMac, isWindows } from './platform'
import { voiceService } from './voice-service'

const GB = 1024 ** 3

function exec(cmd: string, args: string[], timeout = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout }, (err, stdout) => resolve(err ? null : String(stdout)))
  })
}

/** Reads the registry memory value which can be a number or a list of bytes */
export function parseRegistryMemory(raw: string | undefined): number {
  const parts = String(raw ?? '').trim().split(/\s+/).filter(Boolean).map(Number)
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return 0
  if (parts.length === 1) return parts[0]
  return parts.reduce((sum, byte, i) => sum + byte * 256 ** i, 0)
}

let gpuCache: { at: number; info: GpuInfo } | null = null

export async function detectGpu(): Promise<GpuInfo> {
  if (gpuCache && Date.now() - gpuCache.at < 60_000) return gpuCache.info
  const info = await detectGpuUncached()
  gpuCache = { at: Date.now(), info }
  return info
}

async function detectGpuUncached(): Promise<GpuInfo> {
  if (isMac && process.arch === 'arm64') {
    // Apple GPUs share RAM and macOS lets them use about two thirds, or three quarters on big machines
    const total = os.totalmem()
    return { kind: 'apple', name: 'Apple Silicon (unified memory)', totalBytes: Math.round(total * (total > 36 * GB ? 0.75 : 0.667)), unified: true }
  }

  const smi = await exec('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'])
  if (smi) {
    const gpus = smi
      .split(/\r?\n/)
      .map((l) => l.split(',').map((s) => s.trim()))
      .filter((p) => p.length >= 2 && Number.isFinite(Number(p[1])))
      .map((p) => ({ name: p[0], bytes: Number(p[1]) * 1024 ** 2 }))
    // Uses the first GPU, the same one CUDA calls 0
    if (gpus.length) return { kind: 'nvidia', name: gpus[0].name, totalBytes: gpus[0].bytes, unified: false }
  }

  if (isWindows) {
    // AdapterRAM caps at 4 GB so the registry value is used instead
    const script =
      "Get-ItemProperty 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -ErrorAction SilentlyContinue | " +
      "Where-Object { $_.DriverDesc } | ForEach-Object { $_.DriverDesc + '|' + $_.'HardwareInformation.qwMemorySize' } "
    const out = await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], 8000)
    const best = (out || '')
      .split(/\r?\n/)
      .map((l) => l.split('|'))
      .filter((p) => p.length === 2 && p[0].trim())
      .map((p) => ({ name: p[0].trim(), bytes: parseRegistryMemory(p[1]) }))
      .sort((a, b) => b.bytes - a.bytes)[0]
    if (best) return { kind: /nvidia|geforce|quadro/i.test(best.name) ? 'nvidia' : 'amd-intel', name: best.name, totalBytes: best.bytes > 0 ? best.bytes : null, unified: false }
  }

  return { kind: 'none', name: '', totalBytes: null, unified: false }
}

interface LlmEstimate {
  label: string
  bytes: number
  rough: boolean
}

async function estimateLlm(): Promise<LlmEstimate | null> {
  const name = getLocalModel()
  try {
    const tags = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(1500) })
    if (tags.ok) {
      const list = ((await tags.json()) as { models?: { name: string; size?: number }[] }).models || []
      const entry = list.find((m) => m.name === name || m.name === `${name}:latest`)
      if (entry?.size) {
        const show = await fetch('http://127.0.0.1:11434/api/show', {
          method: 'POST',
          body: JSON.stringify({ model: entry.name }),
          signal: AbortSignal.timeout(3000)
        })
        if (show.ok) {
          const data = (await show.json()) as { model_info?: Record<string, unknown>; parameters?: string }
          const context = contextFromParameters(data.parameters) ?? DEFAULT_LLM_CONTEXT
          const shape = shapeFromModelInfo(data.model_info || {}, entry.size, context)
          if (shape) return { label: entry.name, bytes: llmBytes(shape), rough: false }
        }
        // Only the file size is known so a typical cache is added on top
        return { label: entry.name, bytes: entry.size + 0.5 * GB, rough: true }
      }
    }
  } catch {
  }
  const billions = paramsFromName(name) ?? (name === 'capri' ? 7 : null)
  return billions ? { label: name, bytes: roughLlmBytes(billions), rough: true } : null
}

const TTS_LABELS: Record<TtsProviderId, string> = {
  'edge-tts': 'Edge-TTS',
  elevenlabs: 'ElevenLabs',
  'fish-audio': 'Fish Audio',
  'qwen3-tts': 'Qwen3-TTS'
}

function ttsOptions(gpu: GpuInfo): TtsOption[] {
  const options: TtsOption[] = (['edge-tts', 'elevenlabs', 'fish-audio'] as TtsProviderId[]).map((id) => ({ id, label: TTS_LABELS[id], bytes: 0, onGpu: false }))
  for (const size of ['0.6B', '1.7B'] as QwenTtsSize[]) {
    options.push({ id: 'qwen3-tts', size, label: `Qwen3-TTS ${size}`, bytes: ttsRunsOnGpu('qwen3-tts', gpu) ? qwenTtsBytes(size) : 0, onGpu: ttsRunsOnGpu('qwen3-tts', gpu) })
  }
  return options
}

export interface BudgetPreview {
  provider?: TtsProviderId
  qwenSize?: QwenTtsSize
}

export async function computeGpuBudget(preview: BudgetPreview = {}): Promise<GpuBudget> {
  const gpu = await detectGpu()
  const components: BudgetComponent[] = []

  const engine = consciousnessService.getLanguageSettings().sttEngine || 'whisper-small'
  if (engine === 'cloud') {
    components.push({ id: 'stt', label: 'Cloud', bytes: 0, onGpu: false, note: 'cloud' })
  } else {
    const size = engine === 'whisper-base' ? 'base' : 'small'
    const onGpu = sttRunsOnGpu(gpu)
    components.push({ id: 'stt', label: `Whisper ${size}`, bytes: onGpu ? whisperBytes(size) : 0, onGpu, note: onGpu ? 'whisper' : 'noGpu' })
  }

  if (isCloudMode()) {
    components.push({ id: 'llm', label: 'Cloud', bytes: 0, onGpu: false, note: 'cloud' })
  } else {
    const llm = await estimateLlm()
    const onGpu = gpu.kind !== 'none'
    components.push(
      llm
        ? { id: 'llm', label: llm.label, bytes: onGpu ? llm.bytes : 0, onGpu, note: !onGpu ? 'noGpu' : llm.rough ? 'ollamaRough' : 'ollama', rough: llm.rough }
        : { id: 'llm', label: getLocalModel(), bytes: 0, onGpu: false, note: 'noGpu' }
    )
  }

  const cfg = voiceService.getConfig() || {}
  const provider = (preview.provider || String(cfg.provider || 'edge-tts').toLowerCase()) as TtsProviderId
  const size: QwenTtsSize = preview.qwenSize || effectiveQwenSize(normalizeQwenConfig(cfg.qwen3_tts))
  if (provider === 'qwen3-tts') {
    const onGpu = ttsRunsOnGpu(provider, gpu)
    components.push({ id: 'tts', label: `Qwen3-TTS ${size}`, bytes: onGpu ? qwenTtsBytes(size) : 0, onGpu, note: onGpu ? 'qwen' : 'noGpu' })
  } else {
    components.push({ id: 'tts', label: TTS_LABELS[provider] || String(provider), bytes: 0, onGpu: false, note: 'cloud' })
  }

  return { gpu, components, ...budgetTotals(gpu, components), ttsOptions: ttsOptions(gpu) }
}
