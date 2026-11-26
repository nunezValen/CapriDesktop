import type { QwenTtsSize } from './gpu-budget'

export type QwenMode = 'custom' | 'clone' | 'design'

export interface QwenTtsConfig {
  mode: QwenMode
  model_size: QwenTtsSize
  speaker: string
  instruct: string
  clone_ref_audio: string
  clone_ref_text: string
  clone_xvector_only: boolean
  design_description: string
}

export const DEFAULT_QWEN_CONFIG: QwenTtsConfig = {
  mode: 'custom',
  model_size: '0.6B',
  speaker: 'Vivian',
  instruct: '',
  clone_ref_audio: '',
  clone_ref_text: '',
  clone_xvector_only: false,
  design_description: ''
}

export const QWEN_SPEAKERS = [
  { id: 'Vivian', label: 'Vivian (bright, slightly edgy · Chinese)' },
  { id: 'Serena', label: 'Serena (warm, gentle · Chinese)' },
  { id: 'Ono_Anna', label: 'Ono Anna (playful · Japanese)' },
  { id: 'Sohee', label: 'Sohee (warm, emotional · Korean)' },
  { id: 'Ryan', label: 'Ryan (dynamic male · English)' },
  { id: 'Aiden', label: 'Aiden (sunny male · English)' },
  { id: 'Uncle_Fu', label: 'Uncle Fu (low, mellow male · Chinese)' },
  { id: 'Dylan', label: 'Dylan (youthful male · Beijing)' },
  { id: 'Eric', label: 'Eric (lively male · Sichuan)' }
]

const VARIANT: Record<QwenMode, string> = { custom: 'CustomVoice', clone: 'Base', design: 'VoiceDesign' }

/** Voice design only exists in the 1.7B size */
export function effectiveQwenSize(cfg: Pick<QwenTtsConfig, 'mode' | 'model_size'>): QwenTtsSize {
  return cfg.mode === 'design' || cfg.model_size === '1.7B' ? '1.7B' : '0.6B'
}

export function qwenModelFolder(cfg: Pick<QwenTtsConfig, 'mode' | 'model_size'>): string {
  return `Qwen3-TTS-12Hz-${effectiveQwenSize(cfg)}-${VARIANT[cfg.mode]}`
}

export function qwenDownloadSize(cfg: Pick<QwenTtsConfig, 'mode' | 'model_size'>): string {
  return effectiveQwenSize(cfg) === '1.7B' ? '4.5 GB' : '2.5 GB'
}

export function normalizeQwenConfig(raw: Partial<QwenTtsConfig> | undefined): QwenTtsConfig {
  const c = { ...DEFAULT_QWEN_CONFIG, ...(raw || {}) }
  return {
    ...c,
    mode: c.mode === 'clone' || c.mode === 'design' ? c.mode : 'custom',
    model_size: c.model_size === '1.7B' ? '1.7B' : '0.6B'
  }
}
