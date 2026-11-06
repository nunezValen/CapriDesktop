/**
 * What has to travel when her requirements change disk: where each thing is now, where it goes, and
 * whether it fits. Everything is copied first and deleted later, so a failure leaves her as she was.
 * Only the files here: the steps that need Ollama or Python are in setup-service.
 */

import { app } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { hasOllamaModels, ollamaModelsDir, storageDir } from './storage-location'
import { speechModelsDir, pythonEnvDir, toolsDir } from './app-paths'

export type MoveKind = 'models' | 'whisper' | 'voiceEnv' | 'tools'

export interface MoveItem {
  kind: MoveKind
  from: string
  to: string
  bytes: number
}

export interface MovePlan {
  root: string | null
  items: MoveItem[]
  /** The Ollama program goes through its own installer, which downloads it again */
  ollamaProgram: { from: string; to: string; bytes: number } | null
  neededBytes: number
  /** Null when the disk can't be read */
  freeBytes: number | null
  enoughSpace: boolean
  /** The new folder is inside what's being moved */
  invalid: boolean
}

const samePath = (a: string, b: string): boolean => {
  const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p))
  return norm(a) === norm(b)
}

export function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative)
}

export { samePath }

export async function dirSize(dir: string): Promise<number> {
  let total = 0
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) total += await dirSize(full)
    else {
      try {
        total += (await fs.promises.lstat(full)).size
      } catch {}
    }
  }
  return total
}

export async function copyTree(from: string, to: string, onBytes: (n: number) => void): Promise<void> {
  await fs.promises.mkdir(to, { recursive: true })
  for (const e of await fs.promises.readdir(from, { withFileTypes: true })) {
    const src = path.join(from, e.name)
    const dest = path.join(to, e.name)
    if (e.isDirectory()) {
      await copyTree(src, dest, onBytes)
    } else if (e.isSymbolicLink()) {
      // Whisper's cache can link its files, when Windows allows it
      await fs.promises.rm(dest, { force: true })
      try {
        await fs.promises.symlink(await fs.promises.readlink(src), dest)
      } catch {
        await fs.promises.copyFile(src, dest)
      }
    } else {
      await fs.promises.copyFile(src, dest)
      onBytes((await fs.promises.stat(dest)).size)
    }
  }
}

/** Space on the disk of a folder that may not exist yet */
function freeSpaceAt(dir: string): number | null {
  let probe = path.resolve(dir)
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe)
    if (parent === probe) return null
    probe = parent
  }
  try {
    const s = fs.statfsSync(probe)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

/** Whisper's cache, which may have other programs' models: only hers leave it */
function whisperModels(hubOf: string): string[] {
  try {
    return fs
      .readdirSync(path.join(hubOf, 'hub'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^models--.*whisper/i.test(e.name))
      .map((e) => e.name)
  } catch {
    return []
  }
}

/** ollamaBinaryDir: the folder of the Ollama program in use, if she should move it */
export async function planMove(root: string | null, ollamaProgram: { from: string; to: string } | null): Promise<MovePlan> {
  const home = os.homedir()
  const userData = app.getPath('userData')
  const inRoot = (name: string, fallback: string) => (root ? path.join(root, name) : fallback)
  const items: MoveItem[] = []
  const add = async (kind: MoveKind, from: string, to: string) => {
    if (samePath(from, to) || !fs.existsSync(from)) return
    items.push({ kind, from, to, bytes: await dirSize(from) })
  }

  const defaultModels = path.join(home, '.ollama', 'models')
  const modelsNow = ollamaModelsDir() || process.env.OLLAMA_MODELS || defaultModels
  const managedModels=storageDir('ollama-models')
  // A standalone Mac Ollama library belongs to that app; moving it would break its next launch.
  const mayMoveModels=process.platform!=='darwin' || (!!managedModels && samePath(modelsNow,managedModels))
  if (mayMoveModels && hasOllamaModels(modelsNow)) await add('models', modelsNow, inRoot('ollama-models', defaultModels))

  if(process.platform==='darwin') {
    await add('whisper',speechModelsDir(),inRoot('whisper',path.join(userData,'speech-models')))
  } else {
  const defaultHf = process.env.HF_HOME || path.join(home, '.cache', 'huggingface')
  const hfNow = storageDir('whisper') || defaultHf
  const hfNext = inRoot('whisper', defaultHf)
  for (const name of whisperModels(hfNow)) await add('whisper', path.join(hfNow, 'hub', name), path.join(hfNext, 'hub', name))

  }

  await add('voiceEnv', pythonEnvDir(), inRoot('python-env', path.join(userData, 'python-env')))
  await add('tools', toolsDir(), inRoot('tools', path.join(userData, 'tools')))

  const program = ollamaProgram && !samePath(ollamaProgram.from, ollamaProgram.to) ? { ...ollamaProgram, bytes: await dirSize(ollamaProgram.from) } : null
  const neededBytes = items.reduce((sum, i) => sum + i.bytes, 0) + (program?.bytes || 0)
  const freeBytes = freeSpaceAt(root || home)
  return {
    root,
    items,
    ollamaProgram: program,
    neededBytes,
    freeBytes,
    // A little over, for what's written while it moves
    enoughSpace: freeBytes === null || freeBytes > neededBytes * 1.05,
    invalid: !!root && [...items.map((i) => i.from), ...(program ? [program.from] : [])].some((from) => samePath(root, from) || isInside(root, from))
  }
}
