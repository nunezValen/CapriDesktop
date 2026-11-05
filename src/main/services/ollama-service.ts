import { isRemoteMode, llmFetch } from './llm-gateway'
import { toolsDir } from './app-paths'
import { findOnPath, isLinux, killProcesses } from './platform'
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'

export interface OllamaStatus {
  running: boolean
  models: string[]
}

export class OllamaService {
  private static instance: OllamaService
  private isStarting = false
  private cachedModels: string[] = []
  private idleTimer: NodeJS.Timeout | null = null
  private readonly IDLE_TIMEOUT_MS = 60 * 60 * 1000 // 1 hour of inactivity (keeps model warm in memory)

  public static getInstance(): OllamaService {
    if (!OllamaService.instance) {
      OllamaService.instance = new OllamaService()
    }
    return OllamaService.instance
  }

  /**
   * Resets the inactivity timer. If no prompts or actions happen for 1 hour,
   * Ollama is powered down to free up RAM and VRAM.
   */
  public touchActivity(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }

    this.idleTimer = setTimeout(() => {
      console.log('[OllamaService] Inactivity detected (1h idle without prompts). Powering down Ollama to save system resources...')
      this.stop()
    }, this.IDLE_TIMEOUT_MS)
  }

  /**
   * Stops the Ollama process to free RAM/VRAM
   */
  public async stop(): Promise<boolean> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    // With a cloud model Capri never started Ollama: an instance running here belongs to the user
    if (isRemoteMode()) return true

    this.isStarting = false
    this.cachedModels = []

    try {
      killProcesses(['ollama', 'ollama app'])
      return true
    } catch (e) {
      console.warn('[OllamaService] Error stopping Ollama:', e)
      return false
    }
  }

  /**
   * Quick check if Ollama is currently reachable on localhost:11434
   */
  public async queryTags(): Promise<OllamaStatus> {
    try {
      if (isRemoteMode()) {
        const res = await llmFetch('http://127.0.0.1:11434/api/tags')
        const data = (await res.json()) as { models?: { name: string }[] }
        return { running: true, models: (data.models || []).map((m) => m.name) }
      }
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 2500)
      const res = await fetch('http://127.0.0.1:11434/api/tags', {
        signal: controller.signal
      })
      clearTimeout(timeout)

      if (res.ok) {
        const data = (await res.json()) as { models?: { name: string }[] }
        const models = (data.models || []).map((m) => m.name)
        this.cachedModels = models
        return { running: true, models }
      }
      return { running: false, models: [] }
    } catch {
      return { running: false, models: [] }
    }
  }

  /**
   * Finds the path to the ollama binary
   */
  public findOllamaBinary(): string | null {
    if (isLinux) {
      const own = path.join(toolsDir(), 'ollama', 'bin', 'ollama')
      return fs.existsSync(own) ? own : findOnPath('ollama')
    }

    const candidates = [
      process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe')
        : '',
      path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Ollama', 'ollama.exe'),
      path.join(
        process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
        'Ollama',
        'ollama.exe'
      )
    ].filter(Boolean)

    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          return p
        }
      } catch {
        // ignore
      }
    }

    return null
  }

  /**
   * Ensures Ollama is running. If not running, launches it in the background
   * with OLLAMA_MODELS pointing to D:\ollama_models (or user's env).
   */
  public async ensureRunning(): Promise<OllamaStatus> {
    this.touchActivity()
    // Check if already running
    const initial = await this.queryTags()
    if (initial.running) {
      return initial
    }

    if (this.isStarting) {
      // Already attempting start, wait a moment and re-query
      await new Promise((r) => setTimeout(r, 2000))
      return await this.queryTags()
    }

    this.isStarting = true
    try {
      const binary = this.findOllamaBinary()
      if (!binary) {
        console.warn('[OllamaService] Ollama executable not found on system.')
        return { running: false, models: [] }
      }

      const modelsDir = process.env.OLLAMA_MODELS || undefined

      console.log(`[OllamaService] Starting Ollama daemon from: ${binary}`)
      if (modelsDir) {
        console.log(`[OllamaService] Using OLLAMA_MODELS directory: ${modelsDir}`)
      }

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...(modelsDir ? { OLLAMA_MODELS: modelsDir } : {}),
        OLLAMA_KEEP_ALIVE: '24h',
        // Ollama's default of 4096 cuts her instructions, and she forgets who she is
        OLLAMA_CONTEXT_LENGTH: process.env.OLLAMA_CONTEXT_LENGTH || '8192'
      }

      // Launch detached background process
      const child = spawn(binary, ['serve'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env
      })

      child.unref()

      // Poll until alive (up to 6 seconds)
      for (let attempt = 1; attempt <= 12; attempt++) {
        await new Promise((r) => setTimeout(r, 500))
        const status = await this.queryTags()
        if (status.running) {
          console.log(
            `[OllamaService] Ollama is online! Available models: ${status.models.join(', ')}`
          )
          return status
        }
      }

      console.warn('[OllamaService] Timed out waiting for Ollama to start.')
      return { running: false, models: [] }
    } finally {
      this.isStarting = false
    }
  }
}

export const ollamaService = OllamaService.getInstance()
