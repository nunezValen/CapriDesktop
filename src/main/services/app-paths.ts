/**
 * Paths for scripts, assets and writable data. In development everything comes from the repo;
 * when installed, scripts/assets are read-only resources and writable data goes to userData.
 */

import { storageDir } from './storage-location'
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { isMac, isWindows, findOnPath } from './platform'

/** Root that contains scripts/ and assets/ */
export function resourceRoot(): string {
  return app.isPackaged ? process.resourcesPath : app.getAppPath()
}

export function scriptPath(name: string): string {
  return path.join(resourceRoot(), 'scripts', name)
}

export function assetPath(...parts: string[]): string {
  return path.join(resourceRoot(), 'assets', ...parts)
}

/** Python virtual environment created by the first-run setup (installed app) or the repo .venv (dev) */
export function pythonEnvDir(): string {
  return app.isPackaged || isMac ? storageDir('python-env') || path.join(app.getPath('userData'), 'python-env') : path.join(app.getAppPath(), '.venv')
}

/** Where a virtual environment keeps its Python */
export function venvPython(): string {
  return isWindows ? path.join(pythonEnvDir(), 'Scripts', 'python.exe') : path.join(pythonEnvDir(), 'bin', 'python')
}

export function pythonPath(): string {
  const venv = venvPython()
  if (fs.existsSync(venv)) return venv
  return isMac ? findOnPath('python3.11') || '/opt/homebrew/opt/python@3.11/bin/python3.11' : isWindows ? 'python' : 'python3'
}

/**
 * Voice config, API keys and audio cache. Writable: user data folder when installed
 * (seeded from the bundled defaults on first use), assets/capri_voice in development.
 */
export function voiceDataDir(): string {
  if (!app.isPackaged && !isMac) return assetPath('capri_voice')
  const dir = path.join(app.getPath('userData'), 'capri_voice')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const cfg = path.join(dir, 'voice_config.json')
  const bundled = assetPath('capri_voice', 'voice_config.json')
  if (!fs.existsSync(cfg) && fs.existsSync(bundled)) fs.copyFileSync(bundled, cfg)
  return dir
}

/** Drawings Capri learned from the scanner (writable): user data folder when installed, repo assets in dev */
export function learnedDrawingsDir(): string {
  const dir = app.isPackaged ? path.join(app.getPath('userData'), 'learned_drawings') : assetPath('game_data', 'learned_drawings')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Tools the first-run setup downloads itself when winget is unavailable (e.g. a portable FFmpeg) */
export function toolsDir(): string {
  return storageDir('tools') || path.join(app.getPath('userData'), 'tools')
}

/** FFmpeg extracted by the setup into toolsDir()/ffmpeg/<build>, if present */
export function localFfmpegPath(): string | null {
  if (isMac) return findOnPath('ffmpeg')
  const root = path.join(toolsDir(), 'ffmpeg')
  try {
    for (const build of fs.readdirSync(root)) {
      const exe = path.join(root, build, 'bin', isWindows ? 'ffmpeg.exe' : 'ffmpeg')
      if (fs.existsSync(exe)) return exe
    }
  } catch {
    // not downloaded
  }
  return null
}

/** Optional .env with API keys (repo root in development, user data folder when installed) */
export function envFilePath(): string {
  return app.isPackaged ? path.join(app.getPath('userData'), '.env') : path.join(app.getAppPath(), '.env')
}

/** Keep Mac speech caches consistent with optional relocated requirements. */
export function speechModelsDir(): string {
  return storageDir('whisper') || path.join(app.getPath('userData'),'speech-models')
}
