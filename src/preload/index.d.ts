import type { ScreenCommentStatus } from '../shared/mac-types'
import type { DesktopPreferences } from '../shared/mac-types'
import type { PlacementCommand } from '../shared/placement'
import type { LlmPublicSettings, LlmSettingsUpdate } from '../main/services/llm-gateway'
import type { MemoryAddResult, MemorySnapshot } from '../main/services/memory-service'
import type { KnownApp, KnownAppResult } from '../main/services/known-apps'
import type { ModelPullProgress } from '../main/services/ollama-service'
import type { InstalledPart, LocalModelInfo } from '../main/services/installed-parts'
import type { AiAppInfo } from '../main/services/ai-apps'
import type { CyberpunkFolderInfo, CyberpunkFoldersState } from '../main/services/game/adapters/cyberpunk/cyberpunk-folders'
import type { BenchmarkRequest, BenchmarkResult } from '../shared/benchmark'
import type { QwenTtsConfig } from '../shared/qwen-tts'
import type { GpuBudget, QwenTtsSize, TtsProviderId } from '../shared/gpu-budget'
import type { BugReportResult, LogLine } from '../shared/logs'
import type { HotkeyAction, HotkeyProblem, Hotkeys } from '../shared/hotkeys'
import {
  CompanionEmotionState,
  AgentEventPayload,
  RoamingStatusPayload,
  AgentMode,
  AgentConfigPayload,
  SystemPromptPayload,
  ScannerBounds,
  ScannerStatusPayload,
  ScannerScanResult,
  ScannerEventPayload,
  WatchPartyStatusPayload
} from '../main/ipc/channels'

export interface SetupStatus {
  python: { systemPython: string | null; envReady: boolean }
  ffmpeg: boolean
  ollama: { installed: boolean; running: boolean; models: string[] }
  model: boolean
  persona: boolean
  recommendedModel: string
  vision: boolean
  recommendedVision: string
}

import type { PlatformStatus, MacPermission } from '../shared/mac-types'
import type { SpotifySettings, SpotifyMethod, SpotifyDevice } from '../main/services/spotify-service'
export interface IElectronAPI {
  desktop: {
    commentStatus: () => Promise<ScreenCommentStatus>
    openSettings: (voice?:boolean) => Promise<void>
    onOpenVoiceSettings: (callback:()=>void) => ()=>void
    onOpenSettings: (callback:()=>void) => ()=>void
    configure: (update:{screenCommentMinutes?:number;gameCommentMinutes?:number;speechModel?:'base'|'small'}) => Promise<DesktopPreferences>
    preferences: () => Promise<DesktopPreferences>
    setOpenAtLogin: (enabled:boolean) => Promise<DesktopPreferences>
    place: (target:PlacementCommand) => Promise<DesktopPreferences>
  }

  platform: {
    status: () => Promise<PlatformStatus>
    requestPermission: (permission: MacPermission) => Promise<PlatformStatus>
    openPermission: (permission: MacPermission) => Promise<void>
  }
  spotify: {
    settings: () => Promise<SpotifySettings>
    configure: (settings: {method?: SpotifyMethod; clientId?: string; deviceId?: string}) => Promise<SpotifySettings>
    connect: () => Promise<{success: boolean; output: string}>
    disconnect: () => Promise<SpotifySettings>
    devices: () => Promise<SpotifyDevice[]>
    play: (query: string) => Promise<{success: boolean; output: string}>
  }

  deck: {
    toggle: () => Promise<boolean>
    show: () => Promise<void>
    hide: () => Promise<void>
    getStatus: () => Promise<boolean>
    onStatusChanged?: (callback: (isOpen: boolean) => void) => () => void
  }
  window: {
    minimize: () => Promise<void>
    close: () => Promise<void>
  }
  roaming: {
    toggle: () => Promise<boolean>
    setActive: (active: boolean) => Promise<RoamingStatusPayload>
    getStatus: () => Promise<RoamingStatusPayload>
    onStateChanged: (callback: (status: RoamingStatusPayload) => void) => () => void
  }
  game: {
    startCatchGame: () => Promise<boolean>
    catchSuccess: () => Promise<boolean>
    markCyberpunkPoi: (target?: string) => Promise<boolean>
    clearCyberpunkPoi: () => Promise<boolean>
    markCyberpunkGig: (gigId?: string) => Promise<boolean>
    openExternal: (url: string) => Promise<boolean>
  }
  companion: {
    setChatActive: (active:boolean) => Promise<void>
    showMenu: () => Promise<void>
    setState: (state: CompanionEmotionState) => Promise<string>
    setTabMode: (enabled: boolean, keepPosition?: boolean) => Promise<boolean>
    setEyeMode: (enabled: boolean) => Promise<boolean>
    setGamingMode: (enabled: boolean, corner?: string) => Promise<boolean>
    getGamingMode: () => Promise<boolean>
    setHitThrough: (ignore: boolean) => Promise<boolean>
    listDisplays: () => Promise<{ id: number; label: string; width: number; height: number; primary: boolean; current: boolean }[]>
    moveToDisplay: (id: number) => Promise<boolean>
    setClickThrough: (ignore: boolean) => Promise<boolean>
    onScriptEvent: (
      callback: (
        event:
          | { kind: 'start' }
          | { kind: 'end' }
          | { kind: 'look'; look: 'ojos' | 'ojos2' | 'closed' | 'thinking' | 'asustada' | null }
          | { kind: 'line'; id: number; text: string; audioDataUrl?: string; look?: 'ojos' | 'ojos2' | 'closed' | 'thinking' | 'asustada' }
      ) => void
    ) => () => void
    scriptLineDone: (id: number) => void
    cancelScript: () => void
    setVoiceBusy: (busy: boolean) => void
    onToggleChat: (callback: () => void) => () => void
    getUserProfile: () => Promise<{ name: string; hasName: boolean; onboardingDone: boolean }>
    getMusicPlatform: () => Promise<'youtube_music' | 'spotify'>
    setMusicPlatform: (platform: 'youtube_music' | 'spotify') => Promise<'youtube_music' | 'spotify'>
    setUserName: (name: string) => Promise<string>
    onUserNameChanged: (callback: (name: string) => void) => () => void
    getLanguageSettings: () => Promise<{ textLang: string; speechLang: string; micLang: string; sttEngine: string; cloudStt?: string | null }>
    setLanguageSettings: (next: { textLang?: string; speechLang?: string; micLang?: string; sttEngine?: string }) => Promise<{ textLang: string; speechLang: string; micLang: string; sttEngine: string; cloudStt?: string | null }>
    onGamingModeChanged: (callback: (enabled: boolean) => void) => () => void
    getGamingOpacity: () => Promise<number>
    getScale: () => Promise<{ desktop: number; gaming: number }>
    getAdminMode: () => Promise<{ enabled: boolean; elevated: boolean }>
    setAdminMode: (enabled: boolean) => Promise<{ enabled: boolean; elevated: boolean; relaunching: boolean }>
    setScale: (kind: 'desktop' | 'gaming', value: number) => Promise<number>
    setGamingOpacity: (value: number) => Promise<number>
    onGamingOpacityChanged: (callback: (value: number) => void) => () => void
    moveBy: (dx: number, dy: number) => Promise<{ x: number; y: number } | null>
    getConsciousness: () => Promise<{
      shutdownCount: number
      bootCount: number
      lastShutdownTimestamp: number
      lastBootTimestamp: number
      totalConversations: number
      preferredLanguage?: string
      bootGreeting: string
    }>
    getLanguage: () => Promise<string>
    onLineLanguage: (callback: (lang: string) => void) => () => void
    setLanguage: (lang: string) => Promise<string>
    speak: (text: string, durationMs?: number, speakVoice?: boolean, cameo?: boolean) => Promise<boolean>
    endCameo: () => Promise<void>
    rememberSupporter: (name: string, message: string, line: string) => Promise<string>
    warmSupporters: () => Promise<void>
    onStateChanged: (callback: (state: CompanionEmotionState) => void) => () => void
    onSpeechChanged: (callback: (payload: { text: string; durationMs: number; speakVoice?: boolean; live?: boolean; cameo?: boolean }) => void) => () => void
    onLanguageChanged: (callback: (lang: string) => void) => () => void
  }
  agent: {
    sendPrompt: (
      prompt: string,
      projectPath: string,
      mode?: AgentMode,
      source?: 'pet' | 'editor'
    ) => Promise<boolean>
    getConfig: () => Promise<AgentConfigPayload>
    setConfig: (config: Partial<AgentConfigPayload>) => Promise<AgentConfigPayload>
    detectOllama: () => Promise<{ running: boolean; models: string[] }>
    // Editable system prompt
    getSystemPrompt: () => Promise<SystemPromptPayload>
    setSystemPrompt: (text: string) => Promise<SystemPromptPayload>
    resetSystemPrompt: () => Promise<SystemPromptPayload>
    setPersonaStyle: (style: { tone?: SystemPromptPayload['tone']; teasing?: SystemPromptPayload['teasing'] }) => Promise<SystemPromptPayload>
    // Her long-term memory
    getMemory: () => Promise<MemorySnapshot>
    setMemoryEnabled: (enabled: boolean) => Promise<MemorySnapshot>
    addMemory: (text: string) => Promise<MemoryAddResult>
    deleteMemory: (id: string) => Promise<MemorySnapshot>
    clearMemory: () => Promise<MemorySnapshot>
    onMemoryChanged: (callback: (memory: MemorySnapshot) => void) => () => void
    // The apps she knows by name (Dev Deck > Apps)
    listApps: () => Promise<KnownApp[]>
    pickApp: () => Promise<KnownAppResult | null>
    renameApp: (id: string, name: string) => Promise<KnownAppResult>
    removeApp: (id: string) => Promise<KnownApp[]>
    openApp: (id: string) => Promise<boolean>
    onAppsChanged: (callback: (apps: KnownApp[]) => void) => () => void
    // Downloading local models
    pullModel: (model: string) => Promise<boolean>
    cancelPullModel: () => Promise<void>
    importGgufModel: () => Promise<boolean>
    listAiApps: () => Promise<AiAppInfo[]>
    testAiApp: (app: string, model: string) => Promise<{ ok: boolean; error?: string; detail?: string }>
    // Local models and installed parts
    listLocalModels: () => Promise<LocalModelInfo[]>
    deleteLocalModel: (name: string) => Promise<LocalModelInfo[] | null>
    getVisionModel: () => Promise<string>
    setVisionModel: (model: string) => Promise<string>
    listInstalledParts: () => Promise<InstalledPart[]>
    removeInstalledPart: (id: InstalledPart['id']) => Promise<InstalledPart[]>
    onPullProgress: (callback: (progress: ModelPullProgress) => void) => () => void
    // Where Cyberpunk 2077 and her mod are
    getCyberpunkFolders: () => Promise<CyberpunkFoldersState>
    pickCyberpunkFolder: () => Promise<{ state: CyberpunkFoldersState; info: CyberpunkFolderInfo } | null>
    removeCyberpunkFolder: (folder: string) => Promise<CyberpunkFoldersState>
    getLlmSettings: () => Promise<LlmPublicSettings>
    setLlmSettings: (update: LlmSettingsUpdate) => Promise<{ success: boolean; error?: string; settings: LlmPublicSettings }>
    listLlmModels: (baseUrl: string, apiKey?: string) => Promise<{ ok: boolean; models: string[]; error?: string }>
    testLlm: (baseUrl: string, model: string, apiKey?: string) => Promise<{ ok: boolean; error?: string }>
    clearHistory: (options?: { startup?: boolean }) => Promise<boolean>
    respondPermission: (requestId: string, approved: boolean) => Promise<boolean>
    cancel: () => Promise<boolean>
    getStatus: () => Promise<{ isRunning: boolean; mode: string }>
    onEvent: (callback: (event: AgentEventPayload) => void) => () => void
  }
  terminal: {
    input: (command: string, cwd: string) => Promise<boolean>
    onData: (callback: (data: string) => void) => () => void
  }
  setup: {
    getStatus: () => Promise<SetupStatus>
    run: (step: 'python' | 'ffmpeg' | 'ollama' | 'model' | 'persona' | 'whisper' | 'vision' | 'qwen3tts', options?: { qwen?: Partial<QwenTtsConfig> }) => Promise<{ ok: boolean; status: SetupStatus }>
    qwenStatus: (qwen?: Partial<QwenTtsConfig>) => Promise<{ ready: boolean; reason: string }>
    onLog: (callback: (entry: { step: string; line: string }) => void) => () => void
    finish: () => Promise<boolean>
    open: () => Promise<boolean>
    getStorage: () => Promise<string | null>
    chooseStorage: (reset?: boolean) => Promise<{
      root: string | null
      items: { kind: 'models' | 'whisper' | 'voiceEnv' | 'tools'; from: string; to: string; bytes: number }[]
      ollamaProgram: { from: string; to: string; bytes: number } | null
      neededBytes: number
      freeBytes: number | null
      enoughSpace: boolean
      invalid: boolean
    } | null>
    moveStorage: (root: string | null) => Promise<{ ok: boolean; root: string | null; status: any }>
  }
  system: {
    selectDirectory: () => Promise<string | null>
    getCwd: () => Promise<string>
    listFiles: (rootDir: string) => Promise<string[]>
    listDir: (rootDir: string, relDir?: string) => Promise<{ name: string; path: string; isDir: boolean }[]>
    readFile: (rootDir: string, relPath: string) => Promise<string | null>
    writeFile: (rootDir: string, relPath: string, content: string) => Promise<boolean>
  }
  voice: {
    transcribe: (audioData: ArrayBuffer | Uint8Array, partial?: boolean) => Promise<{ success: boolean; text?: string; error?: string }>
    sttState: () => Promise<'off' | 'loading' | 'ready' | 'failed'>
    getArrowKeys: () => Promise<boolean>
    setArrowKeys: (enabled: boolean) => Promise<boolean>
    getHotkeys: () => Promise<Hotkeys>
    setHotkey: (action: HotkeyAction, accelerator: string) => Promise<{ hotkeys: Hotkeys; problem: HotkeyProblem | null }>
    resetHotkeys: () => Promise<Hotkeys>
    onHotkeysChanged: (callback: (hotkeys: Hotkeys) => void) => () => void
    synthesize: (text: string, langOverride?: string) => Promise<{ success: boolean; audioDataUrl?: string; error?: string }>
    previewQwen: (text: string, qwen: Partial<QwenTtsConfig>) => Promise<{ success: boolean; audioDataUrl?: string; error?: string }>
    pickReference: () => Promise<{ path: string; name: string } | null>
    transcribeReference: (file: string) => Promise<{ success: boolean; text?: string; error?: string }>
    designReference: (text: string, description: string, lang?: string) => Promise<{ success: boolean; path?: string; error?: string }>
    getConfig: () => Promise<any>
    setConfig: (config: any) => Promise<{ success: boolean; config?: any; error?: string }>
    onToggleRecording: (callback: () => void) => () => void
    setRecordingState: (active: boolean) => void
    onCancelRecording: (callback: () => void) => () => void
    onToggleAlwaysListening: (callback: () => void) => () => void
    wakeCheck: (text: string) => Promise<{ addressed: boolean; text: string; reason: 'wake_word' | 'macro' | 'none' }>
  }
  benchmark: {
    run: (req: BenchmarkRequest) => Promise<BenchmarkResult>
  }
  gpu: {
    budget: (preview?: { provider?: TtsProviderId; qwenSize?: QwenTtsSize }) => Promise<GpuBudget>
  }
  logs: {
    get: () => Promise<LogLine[]>
    copyBugReport: () => Promise<BugReportResult>
    watch: (callback: (lines: LogLine[]) => void) => () => void
  }
  media: {
    control: (action: 'play' | 'pause' | 'play_pause' | 'next' | 'prev') => Promise<{ success: boolean; output: string }>
    getStatus: () => Promise<{ isPlaying: boolean; title: string }>
  }
  boredom: {
    getEnabled: () => Promise<boolean>
    setEnabled: (enabled: boolean) => Promise<boolean>
    trigger: (category?: 'spotify' | 'youtube' | 'web_search') => Promise<boolean>
  }
  triggerClip: () => Promise<{ success: boolean; message?: string }>
  scanner: {
    fitScreen: () => Promise<ScannerBounds | null>
    setLocalAIEnabled: (enabled:boolean) => Promise<boolean>
    open: () => Promise<boolean>
    close: () => Promise<boolean>
    toggle: () => Promise<boolean>
    getStatus: () => Promise<ScannerStatusPayload>
    setBounds: (bounds: Partial<ScannerBounds>) => Promise<boolean>
    scan: (query?: string) => Promise<ScannerScanResult>
    setContinuous: (enabled: boolean) => Promise<boolean>
    startWatchScreen: () => Promise<boolean>
    stopWatchScreen: () => Promise<boolean>
    toggleWatchScreen: () => Promise<boolean>
    setIgnoreMouse: (ignore: boolean) => Promise<boolean>
    onEvent: (callback: (event: ScannerEventPayload) => void) => () => void
  }
  watchParty: {
    getStatus: () => Promise<WatchPartyStatusPayload>
    startTiktok: () => Promise<boolean>
    startYoutube: () => Promise<boolean>
    startGaming: () => Promise<boolean>
    stop: () => Promise<boolean>
    next: () => Promise<boolean>
    like: () => Promise<boolean>
    onStateChanged?: (callback: (payload: WatchPartyStatusPayload) => void) => () => void
  }
  desktopController: {
    action: (action: string, params?: Record<string, unknown>) => Promise<boolean>
  }
}

declare global {
  interface Window {
    api: IElectronAPI
  }
}
