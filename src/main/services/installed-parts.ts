/**
 * What the first-run setup installed, to see how much each part weighs and remove it: the voice
 * environment, Whisper's hearing model and Capri's own FFmpeg. Ollama's models are managed in the
 * model lists, one by one. Running the setup again puts back anything removed.
 */

import { app } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { pythonEnvDir, toolsDir } from './app-paths'
import { dirSize, qwenModels, whisperModels } from './storage-move'
import { storageDir } from './storage-location'
import { voiceService } from './voice-service'

export type InstalledPartId = 'voiceEnv' | 'whisper' | 'ffmpeg' | 'qwen3tts'

export interface InstalledPart {
  id: InstalledPartId
  bytes: number
  paths: string[]
}

function whisperHub(): string {
  return storageDir('whisper') || process.env.HF_HOME || path.join(os.homedir(), '.cache', 'huggingface')
}

function partPaths(id: InstalledPartId): string[] {
  switch (id) {
    // In development the voice environment is the repository's .venv: never touched from here
    case 'voiceEnv':
      return app.isPackaged ? [pythonEnvDir()] : []
    case 'whisper':
      return whisperModels(whisperHub()).map((name) => path.join(whisperHub(), 'hub', name))
    case 'ffmpeg':
      return [path.join(toolsDir(), 'ffmpeg')]
    // Qwen weights are stored in the same Hugging Face cache as Whisper
    case 'qwen3tts':
      return qwenModels(whisperHub()).map((name) => path.join(whisperHub(), 'hub', name))
  }
}

export async function listInstalledParts(): Promise<InstalledPart[]> {
  const parts: InstalledPart[] = []
  for (const id of ['voiceEnv', 'whisper', 'ffmpeg', 'qwen3tts'] as InstalledPartId[]) {
    const paths = partPaths(id).filter((p) => fs.existsSync(p))
    if (!paths.length) continue
    let bytes = 0
    for (const p of paths) bytes += await dirSize(p)
    parts.push({ id, bytes, paths })
  }
  return parts
}

/** Removes one part. The voice process is stopped first: Windows won't delete files it has open */
export async function removeInstalledPart(id: InstalledPartId): Promise<InstalledPart[]> {
  if (id === 'voiceEnv' || id === 'whisper' || id === 'qwen3tts') voiceService.stopServer()
  await new Promise((r) => setTimeout(r, 800))
  for (const p of partPaths(id)) {
    try {
      await fs.promises.rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 })
    } catch (err) {
      console.warn(`[InstalledParts] Could not remove ${p}:`, err)
    }
  }
  return listInstalledParts()
}

export interface LocalModelInfo {
  name: string
  bytes: number
  /** Can look at images: the scanner and screen reading use these */
  vision: boolean
}

/** Names of models that see, for when Ollama doesn't say (older versions) */
const VISION_NAME = /llava|vision|-vl\b|vl:|qwen2\.5vl|minicpm-v|moondream|bakllava|cogvlm|^gemma3(?::(?!1b)|$)|llama4|granite3\.2-vision/i

/** Ollama's models, each with its size and whether it can see */
export async function listLocalModels(): Promise<LocalModelInfo[]> {
  const res = await fetch('http://127.0.0.1:11434/api/tags').catch(() => null)
  if (!res || !res.ok) return []
  const data = (await res.json()) as { models?: { name: string; size?: number; details?: { families?: string[] } }[] }
  const models: LocalModelInfo[] = []
  for (const m of data.models || []) {
    let vision = VISION_NAME.test(m.name) || (m.details?.families || []).some((f) => /clip|mllama/i.test(f))
    // Recent Ollama says it outright
    try {
      const show = await fetch('http://127.0.0.1:11434/api/show', { method: 'POST', body: JSON.stringify({ model: m.name }), signal: AbortSignal.timeout(4000) })
      if (show.ok) {
        const info = (await show.json()) as { capabilities?: string[] }
        if (Array.isArray(info.capabilities)) vision = info.capabilities.includes('vision')
      }
    } catch {
      // the name decides
    }
    models.push({ name: m.name, bytes: m.size || 0, vision })
  }
  return models.sort((a, b) => a.name.localeCompare(b.name))
}

/** Deletes one of Ollama's models */
export async function deleteLocalModel(name: string): Promise<boolean> {
  if (!/^[a-z0-9][\w.\-/:]{0,120}$/i.test(name)) return false
  const res = await fetch('http://127.0.0.1:11434/api/delete', { method: 'DELETE', body: JSON.stringify({ model: name }) }).catch(() => null)
  return !!res && res.ok
}

