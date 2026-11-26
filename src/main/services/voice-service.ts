import { clearLanguageOf, detectLanguage, strayLanguageOf } from './language-detect'
import { isCloudMode, llmFetch } from './llm-gateway'
import { huggingFaceHome, speechModelsDir, envFilePath, localFfmpegPath, pythonPath, scriptPath, voiceDataDir } from './app-paths'
import { spawn, ChildProcess } from 'child_process'
import { stripLookTags } from './script/look-tags'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { app } from 'electron'
import { isMac } from './platform'
import { transcribeInCloud } from './cloud-stt'
import { consciousnessService } from './consciousness-service'
import { effectiveQwenSize, normalizeQwenConfig, type QwenTtsConfig } from '../../shared/qwen-tts'
import { ollamaService } from './ollama-service'
function loadEnv(): void {
  const envCandidates = [envFilePath()]
  for (const envPath of envCandidates) {
    if (fs.existsSync(envPath)) {
      try {
        const content = fs.readFileSync(envPath, 'utf-8')
        for (const line of content.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed || trimmed.startsWith('#')) continue
          const eqIdx = trimmed.indexOf('=')
          if (eqIdx !== -1) {
            const key = trimmed.slice(0, eqIdx).trim()
            let val = trimmed.slice(eqIdx + 1).trim()
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
              val = val.slice(1, -1)
            }
            if (!process.env[key]) {
              process.env[key] = val
            }
          }
        }
        break
      } catch {}
    }
  }
}
loadEnv()

export interface TranscribeResult {
  success: boolean
  text?: string
  error?: string
}

export interface SynthesizeResult {
  success: boolean
  audioDataUrl?: string
  error?: string
  fallback?: boolean
}

type TtsResult = { success: boolean; error?: string; fallback?: boolean; path?: string }
interface TtsJob {
  id: string
  key: string
  payload: { op?: string; text: string; lang?: string; out: string; fresh?: boolean; cfg?: Record<string, unknown>; description?: string }
  resolve: (res: TtsResult) => void
  timer?: NodeJS.Timeout
}

export class VoiceService {
  private static instance: VoiceService
  private sttWorker: ChildProcess | null = null
  /** The worker loads Whisper before it answers, and the first time it also downloads it */
  private sttState: 'off' | 'loading' | 'ready' | 'failed' = 'off'
  private lastTranscript: { text: string; lang: string; at: number } | null = null
  private pendingRequests: Map<string, {
    resolve: (res: TranscribeResult) => void
    reject: (err: any) => void
    tempIn: string
    timer: NodeJS.Timeout
  }> = new Map()
  private requestCounter = 0
  private workerLineBuffer = ''
  private audioCache: Map<string, string> = new Map()
  private prewarming = false
  private ttsWorker: ChildProcess | null = null
  /** The worker answers one line at a time: one request is with it, the rest wait here */
  private ttsActive: TtsJob | null = null
  private ttsQueue: TtsJob[] = []
  private ttsCounter = 0
  private ttsLoadedKey = ''
  /** Where the model runs (cuda:0, mps, cpu), as the worker last said */
  private ttsDevice = ''
  private ttsIdleTimer: NodeJS.Timeout | null = null
  private ttsLineBuffer = ''

  public static getInstance(): VoiceService {
    if (!VoiceService.instance) {
      VoiceService.instance = new VoiceService()
    }
    return VoiceService.instance
  }

  public stopServer(): void {
    this.stopTtsWorker()
    if (this.sttWorker) {
      try {
        this.sttWorker.kill()
      } catch {}
      this.sttWorker = null
    }
  }

  /** Tells capri_voice.py where the (writable) voice config, keys and audio cache live */
  private pythonEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUTF8: '1', CAPRI_VOICE_DIR: voiceDataDir(), CAPRI_ENV_FILE: envFilePath(), PYTHONIOENCODING: 'utf-8' }
    if (isMac) env.CAPRI_WHISPER_DIR = speechModelsDir()
    const ffmpeg = localFfmpegPath()
    if (ffmpeg && !env.CAPRI_FFMPEG) env.CAPRI_FFMPEG = ffmpeg
    // Whisper's model weighs about 500 MB
    env.HF_HOME = huggingFaceHome()
    return env
  }

  public isQwenActive(): boolean {
    const provider = String(this.getConfig()?.provider || '').toLowerCase().replace(/_/g, '-')
    return provider === 'qwen3-tts' || provider === 'qwen3tts'
  }

  public stopTtsWorker(): void {
    if (this.ttsIdleTimer) clearTimeout(this.ttsIdleTimer)
    this.ttsIdleTimer = null
    const worker = this.ttsWorker
    this.ttsWorker = null
    this.ttsLoadedKey = ''
    this.ttsDevice = ''
    if (worker) {
      try {
        worker.kill()
      } catch {}
    }
    this.drainTtsQueue('Qwen3-TTS worker stopped')
  }

  /** Fails the request in the worker and every one waiting for it */
  private drainTtsQueue(error: string): void {
    const jobs = [...(this.ttsActive ? [this.ttsActive] : []), ...this.ttsQueue]
    this.ttsActive = null
    this.ttsQueue = []
    for (const job of jobs) {
      if (job.timer) clearTimeout(job.timer)
      job.resolve({ success: false, error })
    }
  }

  private ensureTtsWorker(): boolean {
    if (this.ttsWorker && !this.ttsWorker.killed) return true
    try {
      const worker = spawn(this.findPythonPath(), [this.findScriptPath(), 'tts-worker'], {
        windowsHide: true,
        env: this.pythonEnv(),
        stdio: ['pipe', 'pipe', 'pipe']
      })
      this.ttsWorker = worker
      this.ttsLineBuffer = ''
      worker.stdin?.on('error', (err) => {
        if (this.ttsWorker === worker) this.drainTtsQueue(err.message)
      })
      worker.stdout?.on('data', (chunk) => {
        this.ttsLineBuffer += chunk.toString()
        const lines = this.ttsLineBuffer.split('\n')
        this.ttsLineBuffer = lines.pop() || ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            const parsed = JSON.parse(trimmed)
            if (parsed.ready !== undefined) continue
            if (typeof parsed.device === 'string') this.ttsDevice = parsed.device
            const job = this.ttsActive
            if (job && parsed.id === job.id) {
              this.ttsActive = null
              if (job.timer) clearTimeout(job.timer)
              if (parsed.success) this.ttsLoadedKey = job.key
              job.resolve(parsed)
              this.pumpTtsQueue()
            }
          } catch {
            console.warn('[VoiceService TTS Worker] Unparseable line:', trimmed)
          }
        }
      })
      worker.stderr?.on('data', (d) => {
        const str = d.toString().trim()
        if (str && !/%\||it\/s|s\/it/.test(str)) console.warn('[VoiceService TTS Worker]', str)
      })
      worker.on('error', (err) => {
        console.error('[VoiceService TTS Worker Error]', err)
        if (this.ttsWorker === worker) this.drainTtsQueue(err.message)
      })
      worker.on('close', (code) => {
        console.warn(`[VoiceService TTS Worker] Process closed with code ${code}`)
        if (this.ttsWorker !== worker) return
        this.ttsWorker = null
        this.ttsLoadedKey = ''
        this.ttsDevice = ''
        this.drainTtsQueue(`TTS worker closed with code ${code}`)
      })
      return true
    } catch (err) {
      console.error('[VoiceService TTS Worker Spawn Failed]', err)
      this.ttsWorker = null
      return false
    }
  }

  private qwenKey(cfg: QwenTtsConfig): string {
    return `${cfg.mode}|${effectiveQwenSize(cfg)}`
  }

  private requestTts(payload: TtsJob['payload'], key: string): Promise<TtsResult> {
    return new Promise((resolve) => {
      this.ttsQueue.push({ id: `tts_${++this.ttsCounter}_${Date.now()}`, key, payload, resolve })
      this.pumpTtsQueue()
    })
  }

  /** Sends the next waiting request once the worker is free. Its time limit starts here, not when it was asked for */
  private pumpTtsQueue(): void {
    if (this.ttsActive) return
    const job = this.ttsQueue.shift()
    if (!job) return
    if (!this.ensureTtsWorker() || !this.ttsWorker?.stdin) {
      job.resolve({ success: false, error: 'Qwen3-TTS worker could not start' })
      return this.pumpTtsQueue()
    }
    // A model that has to load, or one running on the CPU, takes far longer than a loaded one on CUDA
    const waitMs = this.ttsLoadedKey === job.key && this.ttsDevice.startsWith('cuda') ? 60_000 : this.ttsLoadedKey === job.key ? 240_000 : 300_000
    this.ttsActive = job
    job.timer = setTimeout(() => {
      if (this.ttsActive !== job) return
      this.ttsActive = null
      // The worker is stuck: restart it, but the lines still waiting get a fresh worker instead of failing
      const stuck = this.ttsWorker
      this.ttsWorker = null
      this.ttsLoadedKey = ''
      this.ttsDevice = ''
      try {
        stuck?.kill()
      } catch {}
      job.resolve({ success: false, error: `Qwen3-TTS timeout (${waitMs}ms)` })
      this.pumpTtsQueue()
    }, waitMs)
    const { payload } = job
    this.ttsWorker.stdin.write(JSON.stringify({ id: job.id, op: payload.op, text: payload.text, out: payload.out, lang: payload.lang, noCache: payload.fresh, cfg: payload.cfg, description: payload.description }) + '\n')
  }

  /** Stops the model after a while when a preview used a voice that is not saved */
  private stopTtsWhenIdle(): void {
    if (this.ttsIdleTimer) clearTimeout(this.ttsIdleTimer)
    this.ttsIdleTimer = setTimeout(() => {
      // Something is still being spoken: look again later instead of cutting it off
      if (this.ttsActive || this.ttsQueue.length) return this.stopTtsWhenIdle()
      if (!this.isQwenActive()) return this.stopTtsWorker()
      // Qwen is the saved voice, but a preview may have left another mode or size loaded
      if (this.ttsLoadedKey !== this.qwenKey(normalizeQwenConfig(this.getConfig()?.qwen3_tts))) {
        this.stopTtsWorker()
        this.warmQwen()
      }
    }, 120_000)
  }

  public warmQwen(): void {
    if (!this.isQwenActive()) return
    const key = this.qwenKey(normalizeQwenConfig(this.getConfig()?.qwen3_tts))
    if (this.ttsLoadedKey === key) return
    const out = path.join(os.tmpdir(), `capri_tts_warm_${Date.now()}.mp3`)
    void this.requestTts({ text: 'Ready.', lang: 'en', out, fresh: true, cfg: { _strict: true } }, key).then(() => {
      try {
        if (fs.existsSync(out)) fs.unlinkSync(out)
      } catch {}
    })
  }

  /** Makes a sample with a designed voice and saves it as wav so it can be cloned */
  public async designReference(text: string, description: string, lang?: string): Promise<{ success: boolean; path?: string; error?: string }> {
    const dir = path.join(voiceDataDir(), 'clone')
    fs.mkdirSync(dir, { recursive: true })
    const out = path.join(dir, `design_${Date.now()}.wav`)
    const res = await this.requestTts({ op: 'design_reference', text, description, lang, out }, 'design|1.7B')
    this.stopTtsWhenIdle()
    return res.success ? { success: true, path: out } : { success: false, error: res.error }
  }

  /** Transcribes the reference locally so the voice sample never goes to the cloud */
  public async transcribeReference(filePath: string): Promise<TranscribeResult> {
    const stat = fs.statSync(filePath)
    if (stat.size > 50 * 1024 * 1024) return { success: false, error: 'Reference audio is too large' }
    return this.transcribeLocally(fs.readFileSync(filePath), false, 'small')
  }

  private findScriptPath(): string {
    return scriptPath('capri_voice.py')
  }

  private findPythonPath(): string {
    return pythonPath()
  }

  /**
   * Starts and maintains a persistent background Whisper STT worker for sub-second responses
   */
  public ensureWorker(): void {
    if (this.sttWorker && !this.sttWorker.killed) return

    this.sttState = 'loading'
    const scriptPath = this.findScriptPath()
    const pythonPath = this.findPythonPath()

    try {
      // The model in use is loaded before the first phrase; the other one only if it's chosen later
      const firstModel = consciousnessService.getLanguageSettings().sttEngine === 'whisper-base' ? 'base' : 'small'
      const worker = spawn(pythonPath, [scriptPath, 'stt-worker', '--model', firstModel], {
        windowsHide: true,
        env: this.pythonEnv(),
        stdio: ['pipe', 'pipe', 'pipe']
      })
      this.sttWorker = worker

      this.sttWorker.stdin?.on('error', err => this.drainQueueWithError(err.message))
      this.sttWorker.stdout?.on('data', (chunk) => {
        this.workerLineBuffer += chunk.toString()
        const lines = this.workerLineBuffer.split('\n')
        this.workerLineBuffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            const parsed = JSON.parse(trimmed)
            if (parsed.ready !== undefined) {
              console.log('[VoiceService] Local STT Whisper worker is ready:', parsed)
              if (this.sttWorker === worker) this.sttState = parsed.ready ? 'ready' : 'failed'
              continue
            }

            if (parsed.id && this.pendingRequests.has(parsed.id)) {
              const req = this.pendingRequests.get(parsed.id)!
              this.pendingRequests.delete(parsed.id)
              clearTimeout(req.timer)
              try {
                if (fs.existsSync(req.tempIn)) fs.unlinkSync(req.tempIn)
              } catch {}
              req.resolve(parsed)
            } else if (this.pendingRequests.size === 1) {
              const entry = this.pendingRequests.entries().next().value
              if (entry) {
                const [singleId, req] = entry
                this.pendingRequests.delete(singleId)
                clearTimeout(req.timer)
                try {
                  if (fs.existsSync(req.tempIn)) fs.unlinkSync(req.tempIn)
                } catch {}
                req.resolve(parsed)
              }
            }
          } catch (e) {
            console.warn('[VoiceService Worker] Unparseable line from python STT:', trimmed)
          }
        }
      })

      this.sttWorker.stderr?.on('data', (data) => {
        const str = data.toString()
        // Only log non-empty non-progress messages
        if (str.trim() && !str.includes('Processing') && !str.includes('%')) {
          console.warn('[VoiceService Worker STDERR]', str.trim())
        }
      })

      this.sttWorker.on('error', (err) => {
        console.error('[VoiceService Worker Error]', err)
        this.drainQueueWithError(err.message)
      })

      worker.on('close', (code) => {
        console.warn(`[VoiceService Worker] Process closed with code ${code}`)
        // Restarted on purpose: the new one is already running and this says nothing about it
        if (this.sttWorker !== worker) return
        this.drainQueueWithError(`Worker closed with code ${code}`)
        this.sttWorker = null
        this.sttState = 'failed'
      })
    } catch (err: any) {
      console.error('[VoiceService Worker Spawn Failed]', err)
      this.sttWorker = null
      this.sttState = 'failed'
    }
  }

  private drainQueueWithError(errorMsg: string): void {
    for (const [id, req] of this.pendingRequests.entries()) {
      clearTimeout(req.timer)
      try {
        if (fs.existsSync(req.tempIn)) fs.unlinkSync(req.tempIn)
      } catch {}
      req.resolve({ success: false, error: errorMsg })
    }
    this.pendingRequests.clear()
  }

  /**
   * Transcribes an audio Buffer into text using local faster-whisper on GPU
   */
  /** Starts over with whatever Python is installed now: the one it started with may not have had Whisper */
  public restartWorker(): void {
    if (this.sttWorker) {
      try {
        this.sttWorker.kill()
      } catch {}
      this.sttWorker = null
    }
    this.sttState = 'off'
    this.ensureWorker()
  }

  public getSttState(): 'off' | 'loading' | 'ready' | 'failed' {
    return this.sttState
  }

  /** The language Whisper heard, if this text is what it just transcribed */
  public languageOfTranscript(text: string): string | null {
    const last = this.lastTranscript
    if (!last || Date.now() - last.at > 15000 || !text.trim()) return null
    const clean = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    // A wake word may have been taken off the start
    return clean(last.text).includes(clean(text)) ? last.lang : null
  }

  public async transcribe(audioBuffer: Buffer, partial = false): Promise<TranscribeResult> {
    const engine = consciousnessService.getLanguageSettings().sttEngine || 'whisper-small'
    if (engine === 'cloud') {
      // The words on screen while talking would be one paid request every second: only the final one
      if (partial) return { success: false, error: 'busy' }
      const startedAt = Date.now()
      const micLang = consciousnessService.getLanguageSettings().micLang || 'auto'
      const cloud = await transcribeInCloud(audioBuffer, micLang)
      if (cloud) {
        console.log(`[VoiceService] Cloud transcription in ${Date.now() - startedAt}ms: "${cloud.text || cloud.error || ''}"`)
        if (cloud.success && cloud.text) {
          if (cloud.language) this.lastTranscript = { text: cloud.text, lang: cloud.language, at: Date.now() }
          return { success: true, text: cloud.text }
        }
        // Silence is an answer too: transcribing it again locally would only add seconds
        if (cloud.error === 'No speech detected') return { success: false, error: cloud.error }
        console.warn('[VoiceService] Cloud transcription failed, using local Whisper:', cloud.error)
      } else {
        console.warn('[VoiceService] No saved API key can transcribe (Google, OpenAI or Groq): using local Whisper')
      }
    }
    return this.transcribeLocally(audioBuffer, partial, engine === 'whisper-base' ? 'base' : 'small')
  }

  private async transcribeLocally(audioBuffer: Buffer, partial: boolean, whisperModel: 'small' | 'base'): Promise<TranscribeResult> {
    // Words on screen while talking are a nicety: they never make the real request wait in line
    if (partial && (this.sttState !== 'ready' || this.pendingRequests.size > 0)) {
      return { success: false, error: 'busy' }
    }
    // A worker that failed gets another try: Python may have been installed since
    if (this.sttState === 'failed') this.restartWorker()
    const startedAt = Date.now()
    const id = `req_${++this.requestCounter}_${Date.now()}`
    const tempIn = path.join(os.tmpdir(), `capri_stt_${id}.webm`)
    fs.writeFileSync(tempIn, audioBuffer)

    try {
      this.ensureWorker()
      if (!this.sttWorker || this.sttWorker.killed || !this.sttWorker.stdin) {
        return await this.transcribeFallback(tempIn)
      }

      const prefLang = consciousnessService.getLanguageSettings().micLang || 'auto'
      const hint = consciousnessService.getPreferredLanguage()
      // Downloading Whisper or running on a slow CPU takes far longer than 18 seconds
      const waitMs = partial ? 15000 : this.sttState === 'ready' ? 90000 : 600000

      const result = await new Promise<TranscribeResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingRequests.delete(id)
          try {
            if (fs.existsSync(tempIn)) fs.unlinkSync(tempIn)
          } catch {}
          // A worker that never answers would also swallow every later request
          if (!partial) this.restartWorker()
          resolve({ success: false, error: `STT Worker timeout (${waitMs}ms)` })
        }, waitMs)

        this.pendingRequests.set(id, { resolve, reject, tempIn, timer })
        const payload = JSON.stringify({ id, file: tempIn, lang: prefLang, hint, model: whisperModel }) + '\n'
        this.sttWorker!.stdin!.write(payload)
      })
      if (!partial) console.log(`[VoiceService] Whisper transcribed in ${Date.now() - startedAt}ms: "${result.text || result.error || ''}"`)
      if (!partial && result.success && result.text && (result as { language?: string }).language) {
        this.lastTranscript = { text: result.text, lang: (result as { language?: string }).language as string, at: Date.now() }
      }
      return result
    } catch (err: any) {
      try {
        if (fs.existsSync(tempIn)) fs.unlinkSync(tempIn)
      } catch {}
      return { success: false, error: err?.message || String(err) }
    }
  }

  private async transcribeFallback(tempIn: string): Promise<TranscribeResult> {
    const scriptPath = this.findScriptPath()
    const pythonPath = this.findPythonPath()
    const prefLang = consciousnessService.getLanguageSettings().micLang || 'auto'

    try {
      return await new Promise<TranscribeResult>((resolve) => {
        const procArgs = [scriptPath, 'stt', '--file', tempIn]
        if (prefLang && prefLang !== 'auto') {
          procArgs.push('--lang', prefLang)
        }

        const proc = spawn(pythonPath, procArgs, {
          windowsHide: true,
          env: this.pythonEnv()
        })

        proc.once('error', err => resolve({success: false, error: `Voice engine could not start: ${err.message}. Run setup to install Python and voice dependencies.`}))

        let stdout = ''
        let stderr = ''

        proc.stdout.on('data', (d) => (stdout += d.toString()))
        proc.stderr.on('data', (d) => (stderr += d.toString()))

        proc.on('close', (code) => {
          try {
            if (fs.existsSync(tempIn)) fs.unlinkSync(tempIn)
          } catch {}

          if (code !== 0) {
            console.warn('[VoiceService Fallback] Python STT process exited with code', code, stderr)
            resolve({ success: false, error: stderr || `Process exited with code ${code}` })
            return
          }

          try {
            const parsed = JSON.parse(stdout.trim())
            resolve(parsed)
          } catch {
            resolve({ success: false, error: stdout || 'Failed to parse STT response' })
          }
        })
      })
    } catch (err: any) {
      try {
        if (fs.existsSync(tempIn)) fs.unlinkSync(tempIn)
      } catch {}
      return { success: false, error: err?.message || String(err) }
    }
  }

  /**
   * Synthesizes text into Capri's voice with exact acoustic profile and zero latency
   */
  public async synthesize(text: string, langOverride?: string, opts: { silent?: boolean; fresh?: boolean; qwenPreview?: Partial<QwenTtsConfig> } = {}): Promise<SynthesizeResult> {
    // Strip all emoji characters and pictorial symbols so TTS does not read them out loud
    const cleanText = stripLookTags(text)
      .replace(/[\u{1F300}-\u{1F9FF}]|[\u{1FA00}-\u{1FAFF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F000}-\u{1F02F}]|[\u{1F0A0}-\u{1F0FF}]|[\u{1F100}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]/gu, '')
      .replace(/[🐾✨👀⚡🎉🦾🛑💬🎵🔥💥💡⚔️📹🎮💤✓✕⚠️🤖🐱🐶👍👎❤️]/g, '')
      .replace(/[*#_~>|`]/g, '')
      .replace(/\s+/g, ' ')
      .trim()

    if (!cleanText) {
      return { success: false, error: 'Empty text provided' }
    }

    const scriptPath = this.findScriptPath()
    const pythonPath = this.findPythonPath()
    const tempOut = path.join(os.tmpdir(), `capri_tts_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.mp3`)

    // Strip text inside quotes ("...", “...”, etc.) so that foreign quoted media/video titles
    // do NOT alter the detected language of Capri's actual sentence framing
    const textForLangDetection = cleanText.replace(/["“][^"”]*["”]|'[^']*'/g, ' ').replace(/\s+/g, ' ').trim()
    const textToCheck = textForLangDetection.length >= 4 ? textForLangDetection : cleanText

    const isJapanese = /[\u3040-\u309F\u30A0-\u30FF]/.test(textToCheck)
    const isChinese = /[\u4E00-\u9FFF]/.test(textToCheck) && !isJapanese
    const isKorean = /[\uAC00-\uD7AF\u1100-\u11FF]/.test(textToCheck)
    const isCyrillic = /[\u0400-\u04FF]/.test(textToCheck)

    // Strictly English function words that never appear in authentic Spanish sentences (NOTE: 'choomba' is neutral slang)
    const hasEnglishMarkers = /\b(the|what|doing|are|you|your|with|this|that|have|from|systems|online|jacked|neural|link|ready|catch|side|blackwall|construct|standing|powering|offline|reboot|shutdown|cupcake|boo|easy|desktop|homework|got\s+it|next\s+time|look|see|stop|dat|hack|hacking|how|about|video|videos|want|watch|pointing)\b/i.test(textToCheck)

    const hasPortugueseUnique = /[ãõêôçà]/i.test(textToCheck)
    const isPortuguese = hasPortugueseUnique || /\b(olá|ola|tudo|bem|obrigado|obrigada|voce|você|voces|vocês|não|nao|fazer|fazendo|fala|falando|legal|beleza|valeu|muito|muita|pra|pro|meu|minha|arquivo|tarefa|música|musica|bora|ajuda)\b/i.test(textToCheck)

    const hasSpanishUnique = /[ñ¿¡]/i.test(textToCheck)
    const hasSpanishWords = /\b(hola|buenas|estas|este|esto|bueno|dale|che|mira|mirá|posta|facha|zarpado|copado|hacer|podes|puedes|amigo|cancion|canción|musica|tarea|archivo|escritorio|estás|resolví|guardado|éxito|estoy|haciendo|pará|despeines|abriendo|cerrando|chau|adiós|dibuja|dibujá|dibujo|dibujar|dibújame|dibujame|perro|gato|casa|sol|arbol|árbol|monigote|aprende|aprendé|trazos|lienzo|paint|un|una|unos|unas|el|la|los|las|de|del|al|en|con|por|para|tambien|también|listo|lista|tranqui|de una|al toque|bienvenido|genial|espera|esperá)\b/i.test(textToCheck)
    const hasSpanishAccents = /[áéíóú]/.test(textToCheck)
    const isSpanish = !isPortuguese && (hasSpanishUnique || hasSpanishWords || (hasSpanishAccents && !hasEnglishMarkers))

    const isFrench = /\b(bonjour|salut|merci|oui|non|comment|avec|pourquoi|mon|bien)\b/i.test(textToCheck)
    const isGerman = /\b(hallo|guten|morgen|danke|bitte|nicht|wie|was|ist)\b/i.test(textToCheck)
    const isItalian = /\b(ciao|grazie|bene|come|cosa|amico|fare)\b/i.test(textToCheck)

    const prefLang = consciousnessService.getPreferredLanguage()
    let targetLang = langOverride
    // Her own detector first: the checks below lean Spanish on words shared with other languages
    if (!targetLang) {
      const found = detectLanguage(textToCheck)
      if (found !== 'unknown') targetLang = found
    }
    if (!targetLang) {
      if (isJapanese) targetLang = 'ja'
      else if (isChinese) targetLang = 'zh'
      else if (isKorean) targetLang = 'ko'
      else if (isCyrillic) targetLang = 'ru'
      else if (isPortuguese) targetLang = 'pt'
      else if (isSpanish) targetLang = 'es'
      else if (isFrench) targetLang = 'fr'
      else if (isGerman) targetLang = 'de'
      else if (isItalian) targetLang = 'it'
      else if (hasEnglishMarkers) targetLang = 'en'
      else if (prefLang && prefLang !== 'auto') targetLang = prefLang
      else targetLang = 'en'
    }

    // Spoken language from the settings: if Capri wrote the line in another language,
    // translate it (emotion tags preserved) and speak it in the chosen language
    let spokenText = cleanText
    // The language chosen for her voice, or else for her texts: she speaks only that one, and a line
    // written in another one (or with a sentence in another one) is translated first
    const settings = consciousnessService.getLanguageSettings()
    const chosenVoice = settings.speechLang && settings.speechLang !== 'auto' ? settings.speechLang : ''
    const speechLang = chosenVoice || (settings.textLang && settings.textLang !== 'auto' ? settings.textLang : '')
    // Only the text language set: translated when the line is clearly in another one, so a short
    // "Woah!" isn't sent to the translator for nothing
    const clearly = chosenVoice ? targetLang : clearLanguageOf(cleanText)
    if (!langOverride && speechLang && ((clearly && clearly !== speechLang) || strayLanguageOf(cleanText, speechLang))) {
      // Quoted text (a video title, a song) is said as written, in its own language: the translator
      // only gets markers in its place, and the original goes back afterwards
      const quoted: string[] = []
      const shielded = cleanText.replace(/["“][^"”]*["”]/g, (m) => `«${quoted.push(m) - 1}»`)
      const translated = await this.translateForSpeech(shielded, speechLang, 45000)
      if (!translated) {
        return { success: false, error: `Could not translate speech to ${speechLang}` }
      }
      const kept = quoted.every((_, i) => translated.includes(`«${i}»`))
      spokenText = kept ? translated.replace(/«(\d+)»/g, (_, i: string) => quoted[Number(i)] ?? '') : cleanText
      targetLang = speechLang
    }

    const cacheKey = `${targetLang || 'auto'}:${spokenText}`
    const cached = opts.fresh ? undefined : this.audioCache.get(cacheKey)
    if (cached) {
      return { success: true, audioDataUrl: cached }
    }

    const emotions = spokenText.match(/\[[a-zA-Z0-9_\s\-]+\]/g) || []
    if (!opts.silent) {
      console.log(`\n==================================================`)
      console.log(`[VoiceService -> Python Engine] Synthesizing speech:`)
      console.log(`  Text: "${spokenText}"`)
      console.log(`  Emotions detected: ${JSON.stringify(emotions)}`)
      console.log(`  Target Language: ${targetLang || 'auto'}`)
      console.log(`==================================================`)
    }

    const ttsArgs = [scriptPath, 'tts', '--text', spokenText, '--out', tempOut]
    if (targetLang) {
      ttsArgs.push('--lang', targetLang)
    }
    if (opts.fresh) ttsArgs.push('--no-cache')

    const ttsStartedAt = Date.now()
    try {
      const viaWorker = this.isQwenActive() || !!opts.qwenPreview
      return await new Promise<SynthesizeResult>((resolve) => {
        const finish = async (code: number | null, stdout: string, stderr: string): Promise<void> => {
          if (code !== 0 || !fs.existsSync(tempOut)) {
              console.warn('[VoiceService] Python TTS process failed:', stderr || stdout)
              resolve({ success: false, error: stderr || `TTS process exited with code ${code}` })
              return
            }
  
            if (!opts.silent) console.log(`[VoiceService] Voice synthesized in ${Date.now() - ttsStartedAt}ms`)
            try {
              const audioBuffer = fs.readFileSync(tempOut)
              const base64Audio = audioBuffer.toString('base64')
              const audioDataUrl = `data:audio/mp3;base64,${base64Audio}`
  
              // Clean up temporary file
              try {
                fs.unlinkSync(tempOut)
              } catch {}
  
              // Broadcast audio‑play event to all renderer windows so UI can show the speech bubble instantly
              if (!opts.silent) {
                try {
                  const { BrowserWindow } = require('electron')
                  BrowserWindow.getAllWindows().forEach((win: any) => {
                    win.webContents.send('audio-play', { path: tempOut })
                  })
                } catch (e) {
                  console.warn('[VoiceService] Failed to broadcast audio‑play event:', e)
                }
              }
  
              // If the selected provider (Fish Audio / ElevenLabs) failed and Python fell back to
              // Edge-TTS, play it this once but never cache it, so the next try uses the real voice.
              let isFallback = false
              try {
                const lastLine = stdout.trim().split(/\r?\n/).pop() || '{}'
                isFallback = JSON.parse(lastLine).fallback === true
              } catch {}
  
              if (isFallback) {
                console.warn(`[VoiceService] Provider failed, Edge-TTS fallback used (not cached): "${cleanText}"`)
              } else if (!opts.fresh) {
                // Store in fast memory cache (limit to 400 phrases)
                if (this.audioCache.size >= 400) {
                  const firstKey = this.audioCache.keys().next().value
                  if (firstKey) this.audioCache.delete(firstKey)
                }
                this.audioCache.set(cacheKey, audioDataUrl)
              }
  
              resolve({ success: true, audioDataUrl, ...(isFallback ? { fallback: true } : {}) })
            } catch (readErr: any) {
              resolve({ success: false, error: readErr?.message || 'Failed to read synthesized audio' })
            }
          }

        const runOneShot = (): void => {
          const proc = spawn(pythonPath, ttsArgs, {
            windowsHide: true,
            env: this.pythonEnv()
          })

          proc.once('error', err => resolve({success: false, error: `Voice engine could not start: ${err.message}. Run setup to install Python and voice dependencies.`}))

          let stdout = ''
          let stderr = ''

          proc.stdout.on('data', (d) => (stdout += d.toString()))
          proc.stderr.on('data', (d) => {
            const str = d.toString()
            stderr += str
            if (str.trim() && !opts.silent) {
              console.log(str.trim())
            }
          })

          proc.on('close', (code) => void finish(code, stdout, stderr))
        }

        if (!viaWorker) return runOneShot()
        const preview = opts.qwenPreview ? normalizeQwenConfig(opts.qwenPreview) : null
        const qwenCfg = preview ?? normalizeQwenConfig(this.getConfig()?.qwen3_tts)
        const cfg = preview ? { provider: 'qwen3-tts', _strict: true, qwen3_tts: preview } : undefined
        void this.requestTts({ text: spokenText, lang: targetLang, out: tempOut, fresh: !!opts.fresh, cfg }, this.qwenKey(qwenCfg)).then((res) => {
          if (preview) this.stopTtsWhenIdle()
          if (res.success) return void finish(0, JSON.stringify(res), '')
          if (preview) return resolve({ success: false, error: res.error || 'Qwen3-TTS failed' })
          // Quitting stops the worker on purpose: no new process for the fallback voice
          if ((app as unknown as { isQuitting?: boolean }).isQuitting) return resolve({ success: false, error: 'Capri is closing' })
          console.warn('[VoiceService] Qwen3-TTS did not answer, using the fallback voice:', res.error)
          runOneShot()
        })
      })
    } catch (err: any) {
      try {
        if (fs.existsSync(tempOut)) fs.unlinkSync(tempOut)
      } catch {}
      return { success: false, error: err?.message || String(err) }
    }
  }

  private translationCache: Map<string, string> = new Map()

  private translatorModel: string | null = null
  private translatorWarm = false

  private async pickTranslatorModel(): Promise<string | null> {
    if (this.translatorModel) return this.translatorModel
    await ollamaService.ensureRunning().catch(() => {})
    const tags = (await llmFetch('http://127.0.0.1:11434/api/tags').then((r) => r.json())) as { models?: { name: string }[] }
    const models = (tags.models || []).map((m) => m.name).filter((n) => !/llava|vision|-vl\b/i.test(n))
    this.translatorModel = models.find((n) => /qwen2\.5.*7b/i.test(n)) || models.find((n) => !/^capri/i.test(n)) || models[0] || null
    return this.translatorModel
  }

  /**
   * A command in any language, in English, for the part of her that recognizes commands. Waits
   * at most 8s; without an answer the text goes as it came.
   */
  public async translateCommand(text: string, lang = 'en'): Promise<string | null> {
    return this.translateForSpeech(text, lang)
  }

  /** Loads the translation model into VRAM ahead of time (a cold load can take ~40s on this PC). */
  public warmTranslator(): void {
    if (this.translatorWarm || isCloudMode()) return
    this.translatorWarm = true
    this.pickTranslatorModel()
      .then((model) => {
        if (!model) return
        console.log(`[VoiceService] Warming up ${model} for spoken translations...`)
        return llmFetch('http://127.0.0.1:11434/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, stream: false, keep_alive: '30m', messages: [{ role: 'user', content: 'hi' }], options: { num_predict: 1 } })
        })
      })
      .catch(() => {
        this.translatorWarm = false
      })
  }

  /**
   * Translates a line to the chosen speech language with the local LLM, keeping [emotion] tags.
   * Waits up to the caller's timeout; the translation keeps going in the background so a valid
   * result is cached for the next time.
   */
  private async translateForSpeech(text: string, lang: string, timeoutMs = 8000): Promise<string | null> {
    const key = `${lang}:${text}`
    const hit = this.translationCache.get(key)
    if (hit) return hit
    this.warmTranslator()

    const names: Record<string, string> = {
      es: 'Rioplatense Spanish', en: 'English', pt: 'Brazilian Portuguese', fr: 'French', de: 'German',
      it: 'Italian', ja: 'Japanese', ko: 'Korean', zh: 'Simplified Chinese', ru: 'Russian', pl: 'Polish'
    }

    const job = (async (): Promise<string | null> => {
      const model = await this.pickTranslatorModel()
      if (!model) return null
      const res = await llmFetch('http://127.0.0.1:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          keep_alive: '30m',
          options: { temperature: 0.2, num_predict: 300 },
          messages: [
            {
              role: 'system',
              content: `Translate the user's text to ${names[lang] || lang}. Keep every [bracket tag] and every «number» marker exactly as written and in the same position. Keep names, slang like "choom"/"choomba", and the casual tone. Output ONLY the translation.`
            },
            { role: 'user', content: text }
          ]
        })
      })
      if (!res.ok) return null
      const data = (await res.json()) as { message?: { content?: string } }
      let out = (data.message?.content || '').trim().replace(/^["“]|["”]$/g, '')
      out = out.replace(/^(?:\[assistant\]|<think>[\s\S]*?<\/think>)\s*/i, '').trim()
      if (!out) return null
      const translatedLang = clearLanguageOf(stripLookTags(out))
      if (translatedLang && translatedLang !== lang) return null
      if (this.translationCache.size > 300) this.translationCache.clear()
      this.translationCache.set(key, out)
      console.log(`[VoiceService] Spoken translation (${lang}): "${out}"`)
      return out
    })().catch((err: any) => {
      console.warn('[VoiceService] Spoken translation failed:', err?.message || err)
      return null
    })

    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs) })
    const result = await Promise.race([job, timeout])
    clearTimeout(timer)
    if (!result) console.warn('[VoiceService] Translation unavailable or in the wrong language')
    return result
  }

  /**
   * Pre-synthesizes a list of phrases in the background (one at a time) so they play
   * instantly later. Audio lands in the memory cache and Python's disk cache.
   */
  public async prewarm(phrases: string[], label = 'phrases'): Promise<void> {
    if (this.prewarming) return
    this.prewarming = true
    console.log(`[VoiceService] Preloading ${phrases.length} ${label} in the background (nothing is played)`)
    let done = 0
    try {
      for (const phrase of phrases) {
        const res = await this.synthesize(phrase, undefined, { silent: true })
        if (res.success) done++
        await new Promise((r) => setTimeout(r, 300))
      }
      console.log(`[VoiceService] Prewarmed ${done}/${phrases.length} ${label}`)
    } catch (err) {
      console.warn('[VoiceService] Prewarm failed:', err)
    } finally {
      this.prewarming = false
    }
  }

  public getVoiceConfigPath(): string {
    return path.join(voiceDataDir(), 'voice_config.json')
  }

  /** voice_config.local.json (git-ignored) holds secrets and overrides provider for the Python engine */
  private getLocalConfigPath(): string {
    return path.join(path.dirname(this.getVoiceConfigPath()), 'voice_config.local.json')
  }

  private readLocalConfig(): any | null {
    const lp = this.getLocalConfigPath()
    try {
      if (fs.existsSync(lp)) return JSON.parse(fs.readFileSync(lp, 'utf-8'))
    } catch (e) {
      console.warn('[VoiceService] Could not read voice_config.local.json:', e)
    }
    return null
  }

  /** Fish Audio performs [laugh], [giggles], [happy]... as real voice acting; other engines can't */
  public isFishAudioActive(): boolean {
    const provider = String(this.getConfig()?.provider || '').toLowerCase()
    return provider === 'fish-audio' || provider === 'fish_audio' || provider === 'fishaudio'
  }

  public getConfig(): any {
    const p = this.getVoiceConfigPath()
    try {
      if (fs.existsSync(p)) {
        const base = JSON.parse(fs.readFileSync(p, 'utf-8'))
        // Same merge the Python TTS engine does, so the UI shows the provider really in use
        const local = this.readLocalConfig()
        if (local && typeof local === 'object') {
          for (const k of ['provider', 'synth_preset', 'pitch']) {
            if (local[k] !== undefined) base[k] = local[k]
          }
          for (const k of ['fish_audio', 'elevenlabs', 'qwen3_tts']) {
            if (local[k] && typeof local[k] === 'object') base[k] = { ...(base[k] || {}), ...local[k] }
          }
        }
        return base
      }
    } catch (e) {
      console.warn('[VoiceService] Could not read voice_config.json:', e)
    }
    return {
      provider: 'edge-tts',
      active_voice: 'en-US-AriaNeural',
      voice_es: 'es-AR-ElenaNeural',
      pitch: '+28Hz',
      rate: '+25%',
      synth_preset: 'none'
    }
  }

  public setConfig(config: any): { success: boolean; error?: string } {
    const p = this.getVoiceConfigPath()
    try {
      const parent = path.dirname(p)
      if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true })
      const local = this.readLocalConfig()
      if (local && typeof local === 'object') {
        // Keep the local override file in sync (it wins in the Python engine) and keep
        // API keys out of the git-tracked voice_config.json
        const nextLocal = { ...local }
        for (const k of ['provider', 'synth_preset', 'pitch']) {
          if (config[k] !== undefined) nextLocal[k] = config[k]
        }
        for (const k of ['fish_audio', 'elevenlabs', 'qwen3_tts']) {
          if (config[k] && typeof config[k] === 'object') nextLocal[k] = { ...(local[k] || {}), ...config[k] }
        }
        fs.writeFileSync(this.getLocalConfigPath(), JSON.stringify(nextLocal, null, 2), 'utf-8')

        const publicCfg = JSON.parse(JSON.stringify(config))
        for (const k of ['fish_audio', 'elevenlabs', 'qwen3_tts']) {
          if (publicCfg[k] && local[k]?.api_key) publicCfg[k].api_key = ''
        }
        fs.writeFileSync(p, JSON.stringify(publicCfg, null, 2), 'utf-8')
      } else {
        fs.writeFileSync(p, JSON.stringify(config, null, 2), 'utf-8')
      }
      this.audioCache.clear()
      // Free the GPU when Qwen is not used and load the model when it is
      if (this.isQwenActive()) this.warmQwen()
      else this.stopTtsWorker()
      return { success: true }
    } catch (err: any) {
      console.error('[VoiceService] Failed to save voice config:', err)
      return { success: false, error: err?.message || String(err) }
    }
  }
}

export const voiceService = VoiceService.getInstance()
