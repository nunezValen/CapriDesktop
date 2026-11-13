import { localAIEnabled } from './local-ai-policy'
import { ollamaModelsDir, programDirs } from './storage-location'
import { isCloudMode, llmFetch } from './llm-gateway'
import { toolsDir } from './app-paths'
import { findOnPath, isMac, isLinux, isWindows, killProcesses } from './platform'
import { spawn } from './hidden-process'
import type { ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'

export interface OllamaStatus {
  running: boolean
  models: string[]
}

/** How a model download is going, for the settings window */
export interface ModelPullProgress {
  model: string
  state: 'downloading' | 'done' | 'failed' | 'cancelled'
  /** 0-100 while the size is known */
  percent?: number
  status?: string
  error?: string
}

/** A name from the Ollama library: "gemma3", "gemma3:4b", "hf.co/user/model:Q4_K_M" */
export function isValidModelName(name: string): boolean {
  return /^[a-z0-9][\w.\-/:]{0,120}$/i.test(name) && !name.includes('..')
}

export class OllamaService {
  private static instance: OllamaService
  private isStarting = false
  private ownedProcess: ReturnType<typeof spawn> | null = null
  private serving: { child: ChildProcess; modelsDir: string | undefined } | null = null
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

  /** The models folder of the Ollama she started, while it's alive. Null for one started by anything else */
  public servingModelsDir(): string | null {
    return this.serving?.modelsDir ?? null
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
    if (isCloudMode() && !this.ownedProcess) return true

    this.isStarting = false
    this.cachedModels = []

    try {
      if (isMac) { this.ownedProcess?.kill('SIGTERM'); this.ownedProcess = null }
      else killProcesses(['ollama', 'ollama app'])
      return true
    } catch (e) {
      console.warn('[OllamaService] Error stopping Ollama:', e)
      return false
    }
  }

  /**
   * Quick check if Ollama is currently reachable on localhost:11434
   */
  public async queryTags(forceLocal = false): Promise<OllamaStatus> {
    try {
      if (isCloudMode() && !forceLocal) {
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
    if (isMac) return findOnPath('ollama')
    if (isLinux) {
      const own = path.join(toolsDir(), 'ollama', 'bin', 'ollama')
      return fs.existsSync(own) ? own : findOnPath('ollama')
    }

    const candidates = [
      ...programDirs('Ollama').map((dir) => path.join(dir, 'ollama.exe')),
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
  public async ensureRunning(forceLocal = false): Promise<OllamaStatus> {
    if (isMac && !localAIEnabled() && (forceLocal || !isCloudMode())) return {running:false,models:[]}
    this.touchActivity()
    // Check if already running
    const initial = await this.queryTags(forceLocal)
    if (initial.running) {
      return initial
    }

    if (this.isStarting) {
      // Already attempting start, wait a moment and re-query
      await new Promise((r) => setTimeout(r, 2000))
      return await this.queryTags(forceLocal)
    }

    this.isStarting = true
    try {
      const binary = this.findOllamaBinary()
      if (!binary) {
        console.warn('[OllamaService] Ollama executable not found on system.')
        return { running: false, models: [] }
      }

      const modelsDir = ollamaModelsDir() || process.env.OLLAMA_MODELS || undefined

      console.log(`[OllamaService] Starting Ollama daemon from: ${binary}`)
      if (modelsDir) {
        console.log(`[OllamaService] Using OLLAMA_MODELS directory: ${modelsDir}`)
      }

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...(modelsDir ? { OLLAMA_MODELS: modelsDir } : {}),
        OLLAMA_KEEP_ALIVE: isMac ? '2m' : '24h',
        // Ollama's default of 4096 cuts her instructions, and she forgets who she is
        OLLAMA_CONTEXT_LENGTH: process.env.OLLAMA_CONTEXT_LENGTH || (isMac ? '2048' : '8192')
      }

      // Never detached on Windows: that leaves it with no console at all, even with windowsHide, so
      // Windows opens a visible one for each runner it starts when a model loads. Not detached it has
      // a hidden console its runners share, and it closes with her, which stop() already does
      const child = spawn(binary, ['serve'], {
        detached: !isWindows,
        stdio: 'ignore',
        windowsHide: true,
        env
      })

      child.on('error', err => console.warn('[Ollama] Start failed:', err.message))
      if (isMac) this.ownedProcess = child
      child.unref()
      const serving = { child, modelsDir }
      this.serving = serving
      child.once('exit', () => {
        if (this.serving === serving) this.serving = null
      })

      // Poll until alive (up to 6 seconds)
      for (let attempt = 1; attempt <= 12; attempt++) {
        await new Promise((r) => setTimeout(r, 500))
        const status = await this.queryTags(forceLocal)
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

  private pulling: { model: string; controller: AbortController } | null = null

  /**
   * Downloads a model from the Ollama library (Gemma, Llama, Qwen, Mistral...). One at a time.
   * Always from the local Ollama, also in cloud mode: it is the model on this PC.
   */
  public async pullModel(model: string, onProgress: (p: ModelPullProgress) => void): Promise<boolean> {
    const name = model.trim()
    if (!isValidModelName(name)) return onProgress({ model: name, state: 'failed', error: 'invalid-name' }), false
    if (this.pulling) return onProgress({ model: name, state: 'failed', error: 'busy' }), false
    const status = await this.ensureRunning(true)
    if (!status.running) return onProgress({ model: name, state: 'failed', error: 'offline' }), false
    const controller = new AbortController()
    this.pulling = { model: name, controller }
    onProgress({ model: name, state: 'downloading', status: 'starting' })
    try {
      const res = await fetch('http://127.0.0.1:11434/api/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name, stream: true }),
        signal: controller.signal
      })
      if (!res.ok || !res.body) {
        onProgress({ model: name, state: 'failed', error: (await res.text().catch(() => '')).slice(0, 200) || `HTTP ${res.status}` })
        return false
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let lastSent = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          const event = JSON.parse(line) as { status?: string; total?: number; completed?: number; error?: string }
          if (event.error) return onProgress({ model: name, state: 'failed', error: event.error }), false
          const percent = event.total ? Math.floor(((event.completed ?? 0) / event.total) * 100) : undefined
          // A few updates a second are plenty for a progress bar
          if (Date.now() - lastSent > 250) {
            lastSent = Date.now()
            onProgress({ model: name, state: 'downloading', percent, status: event.status })
          }
        }
      }
      this.cachedModels = []
      onProgress({ model: name, state: 'done', percent: 100 })
      return true
    } catch (err) {
      const cancelled = controller.signal.aborted
      onProgress({ model: name, state: cancelled ? 'cancelled' : 'failed', error: cancelled ? undefined : String((err as Error)?.message || err).slice(0, 200) })
      return false
    } finally {
      this.pulling = null
    }
  }

  public cancelPull(): void {
    this.pulling?.controller.abort()
  }

  /** A name Ollama accepts, from a .gguf file: "Llama-3.2-3B-Instruct-Q4_K_M.gguf" -> "llama-3.2-3b-instruct-q4_k_m" */
  public static modelNameForGguf(file: string): string {
    const base = path.basename(file).replace(/\.gguf$/i, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|[-_.]+$/g, '')
    return (base || 'gguf-model').slice(0, 80)
  }

  /**
   * Adds a .gguf file on this PC to Ollama as its own model, the way `ollama create` does with a
   * Modelfile that says FROM <file>. Ollama copies the weights into its own models folder.
   */
  public async importGguf(file: string, onProgress: (p: ModelPullProgress) => void): Promise<boolean> {
    const name = OllamaService.modelNameForGguf(file)
    if (!/\.gguf$/i.test(file) || !fs.existsSync(file)) return onProgress({ model: name, state: 'failed', error: 'missing-file' }), false
    if (this.pulling) return onProgress({ model: name, state: 'failed', error: 'busy' }), false
    const cli = this.findOllamaBinary()
    const status = await this.ensureRunning(true)
    if (!cli || !status.running) return onProgress({ model: name, state: 'failed', error: 'offline' }), false
    const modelfile = path.join(os.tmpdir(), `capri-gguf-${Date.now()}.Modelfile`)
    fs.writeFileSync(modelfile, `FROM ${file}\n`, 'utf-8')
    const controller = new AbortController()
    this.pulling = { model: name, controller }
    onProgress({ model: name, state: 'downloading', status: 'importing' })
    try {
      const ok = await new Promise<boolean>((resolve) => {
        const child = spawn(cli, ['create', name, '-f', modelfile], { windowsHide: true })
        let lastLine = ''
        const onData = (data: Buffer) => {
          const text = data.toString().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
          const line = text.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean).pop()
          if (!line) return
          lastLine = line
          const percent = line.match(/(\d{1,3})%/)?.[1]
          onProgress({ model: name, state: 'downloading', status: line.slice(0, 80), percent: percent ? Number(percent) : undefined })
        }
        child.stdout?.on('data', onData)
        child.stderr?.on('data', onData)
        controller.signal.addEventListener('abort', () => child.kill())
        child.on('error', () => resolve(false))
        child.on('close', (code) => {
          if (code !== 0 && !controller.signal.aborted) onProgress({ model: name, state: 'failed', error: lastLine.slice(0, 200) || `exit ${code}` })
          resolve(code === 0)
        })
      })
      if (controller.signal.aborted) return onProgress({ model: name, state: 'cancelled' }), false
      if (!ok) return false
      this.cachedModels = []
      onProgress({ model: `${name}:latest`, state: 'done', percent: 100 })
      return true
    } finally {
      this.pulling = null
      fs.rm(modelfile, () => {})
    }
  }
}

export const ollamaService = OllamaService.getInstance()
