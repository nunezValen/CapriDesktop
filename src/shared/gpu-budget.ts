/**
 * All numbers here are estimates from model sizes and nothing is run to get them.
 */

const GB = 1024 ** 3

/** Every Python process that uses the GPU pays for its own CUDA context */
export const CUDA_CONTEXT_BYTES = 0.35 * GB
/** Memory the desktop keeps for itself on a discrete GPU */
export const SYSTEM_RESERVE_BYTES = 0.8 * GB
export const DEFAULT_LLM_CONTEXT = 4096

export type QwenTtsSize = '0.6B' | '1.7B'
export type TtsProviderId = 'edge-tts' | 'elevenlabs' | 'fish-audio' | 'qwen3-tts'

export type GpuKind = 'nvidia' | 'amd-intel' | 'apple' | 'none'

export interface GpuInfo {
  kind: GpuKind
  name: string
  /** Memory available to the models, null if it could not be read */
  totalBytes: number | null
  /** True on Apple Silicon where the GPU shares RAM with the system */
  unified: boolean
}

export type BudgetComponentId = 'stt' | 'llm' | 'tts'
export type BudgetNote = 'cloud' | 'noGpu' | 'whisper' | 'ollama' | 'ollamaRough' | 'qwen'

export interface BudgetComponent {
  id: BudgetComponentId
  label: string
  bytes: number
  /** False when it runs in the cloud or on the CPU so it uses no video memory */
  onGpu: boolean
  note: BudgetNote
  /** True when the size was guessed from the model name */
  rough?: boolean
}

export interface TtsOption {
  id: TtsProviderId
  size?: QwenTtsSize
  label: string
  bytes: number
  onGpu: boolean
}

export interface GpuBudget {
  gpu: GpuInfo
  components: BudgetComponent[]
  usedBytes: number
  reserveBytes: number
  freeBytes: number | null
  fits: boolean | null
  ttsOptions: TtsOption[]
}

const WHISPER_PARAMS: Record<string, number> = { small: 244e6, base: 74e6 }

/** fp16 weights plus 25 percent for beam search and activations plus the CUDA context */
export function whisperBytes(model: 'small' | 'base'): number {
  return WHISPER_PARAMS[model] * 2 * 1.25 + CUDA_CONTEXT_BYTES
}

/** Weights use the published checkpoint sizes and runtime covers the cache and activations for a short line */
const QWEN_TTS: Record<QwenTtsSize, { weights: number; runtime: number }> = {
  '0.6B': { weights: 2.52 * GB, runtime: 0.6 * GB },
  '1.7B': { weights: 4.54 * GB, runtime: 0.9 * GB }
}

export function qwenTtsBytes(size: QwenTtsSize): number {
  const m = QWEN_TTS[size]
  return m.weights + m.runtime + CUDA_CONTEXT_BYTES
}

export interface LlmShape {
  /** Size of the model file, which Ollama loads as it is */
  weightsBytes: number
  layers: number
  kvHeads: number
  headDim: number
  context: number
}

/** Weights plus the 16 bit K and V cache for every layer and token plus compute buffers */
export function llmBytes(shape: LlmShape): number {
  const kv = 2 * shape.layers * shape.context * shape.kvHeads * shape.headDim * 2
  return shape.weightsBytes + kv + 0.4 * GB
}

export function paramsFromName(name: string): number | null {
  const m = name.toLowerCase().match(/(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)\s?b(?![a-z])/)
  return m ? parseFloat(m[1]) : null
}

/** Guess for when the real numbers are missing, about 0.6 bytes per parameter plus a typical cache */
export function roughLlmBytes(billions: number, context = DEFAULT_LLM_CONTEXT): number {
  const weights = billions * 1e9 * 0.6
  const kv = billions * 35e6 * (context / 4096)
  return weights + kv + 0.4 * GB
}

/** Reads the model shape from the model_info that Ollama returns */
export function shapeFromModelInfo(info: Record<string, unknown>, weightsBytes: number, context: number): LlmShape | null {
  const num = (suffix: string): number | null => {
    for (const [k, v] of Object.entries(info)) if (k.endsWith(suffix) && typeof v === 'number') return v
    return null
  }
  const layers = num('.block_count')
  const heads = num('.attention.head_count')
  const kvHeads = num('.attention.head_count_kv') ?? heads
  const embedding = num('.embedding_length')
  const headDim = num('.attention.key_length') ?? (embedding && heads ? embedding / heads : null)
  if (!layers || !kvHeads || !headDim || !weightsBytes) return null
  return { weightsBytes, layers, kvHeads, headDim, context }
}

export function contextFromParameters(parameters: string | undefined): number | null {
  const m = (parameters || '').match(/^\s*num_ctx\s+(\d+)/m)
  return m ? parseInt(m[1], 10) : null
}

export function budgetTotals(gpu: GpuInfo, components: BudgetComponent[]): Pick<GpuBudget, 'usedBytes' | 'reserveBytes' | 'freeBytes' | 'fits'> {
  const usedBytes = components.filter((c) => c.onGpu).reduce((sum, c) => sum + c.bytes, 0)
  const reserveBytes = gpu.kind === 'none' || gpu.unified ? 0 : SYSTEM_RESERVE_BYTES
  if (gpu.totalBytes == null) return { usedBytes, reserveBytes, freeBytes: null, fits: null }
  const freeBytes = gpu.totalBytes - reserveBytes - usedBytes
  return { usedBytes, reserveBytes, freeBytes, fits: freeBytes >= 0 }
}

/** Only Qwen3-TTS uses the GPU, through CUDA or Apple MPS */
export function ttsRunsOnGpu(provider: TtsProviderId, gpu: GpuInfo): boolean {
  return provider === 'qwen3-tts' && (gpu.kind === 'nvidia' || gpu.kind === 'apple')
}

/** Whisper only uses CUDA and runs on the CPU everywhere else */
export function sttRunsOnGpu(gpu: GpuInfo): boolean {
  return gpu.kind === 'nvidia'
}

export function formatGb(bytes: number): string {
  const gb = bytes / GB
  return `${gb >= 10 ? gb.toFixed(0) : gb.toFixed(1)} GB`
}
