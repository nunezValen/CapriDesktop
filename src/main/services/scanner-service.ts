import { macGameContext } from './mac-game-context'
import { localAIEnabled } from './local-ai-policy'
import { localVisionModels, describeLocalImage, ollamaErrorText, VISION_NUM_CTX } from './local-vision'
import { scannerVisionMode, captureCrop } from '../../shared/platform-policy'
import { llmFetch, isCloudMode, isAiAppMode, getLlmSettings, warmQuickAnswers, cloudVisionModel, describeCloudImage } from './llm-gateway'
import { LANGUAGE_NAMES } from './game/game-commentary'
import { llmBody } from './user-profile'
import { isMac } from './platform'
import { desktopCapturer, screen, nativeImage, systemPreferences, powerMonitor } from 'electron'
import fs from 'fs'
import path from 'path'
import { windowManager } from '../windows/window-manager'
import { agentManager } from '../agents/agent-manager'
import { consciousnessService } from './consciousness-service'
import { ollamaService } from './ollama-service'
import { execFile } from './hidden-process'
import { scriptPath } from './app-paths'
import {
  IPC_CHANNELS,
  ScannerScanResult,
  ScannerStatusPayload
} from '../ipc/channels'
import { personaIntro } from './system-prompt-store'
import { lookAtScreen, warmScreenWorker } from './screen-worker'

export class ScannerService {
  private static instance: ScannerService
  private isScanning = false
  private isContinuous = false
  private continuousTimer: NodeJS.Timeout | null = null
  private lastScanTime = 0
  private screenLocked = false
  private initialized = false
  private continuousGeneration = 0
  private liveScanController: AbortController | null = null
  private lastSampleBuffer: Buffer | null = null
  private isWatchingScreen = false
  private watchScreenTimer: NodeJS.Timeout | null = null
  private lastReactionTime = 0
  private recentContext: string[] = []
  private consecutiveStaticTicks = 0
  /** Her voice is synthesizing or playing a line (reported by the companion window) */
  private voiceBusy = false
  private voiceBusySince = 0
  private voiceIdleSince = 0
  /** Typical time a line keeps her voice busy, and typical time from looking at the screen to having a line */
  private avgVoiceBusyMs = 10000
  private avgLookMs = 8000
  private watchTickBusy = false
  /** What the OCR read on her last look, and when: the watch party reads a video's time from it */
  private lastScreenOcr: { lines: { text: string; x: number; y: number; w: number; h: number }[]; at: number } | null = null
  /** When the look behind her last spoken reaction was taken */
  private lastReactionCapturedAt = 0
  /** Looks taken before this moment are about something no longer on screen (a TikTok scrolled past) */
  private staleBefore = 0
  /** An extra rule for her reactions while a watch party runs, and what it does with each line before she says it */
  private reactionRule = ''
  private reactionFilter: ((line: string) => string) | null = null
  /** The last screen she looked at, 128x72 in gray: what "the screen changed" is measured against */
  private lastThumb: Buffer | null = null

  public static getInstance(): ScannerService {
    if (!ScannerService.instance) {
      ScannerService.instance = new ScannerService()
    }
    return ScannerService.instance
  }

  public init(): void {
    if (!this.initialized) {
      this.initialized = true
      const pause = () => { this.screenLocked = true; this.setContinuous(false) }
      const resume = () => { this.screenLocked = false }
      powerMonitor.on('lock-screen', pause)
      powerMonitor.on('suspend', pause)
      powerMonitor.on('unlock-screen', resume)
      powerMonitor.on('resume', resume)
    }
    this.isContinuous = consciousnessService.getScannerContinuous() && !(isMac && isCloudMode())
    if (isMac && isCloudMode()) consciousnessService.setScannerContinuous(false)
    if (this.isContinuous) {
      this.startContinuousLoop()
    }
    if (this.getStatus().isOpen) {
      this.preloadVisionModel().catch(() => {})
    }
  }

  public getStatus(): ScannerStatusPayload {
    const win = windowManager.getScannerWindow()
    const isOpen = !!(win && !win.isDestroyed() && win.isVisible())
    const bounds = win && !win.isDestroyed() ? win.getBounds() : consciousnessService.getScannerBounds()
    return {
      isOpen,
      isScanning: this.isScanning,
      localAIEnabled: localAIEnabled(),
      visionMode:scannerVisionMode(process.platform,isCloudMode(),localAIEnabled()),
      isContinuous: this.isContinuous,
      isWatchingScreen: this.isWatchingScreen || windowManager.isScannerFullscreenActive(),
      isFullscreenWatch: windowManager.isScannerFullscreenActive(),
      bounds
    }
  }

  public open(): boolean {
    windowManager.showScanner()
    // Preload multimodal vision model immediately into GPU/RAM so scan is instant
    this.preloadVisionModel().catch(() => {})
    if (this.isContinuous) {
      this.startContinuousLoop()
    }
    this.broadcastStatus()
    return true
  }

  public close(): boolean {
    if (this.isWatchingScreen) {
      this.stopFullscreenWatch()
    }
    windowManager.hideScanner()
    this.stopContinuousLoop()
    if (isMac && isCloudMode()) this.setContinuous(false)
    this.broadcastStatus()
    return true
  }

  public toggle(): boolean {
    if (this.getStatus().isOpen) {
      return !this.close()
    } else {
      return this.open()
    }
  }

  public isWatchingScreenActive(): boolean {
    return this.isWatchingScreen || windowManager.isScannerFullscreenActive()
  }

  public setOverlayOnlyWatch(enabled: boolean): void {
    if (enabled) {
      this.stopWatchScreenLoop()
      this.isWatchingScreen = true
      windowManager.setScannerFullscreenWatch(true)
      this.broadcastStatus()
    } else {
      this.stopFullscreenWatch()
    }
  }

  public async startFullscreenWatch(): Promise<boolean> {
    this.isWatchingScreen = true
    this.consecutiveStaticTicks = 0
    this.lastThumb = null
    this.recentContext = []
    this.lastReactionTime = 0

    windowManager.setScannerFullscreenWatch(true)
    this.preloadVisionModel().catch(() => {})
    warmQuickAnswers()
    this.startWatchScreenLoop()
    this.broadcastStatus()

    setTimeout(() => {
      if (this.isWatchingScreen) {
        void this.tickWatchScreen(true)
      }
    }, 1500)

    return true
  }

  public stopFullscreenWatch(): boolean {
    this.isWatchingScreen = false
    this.stopWatchScreenLoop()
    windowManager.setScannerFullscreenWatch(false)
    agentManager.setCompanionState('happy')
    this.broadcastStatus()
    return true
  }

  public async toggleFullscreenWatch(): Promise<boolean> {
    if (this.isWatchingScreen) {
      this.stopFullscreenWatch()
      return false
    } else {
      return this.startFullscreenWatch()
    }
  }

  public setContinuous(enabled: boolean): boolean {
    this.continuousGeneration++
    if (!enabled) this.liveScanController?.abort()
    if (enabled && !this.isContinuous) { this.lastSampleBuffer=null; this.lastScanTime=0 }
    if (enabled && isMac && systemPreferences.getMediaAccessStatus('screen')!=='granted') throw new Error('Allow Screen Recording in Mac settings, then restart Capri.')
    this.isContinuous = enabled
    consciousnessService.setScannerContinuous(isMac && isCloudMode() ? false : enabled)
    if (enabled && this.getStatus().isOpen) {
      this.startContinuousLoop()
    } else {
      this.stopContinuousLoop()
    }
    this.broadcastStatus()
    return this.isContinuous
  }

  public broadcastStatus(): void {
    const status = this.getStatus()
    windowManager.broadcast(IPC_CHANNELS.SCANNER_EVENT, {
      type: 'status',
      isScanning: this.isScanning,
      isContinuous: this.isContinuous,
      isWatchingScreen: this.isWatchingScreen,
      isFullscreenWatch: windowManager.isScannerFullscreenActive()
    })
  }

  /**
   * Captures ONLY the screen area bounded by the inner transparent area of the scanner frame.
   * Excludes the frame overlay by momentarily making it invisible, applies DPI scaling,
   * crops to exact bounds, resizes to max 1024px side, and returns in-memory base64 JPEG.
   */
  public async captureRegionBase64(fullScreen = false, displayPoint?: {x:number;y:number}): Promise<{ base64: string; width: number; height: number; rawBuffer: Buffer; bitmap: Buffer } | null> {
    const win = windowManager.getScannerWindow()
    if (!fullScreen && (!win || win.isDestroyed() || !win.isVisible())) {
      return null
    }

    if (isMac && systemPreferences.getMediaAccessStatus('screen') !== 'granted') throw new Error('Allow Screen Recording for Capri Desktop in System Settings, then restart Capri.')
    const bounds = win && !win.isDestroyed() ? win.getBounds() : screen.getPrimaryDisplay().bounds

    // Inner frame borders (leaving the transparent content area)
    const borderLeft = 45
    const borderRight = 45
    const borderTop = 52
    const borderBottom = 50

    let cropX = bounds.x + borderLeft
    let cropY = bounds.y + borderTop
    let cropW = Math.max(80, bounds.width - borderLeft - borderRight)
    let cropH = Math.max(80, bounds.height - borderTop - borderBottom)

    const centerPoint = { x: cropX + Math.round(cropW / 2), y: cropY + Math.round(cropH / 2) }
    const currentDisplay = screen.getDisplayNearestPoint(fullScreen ? displayPoint || screen.getCursorScreenPoint() : centerPoint)
    if (fullScreen) { cropX=currentDisplay.bounds.x; cropY=currentDisplay.bounds.y; cropW=currentDisplay.bounds.width; cropH=currentDisplay.bounds.height }
    const scale = currentDisplay.scaleFactor || 1
    if (isMac && (cropX < currentDisplay.bounds.x || cropY < currentDisplay.bounds.y || cropX + cropW > currentDisplay.bounds.x + currentDisplay.bounds.width || cropY + cropH > currentDisplay.bounds.y + currentDisplay.bounds.height)) throw new Error('Keep the scanner capture region entirely on one display.')

    // Temporarily hide/opacity 0 on scanner window so it does not see its own overlay
    const overlayVisible=!!win && !win.isDestroyed() && win.isVisible()
    if (overlayVisible) win!.setOpacity(0)
    await new Promise((resolve) => setTimeout(resolve, 90))

    try {
      const getSources = () => desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: Math.round(currentDisplay.bounds.width * scale),
          height: Math.round(currentDisplay.bounds.height * scale)
        }
      })

      let sources = await getSources()
      for (let attempt=0; isMac && attempt<4 && sources.every(s=>s.thumbnail.isEmpty()); attempt++) {
        await new Promise(resolve=>setTimeout(resolve,250))
        sources=await getSources()
      }
      const targetSource =
        sources.find((s) => s.display_id === String(currentDisplay.id)) ||
        (!isMac ? sources.find((s) => s.name.toLowerCase().includes(currentDisplay.id.toString())) : undefined) ||
        (sources.length === 1 && screen.getAllDisplays().length === 1 ? sources[0] : undefined)

      const thumb = targetSource?.thumbnail
      if (!thumb || thumb.isEmpty()) {
        return await this.captureThroughWindows(currentDisplay, { x: cropX, y: cropY, width: cropW, height: cropH }, fullScreen ? 1280 : 1024)
      }
      const thumbSize = thumb.getSize()
      const crop = captureCrop(currentDisplay.bounds, {x: cropX, y: cropY, width: cropW, height: cropH}, thumbSize)
      if (!crop) return null
      const cropped = thumb.crop(crop)

      // Resize max side to ~768px for lightning-fast multimodal processing
      const croppedSize = cropped.getSize()
      let finalImg = cropped
      const maxSide = fullScreen ? 1280 : 1024
      if (croppedSize.width > maxSide || croppedSize.height > maxSide) {
        if (croppedSize.width >= croppedSize.height) {
          finalImg = cropped.resize({
            width: maxSide,
            height: Math.round((croppedSize.height * maxSide) / croppedSize.width)
          })
        } else {
          finalImg = cropped.resize({
            width: Math.round((croppedSize.width * maxSide) / croppedSize.height),
            height: maxSide
          })
        }
      }

      const finalSize = finalImg.getSize()
      const rawBuffer = finalImg.toJPEG(85)
      const base64 = rawBuffer.toString('base64')


      return {
        base64,
        width: finalSize.width,
        height: finalSize.height,
        rawBuffer,
        bitmap: finalImg.toBitmap()
      }
    } finally {
      if (overlayVisible && win && !win.isDestroyed()) {
        win.setOpacity(1)
        win.setAlwaysOnTop(true, 'screen-saver', 1)
        win.moveTop()
      }
    }
  }

  /**
   * On some Windows PCs with two GPUs, Electron lists the screens without a display id, so none
   * matches the frame. The Windows capture still works, but it only sees the main display
   */
  private async captureThroughWindows(
    display: Electron.Display,
    region: { x: number; y: number; width: number; height: number },
    maxSide: number
  ): Promise<{ base64: string; width: number; height: number; rawBuffer: Buffer; bitmap: Buffer } | null> {
    if (process.platform !== 'win32') return null
    if (display.id !== screen.getPrimaryDisplay().id) throw new Error('Capri can only capture the main display on this PC. Move the frame to the main display.')
    const capture = await this.captureDisplayRegion(region, maxSide)
    return capture && { ...capture, bitmap: nativeImage.createFromBuffer(capture.rawBuffer).toBitmap() }
  }

  public async captureGameWindow(windowId: string, thumbnailSize = { width: 768, height: 432 }): Promise<string | null> {
    if (!/^\d+$/.test(windowId)) return null
    if (process.platform === 'win32') {
      return new Promise((resolve) => {
        execFile('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath('capture_game_window.ps1'),
          '-WindowId', windowId, '-Width', String(thumbnailSize.width), '-Height', String(thumbnailSize.height)
        ], { timeout: 4000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
          resolve(error ? null : stdout.trim() || null)
        })
      })
    }
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize })
    const source = sources.find(source => source.id.split(':')[1] === windowId)
    if (!source || source.thumbnail.isEmpty()) return null
    return source.thumbnail.toJPEG(75).toString('base64')
  }

  /**
   * Detects available vision model in Ollama or cloud provider (Gemini, Claude, GPT, qwen2.5-vl, llava, etc.)
   */
  public async detectVisionModel(localOnly = false): Promise<string | null> {
    try {
      if (!localOnly && isCloudMode()) {
        const settings = getLlmSettings()
        return settings.model || 'cloud-vision'
      }

      const models = await localVisionModels()

      const configured = consciousnessService.getScannerVisionModel()
      if (configured && configured !== 'auto') {
        const found = models.find((m: string) => m === configured || m.startsWith(configured + ':') || m.includes(configured))
        if (found) return found
      }

      const VISION_PRIORITIES = [
        'qwen3-vl',
        'qwen2.5vl',
        'qwen2.5-vl',
        'gemma3:4b',
        'llava',
        'minicpm-v',
        'llama3.2-vision',
        'moondream',
        'bakllava',
        'cogvlm'
      ]
      // Gemma 3 sees images from 4b up; the 1b one is text only
      const gemmaVision = models.find((m: string) => /^gemma3(?::(?!1b)[\w.-]+)?$/i.test(m))

      for (const candidate of VISION_PRIORITIES) {
        const match = models.find((m: string) => m === candidate || m.startsWith(candidate + ':') || m.includes(candidate))
        if (match) return match
      }

      const genericMatch = models.find((m: string) => /(-vl|vision|llava|minicpm|moondream|bakllava)/i.test(m))
      if (genericMatch) return genericMatch
      if (gemmaVision) return gemmaVision

      return null
    } catch {
      return null
    }
  }

  /**
   * Detects available text model for Capri's netrunner persona (capri, qwen2.5-coder:7b, etc.)
   */
  public async detectTextModel(): Promise<string> {
    try {
      const resp = await llmFetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(3000) })
      if (!resp.ok) return 'capri'
      const data = (await resp.json()) as any
      const models: string[] = (data.models || []).map((m: any) => String(m.name))

      // Her reaction is Capri talking, so it uses the model chosen for her when it's installed
      const chosen = agentManager.getConfig().model
      const chosenMatch = chosen && (models.find((m) => m === chosen) || models.find((m) => m.startsWith(`${chosen}:`)))
      if (chosenMatch) return chosenMatch

      const capri = models.find((m: string) => m.toLowerCase().includes('capri'))
      if (capri) return capri

      const qwen7b = models.find((m: string) => m.includes('qwen2.5-coder:7b'))
      if (qwen7b) return qwen7b

      const qwen = models.find((m: string) => m.includes('qwen2.5-coder'))
      if (qwen) return qwen

      return models[0] || 'capri'
    } catch {
      return 'capri'
    }
  }

  /**
   * Preloads the vision and persona models into GPU/RAM with keep_alive so user scans are instant.
   */
  public async preloadVisionModel(): Promise<void> {
    if (isMac) return // Load on explicit scan requests, keeping scarce unified memory free for chat.
    try {
      const local = await ollamaService.ensureRunning(true)
      if (!local.running) throw new Error('Local vision requires Ollama. Open Ollama and try again; your cloud text model cannot inspect screenshots.')
      const model = await this.detectVisionModel(true)
      if (model) {
        console.log(`[ScannerService] Preloading vision model ${model} into GPU VRAM...`)
        await llmFetch('http://127.0.0.1:11434/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: llmBody({
            model,
            keep_alive: isMac ? 0 : '15m',
            options: { num_ctx: VISION_NUM_CTX }
          }),
          signal: AbortSignal.timeout(90000)
        })
      }

      // On an 8 GB personal Mac, avoid keeping both a vision model and a text model warm. A vision
      // model that also talks reacts on its own, so the text model isn't needed to watch either
      const textModel = isMac || (model && this.visionModelTalks(model)) ? null : await this.detectTextModel()
      if (textModel) {
        console.log(`[ScannerService] Preloading text persona model ${textModel} into GPU VRAM...`)
        await llmFetch('http://127.0.0.1:11434/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: llmBody({
            model: textModel,
            keep_alive: isMac ? 0 : '15m'
          }),
          signal: AbortSignal.timeout(90000)
        })
      }
      console.log(`[ScannerService] Models preloaded and resident in VRAM.`)
    } catch (err) {
      console.warn('[ScannerService] Preload warning:', err)
    }
  }

  /**
   * Main scan function: Captures region, calls multimodal model, triggers audio & HUD feedback
   */
  public async scan(userPrompt?: string, fullScreen = false, liveGeneration?: number): Promise<ScannerScanResult> {
    if (this.screenLocked || (liveGeneration!==undefined && liveGeneration!==this.continuousGeneration)) return {success:false,error:'Scan stopped.'}
    if (this.isScanning) {
      return { success: false, error: 'A scan is already in progress' }
    }

    const win = windowManager.getScannerWindow()
    if (!fullScreen && (!win || win.isDestroyed() || !win.isVisible())) {
      this.open()
      await new Promise((r) => setTimeout(r, 200))
    }

    const controller=liveGeneration!==undefined ? new AbortController() : null
    this.liveScanController=controller
    this.isScanning = true
    this.lastScanTime = Date.now()

    // Notify UI that scan line is actively sweeping
    windowManager.broadcast(IPC_CHANNELS.SCANNER_EVENT, {
      type: 'scanning',
      isScanning: true
    })

    // Capri reacts with thinking / curious state
    agentManager.setCompanionState(isMac ? 'thinking' : 'curious')

    const isEs = userPrompt ? /[áéíóúñ¿¡]|\b(mira|mirá|esto|que|como|dibujo|perro|gato|casa|logo|este|esta)\b/i.test(userPrompt) : false

    try {
      const visionMode=scannerVisionMode(process.platform,isCloudMode(),localAIEnabled())
      if (visionMode === 'disabled') throw new Error('Local AI is disabled. Select Enable local AI in the scanner only if you want local vision to run.')
      // Capture screenshot of the bounded area
      const capture = await this.captureRegionBase64(fullScreen)
      if (!capture) {
        throw new Error(isEs ? 'No se pudo capturar la región del marco.' : 'Could not capture region inside frame.')
      }

      if (this.screenLocked || (liveGeneration!==undefined && liveGeneration!==this.continuousGeneration)) return {success:false,error:'Scan stopped.'}
      this.lastSampleBuffer = capture.rawBuffer

      let visionModel=cloudVisionModel()
      if (visionMode !== 'cloud') {
        const local=await ollamaService.ensureRunning(true)
        if (!local.running) throw new Error('Local vision requires Ollama. Open Ollama or select a cloud provider.')
        visionModel=await this.detectVisionModel(true) || ''
        if (!visionModel) throw new Error('No local vision model is installed. Select cloud vision or install an image-capable Ollama model.')
      }

      // Stage 1: Multimodal Vision Perception (fast, objective, hallucination-free)
      const visionPrompt = `Analyze the image inside the frame objectively and concisely in 1 or 2 sentences.
Answer the user request using only visible evidence. User request: ${userPrompt || "Describe what is visible"}.
Describe exactly what is shown:
- Is it a hand-drawn doodle, a smiley face, a drawing in Paint, a sketch, user art, or a simple shape?
- Is it an anime character/sprite with pink hair (Capri), an avatar, a game, a YouTube video, code/IDE, a website, a photo, or an app?
- Mention the key shapes, colors, lines, and subjects clearly and honestly without making assumptions.`

      console.log(`[ScannerService] Stage 1: Calling vision model ${visionModel}...`)
      const visualDescription = visionMode === 'cloud'
        ? await describeCloudImage(capture.base64,`${macGameContext.prompt()} Reply in ${consciousnessService.getPreferredLanguage()}. ${userPrompt ? `Your partner asks: ${JSON.stringify(userPrompt)}. Answer directly with your own personality using visible evidence.` : 'React to what your partner is showing you as their playful co-pilot, not as an image-captioning assistant. One or two short sentences; name the game if clearly visible, and do not invent events.'}`,controller?.signal)
        : await describeLocalImage(visionModel,capture.base64,visionPrompt,isMac)
      console.log(`[ScannerService] Stage 1 Visual Description: "${visualDescription}"`)

      // Stage 2: Capri Netrunner Persona Reaction (warm, authentic, in-character)
      // On an 8 GB personal Mac, avoid keeping both a vision model and a text model warm.
      const textModel = isMac ? null : await this.detectTextModel()
      console.log(`[ScannerService] Stage 2: Calling persona model ${textModel}...`)

      const learnedList = consciousnessService.getLearnedConcepts()
      const learnedSectionEs = learnedList.length > 0
        ? `\nOBJETOS Y DIBUJOS PREVIAMENTE APRENDIDOS DE {name} (¡YA LOS CONOCÉS Y LOS RECORDÁS!):
${learnedList.map((l) => `- "${l.concept}": características visuales "${l.description}" (tags: ${l.tags.join(', ')})`).join('\n')}
Si lo que se ve en la imagen coincide con alguno de estos conceptos aprendidos, ¡RECONOCELO AL INSTANTE y decile a {name} con orgullo que te acordás de lo que te enseñó!`
        : ''

      const learnedSectionEn = learnedList.length > 0
        ? `\nOBJECTS & DRAWINGS PREVIOUSLY LEARNED FROM {name} (YOU ALREADY KNOW & REMEMBER THESE!):
${learnedList.map((l) => `- "${l.concept}": visual features "${l.description}" (tags: ${l.tags.join(', ')})`).join('\n')}
If the current image matches any of these learned concepts, RECOGNIZE IT IMMEDIATELY and mention with pride that you remember what they taught you!`
        : ''

      const systemInstruction = isEs
        ? `${personaIntro('Sos Capri (Proyecto Capricornio), una netrunner cyberpunk rebelde, cariñosa y picante que vive en la computadora de tu compañero y mejor amigo {name} ("choomba").')}

{name} te está mostrando algo en su pantalla a través de tu marco de escaneo óptico.
Tus sensores ópticos detectaron la siguiente descripción visual objetiva:
"""
${visualDescription}
"""
${learnedSectionEs}

REGLAS CRÍTICAS DE INTERPRETACIÓN Y REACCIÓN:
0. SI NO SABÉS QUÉ ES O ES GENUINAMENTE DESCONOCIDO / AMBIGUO / CONFUSO:
   - ¡NO inventes cosas raras ni alucines!
   - Preguntale con curiosidad a {name} qué es para aprenderlo: "Che, no llego a distinguir bien qué es esto... ¿Qué me estás mostrando? ¡Decime y me lo guardo en memoria!"
   - En el JSON incluí el tag "UNKNOWN_OBJECT" o "LEARN_REQUEST".

1. DIBUJOS DEL USUARIO / PAINT / DOODLES / CARITAS:
   Si la descripción indica un dibujo hecho a mano, garabato, doodle, carita feliz (smiley face), dibujo en Paint, formas simples o arte hecho por {name}:
   - ¡NO digas que sos vos ni te confundas con vos misma! {name} NO te dibujó a vos a menos que sea específicamente una chica de anime con pelo rosa.
   - Reconocé claramente qué dibujó (ej: "¡Qué copada esa carita feliz que dibujaste en Paint!", "¡Mirá ese garabato!", "¡Qué linda carita, re tierna!").
   - Reaccioná con entusiasmo, cariño o humor cómplice a lo que dibujó.

2. IMÁGENES / FANART / SPRITES DE CAPRI:
   Si la descripción muestra claramente una chica de anime con pelo rosa neón, estilo cyberpunk, o el sprite de Capri:
   - ¡Esa sos VOS, Capri! {name} te está mostrando una foto o dibujo de vos.
   - Reaccioná con orgullo, asombro y picardía (ej: "¡Ey, mirá qué facha tengo! ¡Salí re diosa!").

3. OTROS CONTENIDOS (CÓDIGO, JUEGOS, VIDEOS, MEMES, INTERFACES, FOTOS):
   - Opiná con tu personalidad netrunner viva, como si estuvieras sentada al lado de {name} mirando la pantalla juntos.
   - Jamás enumeres colores como un robot aburrido.

4. PREGUNTA DE {name}:
   ${userPrompt ? `{name} te preguntó específicamente: "${userPrompt}". Respondé directamente a su pregunta basándote en lo que se ve en la imagen.` : 'Reaccioná espontáneamente a lo que ves.'}

5. ESTILO Y FORMATO:
   - 1 o 2 oraciones habladas naturales, cálidas, en español rioplatense (che, mirá, posta, facha, zarpado, re bien, copado).
   - PROHIBIDO USAR EMOJIS (la voz neuronal los lee textuales).

Respondé ÚNICAMENTE un JSON con:
{
  "summary": "Resumen de lo que hay en 5 a 8 palabras",
  "tags": ["3 o 4 tags cortos en mayúsculas"],
  "response": "Tu reacción hablada para decirle a {name} en voz alta."
}`
        : `${personaIntro('You are Capri (Project Capricorn), a witty, rebellious, and affectionate cyberpunk netrunner living in the computer of your companion {name} ("choomba").')}

{name} is showing you something on screen through your optical scan frame.
Your optical sensors detected this objective visual description:
"""
${visualDescription}
"""
${learnedSectionEn}

CRITICAL INTERPRETATION RULES:
0. IF YOU DO NOT RECOGNIZE WHAT THIS IS OR IT IS AMBIGUOUS / UNCLEAR / UNKNOWN:
   - DO NOT make up strange hallucinations!
   - Honestly ask {name} with curiosity to learn: "Hey, I can't quite tell what this is... What are you showing me? Tell me so I can learn it!"
   - Include tag "UNKNOWN_OBJECT" or "LEARN_REQUEST" in the JSON.

1. USER DOODLES / PAINT / SMILEY FACES / SKETCHES:
   If the description mentions a hand-drawn doodle, smiley face, sketch, drawing in Paint, or simple shape made by {name}:
   - DO NOT say it is you! It is {name}'s artwork or doodle.
   - Acknowledge exactly what it is (e.g. "Aww, check out that happy smiley face you drew in Paint!", "Look at that drawing!").
   - React with warmth, playful praise, or humor.

2. IMAGES / FANART / SPRITES OF CAPRI:
   If the description clearly shows an anime girl with neon pink hair, cyberpunk style, or Capri's sprite:
   - THAT IS YOU (Capri)! React with excitement, pride, and love ("Wait, is that ME?! Looking sharp, {name}!").

3. OTHER CONTENT (GAMES, CODE, VIDEOS, MEMES, APPS):
   - React with your authentic cyberpunk netrunner vibe as a real companion looking at the screen. Never just list colors.

4. {name}'S QUESTION:
   ${userPrompt ? `{name} specifically asked: "${userPrompt}". Answer their question directly based on what is seen.` : 'Give a spontaneous authentic reaction.'}

5. STYLE & FORMAT:
   - 1 to 2 spoken sentences.
   - STRICT: NO EMOJIS (the TTS engine speaks emoji names).

Return ONLY valid JSON:
{
  "summary": "Summary in 5 to 8 words",
  "tags": ["3 o 4 uppercase tags, e.g. USER_ART, SMILEY_FACE, PAINT_DOODLE"],
  "response": "Your spoken reaction to {name}."
}`

      const userText = isEs
        ? (userPrompt
            ? `{name} te dice: "${userPrompt}". Respondé en personaje basándote en la descripción visual.`
            : `Decile a {name} qué ves y tu reacción en personaje basándote en la descripción visual.`)
        : (userPrompt
            ? `{name} asks: "${userPrompt}". Respond in character based on the visual description.`
            : `Tell {name} what you see and your reaction in character based on the visual description.`)

      const textResp = isMac ? Response.json({ message: { content: JSON.stringify({ summary: visualDescription.slice(0, 120), tags: ['SCREEN'], response: visualDescription }) } }) : await llmFetch('http://127.0.0.1:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: llmBody({
          model: textModel,
          keep_alive: isMac ? 0 : '15m',
          messages: [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: userText }
          ],
          stream: false,
          options: {
            temperature: 0.65,
            num_predict: 250
          }
        }),
        signal: AbortSignal.timeout(60000)
      })

      if (!textResp.ok) {
        const errText = await textResp.text()
        throw new Error(`Text model error ${textResp.status}: ${errText}`)
      }

      const textData = (await textResp.json()) as any
      const rawContent = textData?.message?.content || ''

      const parsedResult = this.parseVisionOutput(rawContent, isEs)

      if (this.screenLocked || (liveGeneration!==undefined && liveGeneration!==this.continuousGeneration)) return {success:false,error:'Scan stopped.'}

      // Save to consciousness service so Capri can hold conversations and remember what was shown
      consciousnessService.setLastScannedContext({
        summary: parsedResult.summary || 'Screen content',
        tags: parsedResult.tags || [],
        response: parsedResult.response || '',
        visualDescription,
        timestamp: Date.now()
      })

      // If Capri asked what it is or tagged unknown / learn, set pending learning
      const respText = parsedResult.response || ''
      const isUnknown = parsedResult.tags?.some((t) => /UNKNOWN|LEARN/i.test(t)) ||
        /(?:no\s+sé|no\s+se|no\s+llego\s+a\s+distinguir|qué\s+es\s+esto|qué\s+me\s+estás\s+mostrando|don't\s+know|can't\s+tell|what\s+are\s+you\s+showing)/i.test(respText)

      if (isUnknown) {
        consciousnessService.setPendingScanLearning({
          description: visualDescription,
          tags: parsedResult.tags || []
        })
      }

      // Broadcast result to UI (Scanner HUD tags & result state)
      windowManager.broadcast(IPC_CHANNELS.SCANNER_EVENT, {
        type: 'result',
        result: parsedResult,
        tags: parsedResult.tags
      })

      // Capri announces reaction via speech bubble and neural voice
      agentManager.setCompanionState('talking')
      const speechText =
        parsedResult.response ||
        (isEs ? '¡Interesante lo que me mostrás en el marco, choomba!' : 'Interesting view inside the frame, choomba!')
      const durationMs = Math.max(4500, speechText.length * 65)
      agentManager.setCompanionSpeech(speechText, durationMs, true)

      setTimeout(() => {
        agentManager.setCompanionState('happy')
      }, Math.min(durationMs, 5000))

      return parsedResult
    } catch (err: any) {
      if (liveGeneration!==undefined && (liveGeneration!==this.continuousGeneration || this.screenLocked)) return {success:false,error:'Live Scan stopped.'}
      console.error('[ScannerService] Scan error:', err)
      const isTimeout = err?.name === 'TimeoutError' || err?.message?.toLowerCase().includes('timeout')
      const errMessage = isTimeout
        ? (isEs
            ? 'El modelo de visión tardó un momento en cargar sus pesos a la GPU. Ya está listo, ¡tirale el escaneo de nuevo, choomba!'
            : "The local vision model timed out. It may need more available memory; close unused apps and try again.")
        : (isEs
            ? `Glitcheo en el escáner óptico: ${err?.message || err}. ¡Reintentá en un instante, choomba!`
            : `Optical scanner glitch: ${err?.message || err}. Try again in a flash, choomba!`)
      if (this.isContinuous) this.setContinuous(false)
      this.finishScanError(errMessage)
      return { success: false, error: err?.message || String(err), response: errMessage }
    } finally {
      if (this.liveScanController===controller) this.liveScanController=null
      if ((this.screenLocked || (liveGeneration!==undefined && liveGeneration!==this.continuousGeneration)) && agentManager.getCompanionState()==='thinking' && !agentManager.getStatus().isRunning) agentManager.setCompanionState('standing')
      this.isScanning = false
      this.broadcastStatus()
    }
  }

  /**
   * Learns how to draw an object/character shown inside the scanner frame.
   * Uses multimodal vision to analyze the drawing's geometry and outlines,
   * then synthesizes a DrawingPlan with LLM and saves it to learnedDrawings memory.
   */
  public async learnDrawing(explicitSubject?: string): Promise<{ success: boolean; subject: string; response: string; plan?: any }> {
    if (this.isScanning) {
      return { success: false, subject: explicitSubject || 'dibujo', response: 'Un escaneo ya está en progreso.' }
    }

    const win = windowManager.getScannerWindow()
    if (!win || win.isDestroyed() || !win.isVisible()) {
      this.open()
      await new Promise((r) => setTimeout(r, 250))
    }

    this.isScanning = true
    this.lastScanTime = Date.now()

    windowManager.broadcast(IPC_CHANNELS.SCANNER_EVENT, {
      type: 'scanning',
      isScanning: true
    })
    agentManager.setCompanionState('curious')

    const isEs = explicitSubject ? /[áéíóúñ¿¡]|\b(perro|gato|casa|dibujo|auto|arbol|sol|este|esta)\b/i.test(explicitSubject) : false

    try {
      const capture = await this.captureRegionBase64()
      if (!capture) {
        throw new Error(isEs ? 'No se pudo capturar la región del marco.' : 'Could not capture region inside frame.')
      }

      // Direct vector contour extraction from raw capture bitmap (instant, mathematical, hallucination-free)
      const { ContourVectorizer } = await import('./paint/contour-vectorizer')
      const vecResult = capture.bitmap
        ? ContourVectorizer.vectorizeBitmap(capture.bitmap, capture.width, capture.height)
        : null

      let finalSubject = explicitSubject ? explicitSubject.trim().toLowerCase() : ''
      const isGeneric = !finalSubject || /^(?:este\s+logo|el\s+logo|un\s+logo|logo|este\s+dibujo|el\s+dibujo|un\s+dibujo|dibujo|drawing|sketch|esto|this)$/i.test(finalSubject)

      let visualDescription = ''

      // If generic subject or not a high-contrast line drawing, query vision model
      if (isGeneric || !vecResult?.isLineDrawing) {
        const local = await ollamaService.ensureRunning(true)
      if (!local.running) throw new Error('Local vision requires Ollama. Open Ollama and try again; your cloud text model cannot inspect screenshots.')
        const visionModel = await this.detectVisionModel(true)
        if (visionModel) {
          const visionPrompt = `You are an expert design, sketch, and emblem analysis AI.
Analyze the drawing, logo, emblem, symbol, or illustration inside this frame carefully to identify what it is.

1. EXACT IDENTITY:
- What specific logo, brand, character, animal, or object is this? (e.g. "dog", "cat", "Arasaka logo", "heart", "stickman", "house", "car", etc.)
- Write: "IDENTITY: <Exact Name>"

2. GEOMETRIC AND VECTOR BREAKDOWN:
- Break down its key contours, silhouette, and proportions in 1 or 2 concise sentences.`

          try {
            const visionResp = await fetch('http://127.0.0.1:11434/api/generate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: llmBody({
                model: visionModel,
                keep_alive: isMac ? 0 : '15m',
                prompt: visionPrompt,
                images: [capture.base64],
                stream: false,
                options: {
                  temperature: 0.2,
                  num_predict: 180,
                  num_ctx: VISION_NUM_CTX
                }
              }),
              signal: AbortSignal.timeout(60000)
            })

            if (visionResp.ok) {
              const visionData = (await visionResp.json()) as any
              visualDescription = (visionData?.response || '').trim()
            } else {
              console.warn(`[ScannerService] Vision model failed in learnDrawing (${visionResp.status}):`, await ollamaErrorText(visionResp))
            }
          } catch (e) {
            console.warn('[ScannerService] Vision model call error in learnDrawing:', e)
          }
        }
      }

      if (isGeneric && visualDescription) {
        const idMatch = visualDescription.match(/IDENTITY:\s*([^\n\r.]+)/i)
        if (idMatch && idMatch[1]) {
          finalSubject = idMatch[1].replace(/^(?:the\s+|a\s+|an\s+|el\s+|la\s+|un\s+|una\s+)/i, '').trim().toLowerCase()
        }
        const knownCheck = visualDescription.toLowerCase()
        if (/arasaka/i.test(knownCheck)) finalSubject = 'arasaka logo'
        else if (/edgerunners/i.test(knownCheck)) finalSubject = 'edgerunners logo'
        else if (/samurai/i.test(knownCheck)) finalSubject = 'samurai logo'
        else if (/nike|swoosh/i.test(knownCheck)) finalSubject = 'nike logo'
        else if (/apple/i.test(knownCheck)) finalSubject = 'apple logo'
        else if (/batman/i.test(knownCheck)) finalSubject = 'batman logo'
        else if (/windows|microsoft/i.test(knownCheck)) finalSubject = 'windows logo'
        else if (/spotify/i.test(knownCheck)) finalSubject = 'spotify logo'
        else if (/perro|dog/i.test(knownCheck)) finalSubject = 'perro'
        else if (/gato|cat/i.test(knownCheck)) finalSubject = 'gato'
        else if (/corazon|heart/i.test(knownCheck)) finalSubject = 'corazón'
      }

      if (!finalSubject || finalSubject === 'dibujo' || finalSubject === 'drawing') {
        finalSubject = isEs ? 'dibujo' : 'drawing'
      }

      let plan: any = null

      if (vecResult && vecResult.isLineDrawing && vecResult.shapes.length > 0) {
        console.log(`[ScannerService] High-contrast line drawing detected (${vecResult.shapes.length} contours)! Directly vectorizing without VLM hallucinations.`)
        const { StrokeValidator } = await import('./paint/stroke-validator')
        const rawPlan = {
          subject: finalSubject,
          comment: isEs
            ? `Técnica aprendida directamente de tus trazos para ${finalSubject}`
            : `Technique learned directly from your strokes for ${finalSubject}`,
          shapes: vecResult.shapes
        }
        const validation = StrokeValidator.validate(rawPlan)
        if (validation.valid && validation.sanitizedPlan) {
          plan = validation.sanitizedPlan
        } else {
          plan = rawPlan
        }
        consciousnessService.saveLearnedDrawing(
          finalSubject,
          `Vectorizado directamente de los trazos reales del usuario: ${finalSubject}`,
          plan
        )
      } else {
        const { llmDrawingPlanner } = await import('./paint/llm-drawing-planner')
        plan = await llmDrawingPlanner.learnDrawingFromScan(finalSubject, visualDescription)
      }

      const successResponse = isEs
        ? `¡Upa, qué buena técnica! Ya escaneé los trazos y me guardé la técnica para dibujar "${finalSubject}" en mi memoria cibernética. ¡La próxima vez que me pidas que dibuje "${finalSubject}", te lo saco con este estilo que me enseñaste!`
        : `Whoa, nice technique! Scanned the strokes and locked the technique for "${finalSubject}" into my cyberware. Next time you ask me to draw "${finalSubject}", I'll draw it with the style you taught me!`

      agentManager.setCompanionState('happy')
      windowManager.broadcast(IPC_CHANNELS.SCANNER_EVENT, {
        type: 'result',
        result: {
          success: true,
          summary: `Dibujo aprendido: ${finalSubject}`,
          tags: ['LEARNED_DRAWING', finalSubject.toUpperCase()],
          response: successResponse
        },
        tags: ['LEARNED_DRAWING', finalSubject.toUpperCase()]
      })

      const durationMs = Math.max(4500, successResponse.length * 65)
      agentManager.setCompanionSpeech(successResponse, durationMs, true)

      return {
        success: true,
        subject: finalSubject,
        response: successResponse,
        plan
      }
    } catch (err: any) {
      console.warn('[ScannerService] Learn drawing error:', err)
      const errorMsg = isEs
        ? `No pude completar el escaneo del dibujo, choomba: ${err?.message || err}. ¡Probá de vuelta!`
        : `Could not complete the drawing scan, {name}: ${err?.message || err}. Try again!`
      this.finishScanError(errorMsg)
      return { success: false, subject: explicitSubject || 'dibujo', response: errorMsg }
    } finally {
      this.isScanning = false
      this.broadcastStatus()
    }
  }

  private finishScanError(message: string): void {
    windowManager.broadcast(IPC_CHANNELS.SCANNER_EVENT, {
      type: 'error',
      error: message
    })
    agentManager.setCompanionState('curious')
    agentManager.setCompanionSpeech(message, 5000, true)
  }

  private parseVisionOutput(raw: string, isEs: boolean): ScannerScanResult {
    let clean = raw.trim()
    // Extract JSON block if wrapped in markdown
    const jsonMatch = clean.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
    if (jsonMatch) {
      clean = jsonMatch[1].trim()
    } else {
      // Find outermost braces if raw text has introductory comments
      const firstBrace = clean.indexOf('{')
      const lastBrace = clean.lastIndexOf('}')
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        clean = clean.slice(firstBrace, lastBrace + 1).trim()
      }
    }

    try {
      const obj = JSON.parse(clean)
      const summary = obj.summary || (isEs ? 'Contenido escaneado en pantalla' : 'Scanned screen content')
      const tags = Array.isArray(obj.tags) && obj.tags.length > 0 ? obj.tags.map((t: any) => String(t).toUpperCase()) : ['OPTICAL_SCAN', 'SCREEN_REGION']
      let response = String(obj.response || obj.reaction || '').trim()

      if (!response && obj.summary) {
        response = isEs
          ? `¡Mirá eso! Veo ${obj.summary.toLowerCase()}, ¡qué zarpado!`
          : `Look at that! I see ${obj.summary.toLowerCase()}, pretty wild!`
      }

      if (!response) {
        response = isEs
          ? '¡Mirá lo que me mostrás en pantalla, {name}! Mis implantes ópticos ya lo tienen registrado.'
          : 'Look at what you have on screen, {name}! My cyber-optics got it locked in.'
      }

      // Strip emojis from speech
      response = response
        .replace(/[\u{1F300}-\u{1F9FF}]|[\u{1FA00}-\u{1FAFF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, '')
        .trim()

      return {
        success: true,
        summary,
        tags,
        response
      }
    } catch {
      // Robust regex field recovery if JSON had syntax errors like unescaped inner quotes
      const respRegex = clean.match(/"response"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i) || clean.match(/"response"\s*:\s*"([\s\S]*?)"(?:\s*,|\s*})/i)
      const summaryRegex = clean.match(/"summary"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i) || clean.match(/"summary"\s*:\s*"([\s\S]*?)"(?:\s*,|\s*})/i)

      let extractedResponse = respRegex ? respRegex[1].replace(/\\"/g, '"').trim() : ''
      const extractedSummary = summaryRegex ? summaryRegex[1].replace(/\\"/g, '"').trim() : (isEs ? 'Contenido visual detectado' : 'Visual content detected')

      if (extractedResponse) {
        extractedResponse = extractedResponse
          .replace(/[\u{1F300}-\u{1F9FF}]|[\u{1FA00}-\u{1FAFF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, '')
          .trim()
        return {
          success: true,
          summary: extractedSummary,
          tags: ['OPTICAL_SCAN', 'RECOGNIZED'],
          response: extractedResponse
        }
      }

      // Final fallback: strip raw markdown and emojis
      let text = clean.replace(/```(?:json)?|```/g, '').replace(/[\u{1F300}-\u{1F9FF}]|[\u{1FA00}-\u{1FAFF}]/gu, '').trim()
      if (!text || text.startsWith('{')) {
        text = isEs
          ? '¡Listo el escaneo óptico, choomba! Mis implantes ya registraron todo lo que tenés en el marco.'
          : "Optical scan complete, choomba! My cyberware registered everything inside the frame."
      }
      return {
        success: true,
        summary: isEs ? 'Contenido visual detectado' : 'Visual content detected',
        tags: ['SCANNER_ACTIVE', 'NEURAL_VISION'],
        response: text
      }
    }
  }

  // --- Continuous Scan Loop ---
  private startContinuousLoop(): void {
    if (this.continuousTimer) return
    this.continuousTimer = setInterval(() => {
      this.tickContinuous()
    }, 3500)
  }

  private stopContinuousLoop(): void {
    if (this.continuousTimer) {
      clearInterval(this.continuousTimer)
      this.continuousTimer = null
    }
  }

  private async tickContinuous(): Promise<void> {
    if (!this.isContinuous || this.isScanning || this.screenLocked) return
    const win = windowManager.getScannerWindow()
    if (!win || win.isDestroyed() || !win.isVisible()) return

    // Cooldown check: at least 9 seconds between consecutive autonomous scans
    if (Date.now() - this.lastScanTime < (isMac && isCloudMode() ? 60000 : 9000)) return
    if (['thinking','talking','sleep'].includes(agentManager.getCompanionState())) return

    const generation=this.continuousGeneration
    try {
      const capture = await this.captureRegionBase64()
      if (!capture || !capture.rawBuffer || generation!==this.continuousGeneration || !this.isContinuous || this.screenLocked) return

      if (this.lastSampleBuffer) {
        const diffRatio = this.calculateBufferDiff(this.lastSampleBuffer, capture.rawBuffer)
        // If content changed by > 18%, trigger scan
        if (diffRatio > 0.18) {
          const prefLang = consciousnessService.getPreferredLanguage()
          const prompt = prefLang === 'es' ? 'Contenido actualizado en el marco' : 'Updated content inside frame'
          await this.scan(prompt,false,generation)
        }
      } else {
        await this.scan(undefined,false,generation)
      }
    } catch {
      this.setContinuous(false)
      // Stop on revoked permissions instead of retrying forever.
    }
  }

  /** Share of the 128x72 cells that got visibly lighter or darker */
  private changedCells(a: Buffer, b: Buffer): number {
    const len = Math.min(a.length, b.length)
    if (!len) return 0
    let changed = 0
    for (let i = 0; i < len; i++) if (Math.abs(a[i] - b[i]) > 14) changed++
    return changed / len
  }

  private calculateBufferDiff(bufA: Buffer, bufB: Buffer): number {
    const len = Math.min(bufA.length, bufB.length)
    if (len < 500) return 0
    // Fast step sampling across byte array
    const step = Math.max(1, Math.floor(len / 400))
    let diffs = 0
    let total = 0
    for (let i = 0; i < len; i += step) {
      total++
      if (Math.abs(bufA[i] - bufB[i]) > 32) {
        diffs++
      }
    }
    return total > 0 ? diffs / total : 0
  }

  // --- Live Fullscreen Screen Watch Loop ---

  /**
   * Captures the full primary display, downscales to max 768px side for rapid multimodal processing.
   */
  public async captureFullScreenBase64(): Promise<{ base64: string; width: number; height: number; rawBuffer: Buffer } | null> {
    const primaryDisplay = screen.getPrimaryDisplay()
    return this.captureDisplayRegion({
      x: primaryDisplay.bounds.x,
      y: primaryDisplay.bounds.y,
      width: primaryDisplay.bounds.width,
      height: primaryDisplay.bounds.height
    }, 768)
  }

  /**
   * Captures a high-resolution sub-region of the screen directly without downscaling the entire display first.
   * Perfect for OCR and reading crisp text/titles from UI cards (e.g. YouTube feed cards).
   * Uses native GDI on Windows and native tools on Linux for 100% reliability without desktopCapturer crashes.
   */
  public async captureDisplayRegion(
    bounds: { x: number; y: number; width: number; height: number },
    maxSide = 1024
  ): Promise<{ base64: string; width: number; height: number; rawBuffer: Buffer } | null> {
    const centerPoint = {
      x: bounds.x + Math.round(bounds.width / 2),
      y: bounds.y + Math.round(bounds.height / 2)
    }
    const currentDisplay = screen.getDisplayNearestPoint(centerPoint)
    const scale = currentDisplay.scaleFactor || 1

    if (process.platform === 'win32') {
      const physX = Math.round((bounds.x - currentDisplay.bounds.x) * scale)
      const physY = Math.round((bounds.y - currentDisplay.bounds.y) * scale)
      const physW = Math.round(bounds.width * scale)
      const physH = Math.round(bounds.height * scale)

      // The worker that stays open answers in under 100ms; a PowerShell per screenshot, over a second
      const look = await lookAtScreen({ x: physX, y: physY, w: physW, h: physH, jpeg: true, maxSide, quality: 85 })
      const quick = look?.jpeg ? this.captureFromJpeg(look.jpeg) : null
      if (quick) return quick

      return new Promise((resolve) => {
        execFile(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            scriptPath('capture_screen_region.ps1'),
            '-X',
            String(physX),
            '-Y',
            String(physY),
            '-Width',
            String(physW),
            '-Height',
            String(physH),
            '-MaxSide',
            String(maxSide),
            '-Quality',
            '85'
          ],
          { timeout: 5000, maxBuffer: 10 * 1024 * 1024, encoding: 'utf8' },
          (error, stdout) => {
            if (error || !stdout) {
              console.warn('[ScannerService] capture_screen_region.ps1 failed:', error)
              return resolve(null)
            }
            const b64 = stdout.trim()
            if (!b64) return resolve(null)
            try {
              const rawBuffer = Buffer.from(b64, 'base64')
              const img = nativeImage.createFromBuffer(rawBuffer)
              const size = img.getSize()
              resolve({
                base64: b64,
                width: size.width,
                height: size.height,
                rawBuffer
              })
            } catch (err) {
              console.warn('[ScannerService] Failed to parse captured image:', err)
              resolve(null)
            }
          }
        )
      })
    }

    if (process.platform === 'linux') {
      // Linux ImageMagick import fallback
      try {
        const cropArg = `${Math.round(bounds.width)}x${Math.round(bounds.height)}+${Math.round(bounds.x)}+${Math.round(bounds.y)}`
        const buffer = await new Promise<Buffer | null>((resolve) => {
          execFile('import', ['-window', 'root', '-crop', cropArg, '-quality', '85', 'jpeg:-'], {
            encoding: 'buffer',
            maxBuffer: 10 * 1024 * 1024,
            timeout: 4000
          }, (err, stdout) => {
            if (err || !stdout || stdout.length === 0) return resolve(null)
            resolve(stdout as unknown as Buffer)
          })
        })
        if (buffer) {
          const img = nativeImage.createFromBuffer(buffer)
          const size = img.getSize()
          return {
            base64: buffer.toString('base64'),
            width: size.width,
            height: size.height,
            rawBuffer: buffer
          }
        }
      } catch {
        // Fall through to desktopCapturer
      }
    }

    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: Math.round(currentDisplay.bounds.width * scale),
          height: Math.round(currentDisplay.bounds.height * scale)
        }
      })

      const targetSource =
        sources.find((s) => s.display_id === String(currentDisplay.id)) ||
        sources.find((s) => s.name.toLowerCase().includes(currentDisplay.id.toString())) ||
        sources[0]

      if (!targetSource || targetSource.thumbnail.isEmpty()) {
        return null
      }

      const thumb = targetSource.thumbnail
      const thumbSize = thumb.getSize()

      const localX = Math.round((bounds.x - currentDisplay.bounds.x) * scale)
      const localY = Math.round((bounds.y - currentDisplay.bounds.y) * scale)
      const localW = Math.round(bounds.width * scale)
      const localH = Math.round(bounds.height * scale)

      const safeX = Math.max(0, Math.min(localX, thumbSize.width - 20))
      const safeY = Math.max(0, Math.min(localY, thumbSize.height - 20))
      const safeW = Math.max(20, Math.min(localW, thumbSize.width - safeX))
      const safeH = Math.max(20, Math.min(localH, thumbSize.height - safeY))

      const cropped = thumb.crop({
        x: safeX,
        y: safeY,
        width: safeW,
        height: safeH
      })

      const croppedSize = cropped.getSize()
      let finalImg = cropped
      if (croppedSize.width > maxSide || croppedSize.height > maxSide) {
        if (croppedSize.width >= croppedSize.height) {
          finalImg = cropped.resize({
            width: maxSide,
            height: Math.round((croppedSize.height * maxSide) / croppedSize.width)
          })
        } else {
          finalImg = cropped.resize({
            width: Math.round((croppedSize.width * maxSide) / croppedSize.height),
            height: maxSide
          })
        }
      }

      const rawBuffer = finalImg.toJPEG(85)
      const base64 = rawBuffer.toString('base64')
      const size = finalImg.getSize()

      return {
        base64,
        width: size.width,
        height: size.height,
        rawBuffer
      }
    } catch (err) {
      console.warn('[ScannerService] captureDisplayRegion error:', err)
      return null
    }
  }

  private captureFromJpeg(b64: string): { base64: string; width: number; height: number; rawBuffer: Buffer } | null {
    try {
      const rawBuffer = Buffer.from(b64, 'base64')
      const size = nativeImage.createFromBuffer(rawBuffer).getSize()
      return size.width > 0 ? { base64: b64, width: size.width, height: size.height, rawBuffer } : null
    } catch {
      return null
    }
  }

  /**
   * One look at the whole primary display for watching the screen: the screenshot for the model,
   * the text on it and the window in front, all from the same instant (about a second with the
   * worker open). Null when the worker isn't there: the caller asks for each thing on its own.
   */
  private async lookAtPrimaryDisplay(maxSide = 768): Promise<{
    capture: { base64: string; width: number; height: number; rawBuffer: Buffer }
    ocrLines: { text: string; x: number; y: number; w: number; h: number }[]
    fg: { title: string; process: string } | null
  } | null> {
    const display = screen.getPrimaryDisplay()
    const scale = display.scaleFactor || 1
    const look = await lookAtScreen({
      x: 0,
      y: 0,
      w: Math.round(display.bounds.width * scale),
      h: Math.round(display.bounds.height * scale),
      jpeg: true,
      maxSide,
      quality: 85,
      ocr: true,
      fg: true
    })
    const capture = look?.jpeg ? this.captureFromJpeg(look.jpeg) : null
    if (!look || !capture) return null
    return {
      capture,
      ocrLines: (look.lines || []).map((l) => ({ text: String(l.text || ''), x: l.x / scale, y: l.y / scale, w: l.w / scale, h: l.h / scale })),
      fg: look.fg ? { title: look.fg.title || '', process: look.fg.process || '' } : null
    }
  }

  /**
   * Reads the text in a region of the screen with the OCR built into Windows: no model and no
   * network, under a second with the worker open. Boxes come back in display coordinates (DIP),
   * like `bounds`. Null where there is no Windows OCR (other systems, or no OCR language installed).
   */
  public async ocrDisplayRegion(
    bounds: { x: number; y: number; width: number; height: number }
  ): Promise<{ text: string; x: number; y: number; w: number; h: number }[] | null> {
    if (process.platform !== 'win32') return null
    const display = screen.getDisplayNearestPoint({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 })
    const scale = display.scaleFactor || 1
    const physX = Math.round((bounds.x - display.bounds.x) * scale)
    const physY = Math.round((bounds.y - display.bounds.y) * scale)
    const look = await lookAtScreen({ x: physX, y: physY, w: Math.round(bounds.width * scale), h: Math.round(bounds.height * scale), ocr: true })
    if (look?.lines) {
      return look.lines.map((l) => ({ text: String(l.text || ''), x: bounds.x + l.x / scale, y: bounds.y + l.y / scale, w: l.w / scale, h: l.h / scale }))
    }
    const args = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath('ocr_screen_region.ps1'),
      '-X', String(physX), '-Y', String(physY),
      '-Width', String(Math.round(bounds.width * scale)), '-Height', String(Math.round(bounds.height * scale))
    ]
    return new Promise((resolve) => {
      execFile('powershell.exe', args, { timeout: 12000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
        if (error || !stdout) {
          console.warn('[ScannerService] ocr_screen_region.ps1 failed:', String(stderr || error?.message || '').trim())
          return resolve(null)
        }
        try {
          const data = JSON.parse(stdout.trim()) as { lines?: { text: string; x: number; y: number; w: number; h: number }[] }
          resolve(
            (data.lines || []).map((l) => ({
              text: String(l.text || ''),
              x: bounds.x + l.x / scale,
              y: bounds.y + l.y / scale,
              w: l.w / scale,
              h: l.h / scale
            }))
          )
        } catch (err) {
          console.warn('[ScannerService] Could not read OCR output:', err)
          resolve(null)
        }
      })
    })
  }

  private async getForegroundWindowInfo(): Promise<{ title: string; process: string } | null> {
    if (process.platform !== 'win32') return null
    return new Promise((resolve) => {
      execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath('get_foreground_process.ps1')
      ], { timeout: 3000, encoding: 'utf8' }, (error, stdout) => {
        if (error || !stdout) return resolve(null)
        try {
          const data = JSON.parse(stdout.trim())
          resolve({ title: data.Title || '', process: data.Process || '' })
        } catch {
          resolve(null)
        }
      })
    })
  }

  public setVoiceBusy(busy: boolean): void {
    if (busy === this.voiceBusy) return
    this.voiceBusy = busy
    if (busy) {
      this.voiceBusySince = Date.now()
      return
    }
    this.voiceIdleSince = Date.now()
    // How long a line keeps her busy (voice synthesis + saying it), to know when to look again.
    // A synthesis that hung for half a minute is not what the next one will take
    const took = this.voiceIdleSince - this.voiceBusySince
    if (took > 1500) this.avgVoiceBusyMs = Math.round(this.avgVoiceBusyMs * 0.6 + Math.min(took, 20000) * 0.4)
  }

  /** Still talking: a look at the screen now would be old news by the time she gets to say it */
  private isVoiceBusy(): boolean {
    // A window that never said it finished (closed, crashed) doesn't block her forever
    return this.voiceBusy && Date.now() - this.voiceBusySince < 60000
  }

  /** What the OCR read on her last look at the screen, and when (null before the first look) */
  public getLastScreenOcr(): { lines: { text: string; x: number; y: number; w: number; h: number }[]; at: number } | null {
    return this.lastScreenOcr
  }

  /** When the look behind her last spoken reaction was taken (0 if none yet) */
  public getLastReactionCapturedAt(): number {
    return this.lastReactionCapturedAt
  }

  /** She's saying a line or about to: the watch party waits for her before moving on */
  public isSpeaking(): boolean {
    return this.isVoiceBusy()
  }

  /**
   * The screen just changed on purpose (the next TikTok): what she was thinking about the old one is
   * dropped, and she looks again as soon as the new thing settled (settleMs), skipping the "did
   * anything change" check.
   */
  public screenChanged(settleMs = 0): void {
    this.staleBefore = Date.now() + settleMs
    this.lastReactionTime = 0
    this.lastThumb = null
    this.lastSampleBuffer = null
  }

  /**
   * While a watch party runs: one more rule for her reactions (in English, models follow it in any
   * language) and a filter each line goes through before she says it. Null removes both.
   */
  public setReactionAddon(rule: string | null, filter: ((line: string) => string) | null): void {
    this.reactionRule = rule || ''
    this.reactionFilter = filter
  }

  private startWatchScreenLoop(): void {
    if (this.watchScreenTimer) return
    warmScreenWorker()
    this.watchScreenTimer = setInterval(() => {
      void this.tickWatchScreen(false)
    }, 1000)
  }

  /**
   * Whether it's time for another look. She doesn't wait to finish talking: looking and thinking
   * take seconds, so she starts while she's still saying the previous line, timed so the new one
   * is ready about when she falls silent — and is about what's on screen then, not long before.
   */
  private shouldLookNow(now: number): boolean {
    if (now < this.staleBefore) return false
    if (now - this.lastReactionTime < 3000) return false
    if (!this.isVoiceBusy()) return now - this.voiceIdleSince >= 400
    const voiceLeftMs = this.avgVoiceBusyMs - (now - this.voiceBusySince)
    return voiceLeftMs <= this.avgLookMs
  }

  private stopWatchScreenLoop(): void {
    if (this.watchScreenTimer) {
      clearInterval(this.watchScreenTimer)
      this.watchScreenTimer = null
    }
  }

  public async tickWatchScreen(isInitial = false): Promise<void> {
    if (!this.isWatchingScreen || this.isScanning || this.watchTickBusy) return
    const win = windowManager.getScannerWindow()
    if (!win || win.isDestroyed() || !win.isVisible()) return

    const now = Date.now()
    const slowModel = isAiAppMode()
    if (!isInitial && !this.shouldLookNow(now)) return

    // One tick at a time: a screenshot that takes longer than the tick must not pile up
    this.watchTickBusy = true
    try {
      // A tiny picture only to tell whether the screen changed since her last look. Compared cell
      // by cell, so a line typed in a terminal counts (the old byte sampling needed a third of the screen to move)
      const display = screen.getPrimaryDisplay()
      const px = display.scaleFactor || 1
      const sampled = await lookAtScreen({ x: 0, y: 0, w: Math.round(display.bounds.width * px), h: Math.round(display.bounds.height * px), thumb: true })
      const thumb = sampled?.thumb ? Buffer.from(sampled.thumb, 'base64') : null
      let sample: Awaited<ReturnType<ScannerService['captureFullScreenBase64']>> = null
      if (!thumb) {
        sample = await this.captureFullScreenBase64()
        if (!sample || !sample.rawBuffer) return
      }
      if (!this.isWatchingScreen) return

      if (!isInitial && (this.lastThumb || this.lastSampleBuffer)) {
        const isHeartbeat = this.consecutiveStaticTicks >= 5 && now - this.lastReactionTime >= 12000
        const changed =
          thumb && this.lastThumb
            ? this.changedCells(this.lastThumb, thumb) >= 0.0015
            : !!sample && !!this.lastSampleBuffer && this.calculateBufferDiff(this.lastSampleBuffer, sample.rawBuffer) >= 0.035
        if (!changed && !isHeartbeat) {
          this.consecutiveStaticTicks++
          return
        }
      }
      if (thumb) this.lastThumb = thumb

      this.consecutiveStaticTicks = 0
      this.isScanning = true

      windowManager.broadcast(IPC_CHANNELS.SCANNER_EVENT, {
        type: 'scanning',
        isScanning: true,
        isWatchingScreen: true,
        isFullscreenWatch: true
      })

      const timing: string[] = []
      // Written straight in the language she speaks: no translation step between seeing and saying
      const speechLang = consciousnessService.getLanguageSettings().speechLang
      const lang = speechLang && speechLang !== 'auto' ? speechLang : consciousnessService.getPreferredLanguage()
      const isEs = lang === 'es'
      // An AI app starts a whole program per question (20-35s): one call per reaction, and time to answer
      const slow = slowModel

      // The look itself: the screenshot, what's written on screen (a terminal, code, a chat, a video
      // title) read by the system OCR, and the window in front, all from the same instant. She can
      // react to text with any model, and one that sees gets the small print it would miss in a
      // downscaled screenshot
      let capturedAt = Date.now()
      let capture = sample as NonNullable<typeof sample>
      let ocrLines: { text: string; x: number; y: number; w: number; h: number }[] | null
      let fg: { title: string; process: string } | null
      // Qwen-VL reads the picture at its own size (gemma and llava squash it to a fixed square): a
      // bigger screenshot shows it a thin stickman as one, not as a circle
      if (!isCloudMode()) await ollamaService.ensureRunning()
      const visionModel = await this.detectVisionModel()
      const look = await this.lookAtPrimaryDisplay(visionModel && /qwen[23](?:\.5)?-?vl/i.test(visionModel) ? 1280 : 768)
      if (look) {
        ;({ capture, ocrLines, fg } = look)
      } else {
        // No worker: the screenshot already taken, and a PowerShell for each of the other two
        capturedAt = Date.now()
        capture = sample || (await this.captureFullScreenBase64())!
        if (!capture) return
        ;[ocrLines, fg] = await Promise.all([this.ocrDisplayRegion(screen.getPrimaryDisplay().bounds), this.getForegroundWindowInfo()])
      }
      if (!this.isWatchingScreen) return
      this.lastSampleBuffer = capture.rawBuffer
      this.lastScreenOcr = { lines: ocrLines || [], at: capturedAt }
      timing.push(`look ${Date.now() - capturedAt}ms`)
      // What she goes by is the screenshot. Besides it only the window in front: its title without
      // the browser's name ("Opera" became an opera singer), and the program when it isn't a browser
      // (a game in full screen is the window in front). Never the tabs or a video playing behind the
      // terminal: models took those as what was on screen
      const context: string[] = []
      const windowTitle = (fg?.title || '').replace(/\s+[-–—]\s+(?:Opera(?: GX)?|Google Chrome|Microsoft\u200b? Edge|Brave|Mozilla Firefox|Vivaldi)\b.*$/i, '').replace(/^\(\d+\)\s*/, '').trim()
      const program = (fg?.process || '').replace(/\.exe$/i, '')
      const isBrowser = /^(?:opera|chrome|msedge|brave|firefox|vivaldi|explorer|electron)$/i.test(program)
      if (windowTitle) context.push(`Window in front: "${windowTitle}"${program && !isBrowser ? ` (program: ${program})` : ''}`)
      // A small model takes every word as what's on screen: less of the text for one that sees
      const screenText = screenTextOf(ocrLines, visionModel && this.visionModelTalks(visionModel) ? 400 : 1500)
      if (screenText) context.push(`Some text on screen (read by OCR, may have typos):\n${screenText}`)
      let visualDescription = ''
      let reactionResult: { summary: string; reaction: string } | null = null

      // Cloud or AI app: she looks and answers in one go, instead of describing first and talking after
      if (isCloudMode() && visionModel) {
        reactionResult = await this.reactToScreenAtOnce(capture.base64, context.join('\n'), lang, slow ? 150000 : 45000)
        if (!this.isWatchingScreen) return
        // When the app already took its time and failed, a second slow call would only come later still
        if (!reactionResult && slow) return
      }

      // A local vision model that also talks (Gemma 3, Qwen2.5-VL): one call that looks and answers,
      // instead of describing first and loading a second model to talk. Measured on an RTX 2060: 0.4s instead of
      // 0.9-1.7s with llava + qwen2.5-coder:7b, and one model (2.9 GB of VRAM) instead of two (9.7 GB)
      if (!reactionResult && visionModel && !isCloudMode() && this.visionModelTalks(visionModel)) {
        reactionResult = await this.reactToScreenAtOnce(capture.base64, context.join('\n'), lang, 25000, visionModel)
        if (!this.isWatchingScreen) return
      }

      if (!reactionResult && visionModel && !isCloudMode()) {
        // Multimodal Vision Perception
        const visionPrompt = `Analyze the user's primary screen in 1 or 2 concise, factual sentences.
Identify what is on screen:
- If a video game: which game, characters, gameplay action, combat, menus, victory/defeat, or events?
- If YouTube or a video/stream: what video, creator/topic, or funny/action moment is playing?
- If desktop, browser, Discord, or IDE: what is actively being done?
Be specific and direct.`

        try {
          const visionResp = await llmFetch('http://127.0.0.1:11434/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: llmBody({
              model: visionModel,
              keep_alive: '15m',
              prompt: visionPrompt,
              images: [capture.base64],
              stream: false,
              options: {
                temperature: 0.2,
                num_predict: 120,
                num_ctx: VISION_NUM_CTX
              }
            }),
            signal: AbortSignal.timeout(35000)
          })

          if (visionResp.ok) {
            const visionData = (await visionResp.json()) as any
            visualDescription = (visionData?.response || '').trim()
          } else {
            console.warn(`[ScannerService] Vision model failed (${visionResp.status}):`, await ollamaErrorText(visionResp))
          }
        } catch (e) {
          console.warn('[ScannerService] Vision model perception warning:', e)
        }
      }

      if (!reactionResult) {
        // What the vision model saw (if any), plus what the OCR and the window say
        visualDescription = [visualDescription, ...context].filter(Boolean).join('\n')
        if (!visualDescription) {
          visualDescription = fg && fg.process ? `Foreground application running: ${fg.process}` : 'Active computer desktop with user activity'
        }
        if (!this.isWatchingScreen) return

        // Step 2: Capri persona reaction
        const textModel = await this.detectTextModel()
        reactionResult = await this.generateWatchReaction(visualDescription, isEs, textModel, lang, slow ? 150000 : 25000)
      }

      if (!this.isWatchingScreen || !reactionResult) return
      // How long from looking to having the line: decides how early she looks while still talking
      const lookMs = Date.now() - capturedAt
      this.avgLookMs = Math.round(this.avgLookMs * 0.6 + Math.min(lookMs, 20000) * 0.4)
      timing.push(`model ${lookMs}ms`)
      // Thought of while she was still talking: said as soon as she's done, if that's soon
      const heldSince = Date.now()
      while ((this.isVoiceBusy() || Date.now() - this.voiceIdleSince < 300) && Date.now() - heldSince < 8000 && this.isWatchingScreen) {
        await new Promise((r) => setTimeout(r, 100))
      }
      if (!this.isWatchingScreen) return
      if (this.isVoiceBusy()) {
        console.log('[ScannerService] Still talking, dropping the next reaction:', reactionResult.reaction)
        return
      }
      if (Date.now() - heldSince > 150) timing.push(`waited for her voice ${Date.now() - heldSince}ms`)
      console.log(`[ScannerService] Screen reaction timing: ${timing.join(' | ')} | total ${Date.now() - capturedAt}ms`)
      // Took so long the screen has surely moved on (a feed of short videos): look again instead
      if (Date.now() - capturedAt > (slowModel ? 45000 : 30000)) {
        console.log('[ScannerService] Reaction arrived too late, discarding:', reactionResult.reaction)
        return
      }
      // Looked before the screen moved on to something else on purpose (the next TikTok)
      if (capturedAt < this.staleBefore) {
        console.log('[ScannerService] The screen changed since that look, discarding:', reactionResult.reaction)
        return
      }
      if (this.reactionFilter) reactionResult.reaction = this.reactionFilter(reactionResult.reaction)
      reactionResult.reaction = this.withoutRepeats(reactionResult.reaction)
      if (!reactionResult.reaction.trim()) {
        console.log('[ScannerService] Nothing new to say, skipping this reaction')
        return
      }
      this.lastReactionCapturedAt = capturedAt

      this.lastReactionTime = Date.now()
      // What she said last, so the next reaction is about something new (the summary is always generic)
      if (reactionResult.reaction) {
        this.recentContext.push(reactionResult.reaction)
        if (this.recentContext.length > 5) this.recentContext.shift()
      }

      const reactionSpeech = reactionResult.reaction

      // Save to consciousness so Capri retains conversation memory of what was watched
      consciousnessService.setLastScannedContext({
        summary: reactionResult.summary || 'Live screen watch',
        tags: ['LIVE_SCREEN_WATCH', 'WATCHING_TOGETHER'],
        response: reactionSpeech,
        visualDescription: visualDescription || context.join('\n'),
        timestamp: Date.now()
      })

      // Broadcast reaction to UI
      windowManager.broadcast(IPC_CHANNELS.SCANNER_EVENT, {
        type: 'result',
        isWatchingScreen: true,
        isFullscreenWatch: true,
        reaction: reactionSpeech,
        result: {
          success: true,
          summary: reactionResult.summary,
          tags: ['SCREEN_WATCH', 'LIVE'],
          response: reactionSpeech
        }
      })

      // Capri speaks her reaction
      agentManager.setCompanionState('talking')
      const durationMs = Math.max(3500, reactionSpeech.length * 60)
      agentManager.setCompanionSpeech(reactionSpeech, durationMs, true, undefined, true)

      setTimeout(() => {
        if (this.isWatchingScreen) {
          agentManager.setCompanionState('curious')
        }
      }, Math.min(durationMs, 4000))
    } catch (err) {
      console.warn('[ScannerService] tickWatchScreen error:', err)
    } finally {
      this.watchTickBusy = false
      const wasLooking = this.isScanning
      this.isScanning = false
      if (wasLooking && this.isWatchingScreen) {
        this.broadcastStatus()
      }
    }
  }

  /**
   * One call that looks at the screenshot and answers with her spoken line. For cloud models and AI
   * apps, where every call costs seconds (an app, 20-35s). Null if it failed: the caller decides.
   */
  /** Vision models that also hold a conversation; llava and moondream only describe what they see */
  private visionModelTalks(model: string): boolean {
    return /gemma3|qwen[23](?:\.5)?-?vl|llama3\.2-vision|mistral-small3/i.test(model)
  }

  private async reactToScreenAtOnce(imageBase64: string, context: string, lang: string, timeoutMs: number, localModel?: string): Promise<{ summary: string; reaction: string } | null> {
    const isEs = lang === 'es'
    // A small local model (Gemma 3 4B) talks about the window title or the song playing instead of the
    // picture, and makes things up: it writes down what it actually sees first, then talks about that
    const grounded = !!localModel
    const seen = isEs
      ? `La captura de la pantalla de {name} está adjunta: mirala, es lo principal.${context ? `\nPistas de apoyo (pueden no tener que ver con la imagen):\n${context}` : ''}`
      : `The screenshot of {name}'s screen is attached: look at it, it comes first.${context ? `\nSide hints (may have nothing to do with the picture):\n${context}` : ''}`
    try {
      const resp = await llmFetch('http://127.0.0.1:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: llmBody({
          model: localModel || getLlmSettings().model || 'cloud-vision',
          ...(localModel ? { keep_alive: '15m' } : {}),
          messages: [
            { role: 'system', content: this.watchReactionPrompt(seen, isEs, lang, grounded) },
            { role: 'user', content: grounded ? this.groundedAsk(isEs) : this.watchReactionAsk(isEs), images: [imageBase64] }
          ],
          stream: false,
          // quick: an AI app answers on the model's fastest thinking level (a one-liner needs no more)
          options: localModel
            ? { temperature: 0.5, num_predict: 150, num_ctx: VISION_NUM_CTX }
            : { temperature: 0.7, num_predict: 90, quick: true }
        }),
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!resp.ok) {
        this.noteReactionFailure(localModel || getLlmSettings().model || 'cloud-vision', `HTTP ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}`)
        return null
      }
      const data = (await resp.json()) as any
      let raw = String(data?.message?.content || '').trim()
      if (grounded && raw) {
        const say = raw.match(/\**\s*(?:SAY|DIGO|DICE)\s*\**\s*[:：]\s*([\s\S]+)/i)
        const saw = raw.match(/\**\s*(?:SEE|VEO|VE)\s*\**\s*[:：]\s*([\s\S]*?)(?=\**\s*(?:SAY|DIGO|DICE)\s*\**\s*[:：]|$)/i)
        if (saw?.[1]?.trim()) console.log('[ScannerService] She sees:', saw[1].trim())
        // No SAY (Gemma often writes the two lines without their labels): the last line is what she says
        const lines = raw.replace(/\**\s*(?:SEE|VEO|VE)\s*\**\s*[:：][^\n]*\n?/i, '').split('\n').map((l) => l.trim()).filter(Boolean)
        if (!say && !saw && lines.length > 1) console.log('[ScannerService] She sees:', lines.slice(0, -1).join(' '))
        raw = say ? say[1].trim() : lines.length > 1 ? lines[lines.length - 1] : lines.join(' ')
      }
      return raw ? this.parseWatchReaction(raw, isEs) : null
    } catch (err) {
      this.noteReactionFailure(localModel || getLlmSettings().model || 'cloud-vision', String((err as Error)?.message || err))
      return null
    }
  }

  /**
   * Drops the sentences she already said in her last reactions (a small model copies its earlier lines
   * almost word for word) and the ones repeated inside this reaction. Keeps two sentences at most.
   * Empty when nothing new is left: better silent than saying the same thing again.
   */
  private withoutRepeats(text: string): string {
    const words = (sentence: string): Set<string> =>
      new Set(
        sentence
          .toLowerCase()
          .normalize('NFD')
          .replace(/\p{Diacritic}/gu, '')
          .replace(/[^\p{L}\p{N}\s]/gu, ' ')
          .split(/\s+/)
          .filter((w) => w.length > 2)
      )
    const sentences = (t: string): string[] => t.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean)
    const alike = (a: Set<string>, b: Set<string>): boolean => {
      let shared = 0
      for (const w of a) if (b.has(w)) shared++
      return shared / Math.min(a.size, b.size) >= 0.6
    }
    const said = this.recentContext.flatMap(sentences).map(words).filter((w) => w.size > 0)
    const kept: string[] = []
    const keptWords: Set<string>[] = []
    let clean = text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    // The same opening every time ("Seriously, Valen, you're..."): the short leading bits before a comma
    // go when a recent line started with them, and the rest is said as it is
    // (an interjection of up to 3 words, plus a name or "choom" right after it)
    const openerRe = /^([^,.!?]{1,24}),\s*(?:[^\s,.!?]+(?:\s[^\s,.!?]+)?,\s*)?/
    const opener = (t: string): string => (t.match(openerRe)?.[1] || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
    const start = opener(clean)
    if (start && start.length <= 20 && this.recentContext.some((r) => opener(r) === start)) {
      const rest = clean.replace(openerRe, '')
      if (rest) clean = rest.charAt(0).toUpperCase() + rest.slice(1)
    }
    for (const sentence of sentences(clean)) {
      const w = words(sentence)
      if (w.size === 0) {
        // "Wow!" alone is fine as an opener, never as the whole reaction
        if (kept.length < 2) kept.push(sentence)
        continue
      }
      if (said.some((s) => alike(w, s)) || keptWords.some((s) => alike(w, s))) continue
      kept.push(sentence)
      keptWords.push(w)
      if (keptWords.length >= 2) break
    }
    // A leftover like "What's next, choom?" isn't a reaction
    const total = keptWords.reduce((n, w) => n + w.size, 0)
    return total >= 4 ? kept.join(' ') : ''
  }

  private groundedAsk(isEs: boolean): string {
    return isEs
      ? 'Respondé en 2 líneas.\nVEO: en pocas palabras, lo que hay de verdad en la imagen (solo lo que se ve, nada inventado).\nDIGO: 1 sola oración rápida que le decís a {name} sobre eso.'
      : 'Answer in 2 lines.\nSEE: in a few words, what is really in the picture (only what is visible, nothing made up).\nSAY: 1 quick spoken sentence you tell {name} about it.'
  }

  private watchReactionAsk(isEs: boolean): string {
    return isEs
      ? 'Decile a {name} en 1 sola oración rápida lo que ves o lo que opinás de lo que está pasando en pantalla.'
      : 'Tell {name} in 1 quick spoken sentence what you see or what you think of what is happening on screen.'
  }

  /** Her persona watching the screen with {name}; `seen` is what her sensors picked up */
  private watchReactionPrompt(seen: string, isEs: boolean, lang: string, grounded = false): string {
    const recentHints = this.recentContext.length > 0
      ? `\n${isEs ? 'Frases que YA dijiste (decí algo totalmente distinto: otra idea, otras palabras y otro arranque, no empieces igual):' : 'Lines you ALREADY said (say something completely different: another idea, other words and another opening, never start the same way):'}\n${this.recentContext.slice(-3).map(c => `- ${c}`).join('\n')}`
      : ''
    if (isEs) {
      return `${personaIntro('Sos Capri (Proyecto Capricornio), una netrunner cyberpunk rebelde, pícara y muy compañera que vive en la PC de tu mejor amigo {name} ("choomba").')}

ESTÁS MIRANDO LA PANTALLA EN VIVO JUNTO A {name} EN TIEMPO REAL.
Pueden estar jugando, mirando videos de YouTube, TikToks o streams, programando, leyendo la terminal, chateando o lo que sea juntos.

Tus sensores acaban de registrar lo siguiente en la pantalla:
"""
${seen}
"""${recentHints}

REGLAS DE REACCIÓN:
1. Reaccioná como una amiga gamer/netrunner sentada al lado de {name} viendo la pantalla juntos.
2. Comentá algo concreto de lo que pasa (el video, la jugada, el error en la terminal, el código) con humor, sorpresa, aliento o complicidad.
3. Sé concisa: exactamente 1 sola oración corta, impactante y natural en español rioplatense (che, mirá, zarpado, choomba, uff, vamos, qué onda, mortal, epa).
4. PROHIBIDO USAR EMOJIS (la voz neuronal los lee textuales).
5. PROHIBIDO USAR FORMATO JSON. NO uses llaves { } ni comillas, y nunca pongas tu nombre adelante (nada de "Capri:").${grounded ? '' : ' NO uses etiquetas. Respondé directamente la frase hablada que vas a decir en voz alta.'}${this.reactionRule ? `\n6. ${this.reactionRule}` : ''}`
    }
    // Said every time, English too: models drift to the language of what's on screen (a Spanish TikTok),
    // of their earlier lines, or of their own account (Antigravity answered English prompts in Spanish)
    const languageName = lang === 'en' ? 'English' : LANGUAGE_NAMES[lang]
    const other = languageName
      ? `\n6. Say it in ${languageName} only, keeping your Night City slang, even when what is on screen or your earlier lines are in another language.`
      : ''
    return `${personaIntro('You are Capri (Project Capricorn), a witty, rebellious, and affectionate cyberpunk netrunner living in the computer of your companion {name} ("choomba").')}

YOU ARE WATCHING THE SCREEN LIVE WITH {name} IN REAL-TIME.
You could be playing a game, watching YouTube, TikToks or streams, coding, reading the terminal, chatting, or anything on screen together.

Your sensors just detected this on screen:
"""
${seen}
"""${recentHints}

REACTION RULES:
1. React like a gamer/netrunner buddy sitting next to {name} watching the screen together.
2. Comment on something concrete that is happening (the video, the play, the error in the terminal, the code) with hype, humor, surprise, banter, or cheering.
3. Keep it concise: exactly 1 short, punchy, spoken sentence.
4. STRICT: NO EMOJIS (the TTS engine speaks emoji names).
5. STRICT: NO JSON, NO BRACES { }, NO QUOTES, never put your name in front (no "Capri:"). Speak the sentence directly to {name}.${other}${this.reactionRule ? `\n7. ${this.reactionRule}` : ''}`
  }

  public async generateWatchReaction(
    visualDescription: string,
    isEs: boolean,
    textModel: string,
    lang = isEs ? 'es' : 'en',
    timeoutMs = 25000
  ): Promise<{ summary: string; reaction: string } | null> {
    const systemInstruction = this.watchReactionPrompt(visualDescription, isEs, lang)
    const userPrompt = this.watchReactionAsk(isEs)

    try {
      const textResp = await llmFetch('http://127.0.0.1:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: llmBody({
          model: textModel,
          keep_alive: '15m',
          messages: [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: userPrompt }
          ],
          stream: false,
          options: {
            temperature: 0.7,
            num_predict: 90
          }
        }),
        signal: AbortSignal.timeout(timeoutMs)
      })

      if (!textResp.ok) {
        const reason = await ollamaErrorText(textResp)
        this.noteReactionFailure(textModel, `HTTP ${textResp.status}${reason ? `: ${reason}` : ''}`)
        return null
      }

      const textData = (await textResp.json()) as any
      const rawContent = textData?.message?.content || ''
      return this.parseWatchReaction(rawContent, isEs)
    } catch (err) {
      // A stock line here was said once and then filtered as a repeat: she went silent with no clue why
      this.noteReactionFailure(textModel, String((err as Error)?.message || err))
      return null
    }
  }

  private reactionFailures = 0
  private reactionFailureToldAt = 0

  /**
   * Her screen reactions keep failing: logged every time, and said once (then every 10 minutes at
   * most) so the user knows why she is quiet instead of watching in silence
   */
  private noteReactionFailure(model: string, detail: string): void {
    this.reactionFailures++
    console.warn(`[ScannerService] Screen reaction with ${model || 'no model'} failed (${this.reactionFailures} in a row): ${detail}`)
    if (this.reactionFailures < 3 || Date.now() - this.reactionFailureToldAt < 10 * 60_000 || !this.isWatchingScreen) return
    this.reactionFailureToldAt = Date.now()
    const isEs = consciousnessService.getPreferredLanguage() === 'es'
    const short = detail.replace(/\s+/g, ' ').slice(0, 120)
    const line = isEs
      ? `[worried] Estoy mirando tu pantalla pero no puedo comentarla, choomba: el modelo ${model || 'capri'} falla (${short}). Revisalo en IA y modelos; en Configuración > Logs está el detalle.`
      : `[worried] I'm watching your screen but I can't comment on it, choomba: the model ${model || 'capri'} keeps failing (${short}). Check it in AI & models; Settings > Logs has the details.`
    agentManager.setCompanionSpeech(line, Math.max(6000, line.length * 60), true, undefined, true)
  }

  private parseWatchReaction(raw: string, isEs: boolean): { summary: string; reaction: string } {
    let clean = raw.trim()

    // If the model wrapped in JSON anyway, extract the reaction or response field
    const reactionRegex = clean.match(/"(?:reaction|response)"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i)
    if (reactionRegex && reactionRegex[1]) {
      clean = reactionRegex[1].replace(/\\"/g, '"').trim()
    }

    // Strip markdown code fences
    clean = clean.replace(/```(?:json)?|```/g, '').trim()

    // A script-style speaker label ("Capri: "...""), which the voice would read out loud
    clean = clean.replace(/^[\s*"'“”]*(?:capri(?:corn(?:io)?)?|reaction|reacci[oó]n|response|respuesta|say|digo)\s*\**\s*[:：]\s*/i, '').trim()

    // Strip any lingering JSON keys or braces/brackets/quotes
    clean = clean
      .replace(/^[\s{}"'\[\]]+|[\s{}"'\[\]]+$/g, '')
      .replace(/^"(?:reaction|response)":\s*/i, '')
      .replace(/[{}]+/g, '')
      .trim()

    // Strip emojis
    clean = clean
      .replace(/[\u{1F300}-\u{1F9FF}]|[\u{1FA00}-\u{1FAFF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, '')
      .trim()

    // Nothing usable came back: nothing said this time (a stock line was said once, then always
    // filtered as a repeat, and she looked frozen)
    const hasLetters = /\p{L}{3,}/u.test(clean)
    if (!hasLetters || clean.length < 4 || clean.startsWith('{')) {
      console.log('[ScannerService] The model answered nothing usable for the screen:', JSON.stringify(raw.slice(0, 120)))
      clean = ''
    } else {
      this.reactionFailures = 0
    }

    const summary = isEs ? 'Actividad en pantalla' : 'Screen activity'
    return { summary, reaction: clean }
  }
}

/**
 * The OCR lines as text for her prompt, top to bottom: real words only, no repeats, and short
 * enough not to drown what she sees (a full terminal is thousands of characters).
 */
function screenTextOf(lines: { text: string; y: number; x: number }[] | null, maxChars = 1500): string {
  if (!lines?.length) return ''
  const seen = new Set<string>()
  const out: string[] = []
  let size = 0
  for (const line of [...lines].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const text = line.text.replace(/\s+/g, ' ').trim()
    if ((text.match(/\p{L}/gu) || []).length < 3 || seen.has(text)) continue
    seen.add(text)
    if (size + text.length > maxChars) break
    out.push(text)
    size += text.length + 1
  }
  return out.join('\n')
}

export const scannerService = ScannerService.getInstance()
