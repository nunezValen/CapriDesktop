export const IPC_CHANNELS = {
  DESKTOP_COMMENT_STATUS: 'desktop:comment-status',
  DESKTOP_PREFERENCES: 'desktop:preferences',
  DESKTOP_CONFIGURE: 'desktop:configure',
  DESKTOP_LOGIN: 'desktop:login',
  DESKTOP_PLACE: 'desktop:place',
  PLATFORM_STATUS: 'platform:status',
  PLATFORM_PERMISSION: 'platform:permission',
  PLATFORM_OPEN_PERMISSION: 'platform:openPermission',
  SPOTIFY_SETTINGS: 'spotify:settings',
  SPOTIFY_CONFIGURE: 'spotify:configure',
  SPOTIFY_CONNECT: 'spotify:connect',
  SPOTIFY_DISCONNECT: 'spotify:disconnect',
  SPOTIFY_DEVICES: 'spotify:devices',
  SPOTIFY_PLAY: 'spotify:play',
  // Window
  DECK_TOGGLE: 'deck:toggle',
  COMPANION_MENU: 'companion:menu',
  COMPANION_CHAT_ACTIVE: 'companion:chatActive',
  DESKTOP_OPEN_SETTINGS: 'desktop:settings',
  DECK_SHOW: 'deck:show',
  DECK_HIDE: 'deck:hide',
  DECK_STATUS: 'deck:status',
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_CLOSE: 'window:close',

  // Companion
  COMPANION_SET_STATE: 'companion:setState',
  COMPANION_GET_STATE: 'companion:getState',
  COMPANION_STATE_CHANGED: 'companion:stateChanged',
  COMPANION_SPEAK: 'companion:speak',
  COMPANION_END_CAMEO: 'companion:endCameo',
  COMPANION_REMEMBER_SUPPORTER: 'companion:rememberSupporter',
  COMPANION_WARM_SUPPORTERS: 'companion:warmSupporters',
  COMPANION_SPEECH_CHANGED: 'companion:speechChanged',
  COMPANION_SET_TAB_MODE: 'companion:setTabMode',
  COMPANION_SET_EYE_MODE: 'companion:setEyeMode',
  COMPANION_SET_GAMING_MODE: 'companion:setGamingMode',
  COMPANION_GET_GAMING_MODE: 'companion:getGamingMode',
  COMPANION_GAMING_MODE_CHANGED: 'companion:gamingModeChanged',
  COMPANION_SET_CLICK_THROUGH: 'companion:setClickThrough',
  COMPANION_SET_HIT_THROUGH: 'companion:setHitThrough',
  DISPLAYS_LIST: 'displays:list',
  DISPLAYS_MOVE: 'displays:move',
  BOREDOM_GET_ENABLED: 'boredom:getEnabled',
  BOREDOM_SET_ENABLED: 'boredom:setEnabled',
  SETUP_GET_STORAGE: 'setup:getStorage',
  SETUP_CHOOSE_STORAGE: 'setup:chooseStorage',
  SETUP_MOVE_STORAGE: 'setup:moveStorage',
  COMPANION_SCRIPT_EVENT: 'companion:scriptEvent',
  COMPANION_SCRIPT_LINE_DONE: 'companion:scriptLineDone',
  COMPANION_SCRIPT_CANCEL: 'companion:scriptCancel',
  COMPANION_VOICE_BUSY: 'companion:voiceBusy',
  WINDOW_FORWARDED_MOUSE: 'window:forwardedMouse',
  COMPANION_TOGGLE_CHAT: 'companion:toggleChat',
  VOICE_TOGGLE_ALWAYS_LISTENING: 'voice:toggleAlwaysListening',
  VOICE_WAKE_CHECK: 'voice:wakeCheck',
  COMPANION_MOVE_BY: 'companion:moveBy',
  COMPANION_GET_CONSCIOUSNESS: 'companion:getConsciousness',
  COMPANION_GET_LANGUAGE: 'companion:getLanguage',
  COMPANION_LINE_LANGUAGE: 'companion:lineLanguage',
  COMPANION_SET_LANGUAGE: 'companion:setLanguage',
  COMPANION_LANGUAGE_CHANGED: 'companion:languageChanged',
  COMPANION_GET_MUSIC_PLATFORM: 'companion:getMusicPlatform',
  COMPANION_SET_MUSIC_PLATFORM: 'companion:setMusicPlatform',
  COMPANION_GET_LANGUAGE_SETTINGS: 'companion:getLanguageSettings',
  COMPANION_GET_USER_PROFILE: 'companion:getUserProfile',
  COMPANION_SET_USER_NAME: 'companion:setUserName',
  COMPANION_USER_NAME_CHANGED: 'companion:userNameChanged',
  SETUP_STATUS: 'setup:status',
  SETUP_RUN: 'setup:run',
  SETUP_QWEN_STATUS: 'setup:qwenStatus',
  SETUP_LOG: 'setup:log',
  ONBOARDING_FINISH: 'onboarding:finish',
  ONBOARDING_OPEN: 'onboarding:open',
  COMPANION_SET_LANGUAGE_SETTINGS: 'companion:setLanguageSettings',

  // Desktop Roaming & Walking
  ROAMING_TOGGLE: 'roaming:toggle',
  ROAMING_SET_ACTIVE: 'roaming:setActive',
  ROAMING_GET_STATUS: 'roaming:getStatus',
  ROAMING_STATE_CHANGED: 'roaming:stateChanged',

  // Mini-Games & Playful actions
  GAME_CATCH_START: 'game:catchStart',
  GAME_CATCH_SUCCESS: 'game:catchSuccess',
  BOREDOM_TRIGGER: 'boredom:trigger',

  // Cyberpunk 2077 Integration
  CYBERPUNK_MARK_POI: 'cyberpunk:markPoi',
  CYBERPUNK_CLEAR_POI: 'cyberpunk:clearPoi',
  CYBERPUNK_MARK_GIG: 'cyberpunk:markGig',

  // Agent Core
  AGENT_SEND_PROMPT: 'agent:sendPrompt',
  AGENT_EVENT: 'agent:event',
  AGENT_PERMISSION_RESPONSE: 'agent:permissionResponse',
  AGENT_CANCEL: 'agent:cancel',
  AGENT_GET_STATUS: 'agent:getStatus',
  AGENT_GET_CONFIG: 'agent:getConfig',
  AGENT_SET_CONFIG: 'agent:setConfig',
  AGENT_DETECT_OLLAMA: 'agent:detectOllama',
  AGENT_CLEAR_HISTORY: 'agent:clearHistory',
  // adds editable system prompt (Capri // Brain settings)
  AGENT_GET_SYSTEM_PROMPT: 'agent:getSystemPrompt',
  AGENT_SET_SYSTEM_PROMPT: 'agent:setSystemPrompt',
  AGENT_RESET_SYSTEM_PROMPT: 'agent:resetSystemPrompt',
  AGENT_SET_PERSONA_STYLE: 'agent:setPersonaStyle',
  // Her long-term memory (Capri // Brain settings)
  MEMORY_GET: 'memory:get',
  MEMORY_SET_ENABLED: 'memory:setEnabled',
  MEMORY_ADD: 'memory:add',
  MEMORY_DELETE: 'memory:delete',
  MEMORY_CLEAR: 'memory:clear',
  MEMORY_CHANGED: 'memory:changed',
  // The apps she knows by name (Dev Deck > Apps)
  APPS_LIST: 'apps:list',
  APPS_PICK: 'apps:pick',
  APPS_RENAME: 'apps:rename',
  APPS_REMOVE: 'apps:remove',
  APPS_OPEN: 'apps:open',
  APPS_CHANGED: 'apps:changed',
  // Downloading local models (Capri // Brain)
  OLLAMA_PULL: 'ollama:pull',
  COMPANION_SCALE_GET: 'companion:getScale',
  ADMIN_GET: 'admin:get',
  // The user's AI apps (Antigravity, Claude Code, Codex) as her model
  AI_APPS_LIST: 'aiApps:list',
  AI_APPS_TEST: 'aiApps:test',
  // Local models and installed parts (Capri // Brain)
  MODELS_LIST: 'models:list',
  MODEL_DELETE: 'models:delete',
  VISION_MODEL_GET: 'models:getVision',
  VISION_MODEL_SET: 'models:setVision',
  PARTS_LIST: 'parts:list',
  PART_REMOVE: 'parts:remove',
  ADMIN_SET: 'admin:set',
  COMPANION_SCALE_SET: 'companion:setScale',
  // Where Cyberpunk 2077 and Capri's mod are (Apps window)
  CYBERPUNK_FOLDERS_GET: 'cyberpunk:getFolders',
  CYBERPUNK_FOLDER_PICK: 'cyberpunk:pickFolder',
  CYBERPUNK_FOLDER_REMOVE: 'cyberpunk:removeFolder',
  OLLAMA_PULL_CANCEL: 'ollama:pullCancel',
  OLLAMA_IMPORT_GGUF: 'ollama:importGguf',
  OLLAMA_PULL_PROGRESS: 'ollama:pullProgress',
  LLM_GET_SETTINGS: 'llm:getSettings',
  LLM_SET_SETTINGS: 'llm:setSettings',
  LLM_LIST_MODELS: 'llm:listModels',
  LLM_TEST: 'llm:test',

  // Terminal & System
  TERMINAL_INPUT: 'terminal:input',
  TERMINAL_DATA: 'terminal:data',
  TERMINAL_CLEAR: 'terminal:clear',
  DIALOG_SELECT_DIRECTORY: 'dialog:selectDirectory',
  SYSTEM_GET_CWD: 'system:getCwd',
  SYSTEM_OPEN_EXTERNAL: 'system:openExternal',
  FS_LIST_FILES: 'fs:listFiles',
  FS_LIST_DIR: 'fs:listDir',
  FS_READ_FILE: 'fs:readFile',
  FS_WRITE_FILE: 'fs:writeFile',

  // Voice Core (Speech-to-Text and Text-to-Speech)
  VOICE_TRANSCRIBE: 'voice:transcribe',
  VOICE_STT_STATE: 'voice:sttState',
  ARROW_KEYS_GET: 'shortcuts:getArrowKeys',
  ARROW_KEYS_SET: 'shortcuts:setArrowKeys',
  HOTKEYS_GET: 'shortcuts:getHotkeys',
  HOTKEYS_SET: 'shortcuts:setHotkey',
  HOTKEYS_RESET: 'shortcuts:resetHotkeys',
  HOTKEYS_CHANGED: 'shortcuts:hotkeysChanged',
  GAMING_OPACITY_GET: 'companion:getGamingOpacity',
  GAMING_OPACITY_SET: 'companion:setGamingOpacity',
  GAMING_OPACITY_CHANGED: 'companion:gamingOpacityChanged',
  VOICE_SYNTHESIZE: 'voice:synthesize',
  VOICE_QWEN_PREVIEW: 'voice:qwen-preview',
  VOICE_PICK_REFERENCE: 'voice:pick-reference',
  VOICE_TRANSCRIBE_REFERENCE: 'voice:transcribe-reference',
  VOICE_DESIGN_REFERENCE: 'voice:design-reference',
  BENCHMARK_RUN: 'benchmark:run',
  GPU_BUDGET_GET: 'gpu:budget',
  LOGS_GET: 'logs:get',
  LOGS_SUBSCRIBE: 'logs:subscribe',
  LOGS_UNSUBSCRIBE: 'logs:unsubscribe',
  /** Main -> renderer: new log lines for the Logs panel, in batches */
  LOGS_LINES: 'logs:lines',
  BUG_REPORT_COPY: 'logs:copyBugReport',
  VOICE_TOGGLE_RECORDING: 'voice:toggle-recording',
  /** Renderer -> main: push-to-talk recording started/stopped (enables the global Esc to cancel) */
  VOICE_RECORDING_STATE: 'voice:recording-state',
  /** Main -> renderer: discard the current recording without sending it */
  VOICE_CANCEL_RECORDING: 'voice:cancel-recording',
  VOICE_GET_CONFIG: 'voice:get-config',
  VOICE_SET_CONFIG: 'voice:set-config',

  // Media Controls (Spotify)
  MEDIA_CONTROL: 'media:control',
  MEDIA_GET_STATUS: 'media:getStatus',

  // NVIDIA ShadowPlay Instant Replay Clipping
  SYSTEM_TRIGGER_CLIP: 'system:triggerClip',

  // Scanner Mode (Screen Region Vision Analysis)
  SCANNER_OPEN: 'scanner:open',
  SCANNER_CLOSE: 'scanner:close',
  SCANNER_TOGGLE: 'scanner:toggle',
  SCANNER_GET_STATUS: 'scanner:getStatus',
  SCANNER_FIT_SCREEN: 'scanner:fit-screen',
  SCANNER_LOCAL_AI: 'scanner:local-ai',
  SCANNER_SET_BOUNDS: 'scanner:setBounds',
  SCANNER_SCAN: 'scanner:scan',
  SCANNER_SET_CONTINUOUS: 'scanner:setContinuous',
  SCANNER_SET_IGNORE_MOUSE: 'scanner:setIgnoreMouse',
  SCANNER_WATCH_SCREEN_START: 'scanner:watchScreenStart',
  SCANNER_WATCH_SCREEN_STOP: 'scanner:watchScreenStop',
  SCANNER_WATCH_SCREEN_TOGGLE: 'scanner:watchScreenToggle',
  SCANNER_EVENT: 'scanner:event',

  // Watch Party & Desktop Control
  WATCH_PARTY_STATE_CHANGED: 'watchParty:stateChanged',
  DESKTOP_CONTROLLER_ACTION: 'desktopController:action'
} as const

export type CompanionEmotionState =
  | 'idle'
  | 'idle_front'
  | 'thinking'
  | 'working'
  | 'happy'
  | 'talking'
  | 'sleep'
  | 'curious'
  | 'standing'
  | 'walking'
  | 'ojos'
  | 'ojos2'
  | 'capri2'
  | 'closed'
  | 'asustada'

export interface RoamingStatusPayload {
  isRoaming: boolean
  isPaused: boolean
  direction: 'left' | 'right'
  speed: number
  isCatchGameActive: boolean
  gameTimeRemaining?: number
  isTabMode?: boolean
  currentBehavior?: 'walking' | 'still' | 'tab'
}

/** Capri's own local agent is the only engine */
export type AgentMode = 'capri-local'

export interface AgentConfigPayload {
  mode: AgentMode
  endpoint: string
  model: string
  apiKey: string
}

// What the settings window needs to show and edit the system prompt
export interface SystemPromptPayload {
  prompt: string
  defaultPrompt: string
  isCustom: boolean
  tone: 'default' | 'warm' | 'calm' | 'chaotic'
  teasing: 'default' | 'none' | 'light' | 'heavy'
}

export interface AgentEventPayload {
  type:
    | 'session.started'
    | 'assistant.delta'
    | 'tool.started'
    | 'tool.finished'
    | 'permission.requested'
    | 'session.finished'
    | 'session.error'
  text?: string
  /** The script player is already saying this text, part by part */
  spokenByScript?: boolean
  toolName?: string
  toolInput?: Record<string, unknown>
  toolOutput?: string
  requestId?: string
  permissionDescription?: string
  success?: boolean
  error?: string
  timestamp?: number
  source?: 'pet' | 'editor'
}

export interface ScannerBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface ScannerStatusPayload {
  localAIEnabled?: boolean
  visionMode?: 'cloud' | 'local' | 'disabled'
  isOpen: boolean
  isScanning: boolean
  isContinuous: boolean
  bounds: ScannerBounds
  isWatchingScreen?: boolean
  isFullscreenWatch?: boolean
}

export interface ScannerScanResult {
  success: boolean
  summary?: string
  tags?: string[]
  response?: string
  error?: string
}

export interface ScannerEventPayload {
  type: 'scanning' | 'result' | 'error' | 'status'
  isScanning?: boolean
  isContinuous?: boolean
  isWatchingScreen?: boolean
  isFullscreenWatch?: boolean
  result?: ScannerScanResult
  tags?: string[]
  error?: string
  reaction?: string
}

/** A hand-written script playing part by part (see services/script) */
export type ScriptEventPayload =
  | { kind: 'start' }
  | { kind: 'end' }
  | { kind: 'look'; look: 'ojos' | 'ojos2' | 'closed' | 'thinking' | 'asustada' | null }
  | { kind: 'line'; id: number; text: string; audioDataUrl?: string; look?: 'ojos' | 'ojos2' | 'closed' | 'thinking' | 'asustada' }

export type WatchPartyMode = 'idle' | 'tiktok' | 'youtube' | 'gaming'

export interface WatchPartyCursor {
  x: number
  y: number
  visible: boolean
  isClicking?: boolean
  isScrolling?: boolean
  targetLabel?: string
}

export interface WatchPartyStatusPayload {
  mode: WatchPartyMode
  active: boolean
  isBrowsingFeed: boolean
  candidateTitle?: string
  lastReaction?: string
  cursor?: WatchPartyCursor
}
