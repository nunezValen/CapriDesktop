import { featureSettings, saveFeatures } from '../services/mac-feature-settings'
import { scheduleScreenComments, screenCommentStatus } from '../services/screen-comment-service'
import { screen as desktopScreen } from 'electron'
import { setLocalAIEnabled } from '../services/local-ai-policy'
import { getStorageRoot } from '../services/storage-location'
import { scriptPlayer } from '../services/script/script-player'
import { getLlmSettings, listCloudModels, setLlmSettings, testCloudConnection, type LlmSettingsUpdate } from '../services/llm-gateway'
import { setupService, SetupStep } from '../services/setup-service'
import { supporterReaction, warmSupporterModel } from '../services/supporter-reaction'
import * as os from 'os'
import { getUserName } from '../services/user-profile'
import { ipcMain, dialog, BrowserWindow, shell, Menu } from 'electron'
import fs from 'fs'
import path from 'path'
import { IPC_CHANNELS, CompanionEmotionState } from './channels'
import { windowManager } from '../windows/window-manager'
import { agentManager } from '../agents/agent-manager'
import { terminalManager } from '../terminal/terminal-manager'
import { roamingManager } from '../roaming/roaming-manager'
import { voiceService } from '../services/voice-service'
import { benchmarkService } from '../services/benchmark-service'
import type { QwenTtsConfig } from '../../shared/qwen-tts'
import { voiceDataDir } from '../services/app-paths'
import { computeGpuBudget, type BudgetPreview } from '../services/gpu-budget-service'
import type { BenchmarkRequest } from '../../shared/benchmark'
import { checkAddressed } from '../services/wake-word'
import { consciousnessService } from '../services/consciousness-service'
import { localizeLine } from '../../shared/lines'
import { ToolExecutor } from '../agents/tools/tool-executor'
import type { HotkeyAction } from '../../shared/hotkeys'
import { scannerService } from '../services/scanner-service'
import { cloudSttProvider, STT_ENGINES, type SttEngine } from '../services/cloud-stt'
import { watchPartyService } from '../services/watch-party-service'
import { desktopController } from '../services/desktop-controller-service'
import { boredomService } from '../services/boredom-service'
import { cyberpunkAdapter } from '../services/game'
import { CYBERPUNK_GIGS, getNextGig } from '../services/game/adapters/cyberpunk/gigs'
import { clipService } from '../services/clip-service'
import { welcomeSpeech } from '../services/welcome-speech'
import { getSystemPromptInfo, setSystemPrompt, resetSystemPrompt, setPersonaStyle } from '../services/system-prompt-store'
import { memoryService } from '../services/memory-service'
import { addKnownApp, listKnownApps, onKnownAppsChanged, removeKnownApp, renameKnownApp, suggestedAppName } from '../services/known-apps'
import { openKnownApp } from '../services/app-launcher'
import { ollamaService } from '../services/ollama-service'
import { isElevated, relaunchElevated } from '../services/admin-mode'
import { isAiAppId, listAiApps, testAiApp } from '../services/ai-apps'
import { deleteLocalModel, listInstalledParts, listLocalModels, removeInstalledPart, type InstalledPartId } from '../services/installed-parts'
import { cyberpunkFoldersState, markCyberpunkFolder, unmarkCyberpunkFolder } from '../services/game/adapters/cyberpunk/cyberpunk-folders'

import { platformStatus, requestPermission, openPermission } from '../services/mac-permissions'
import { spotifyService } from '../services/spotify-service'
import { isMac } from '../services/platform'

import { desktopPreferences, setOpenAtLogin } from '../services/mac-preferences'
import type { PlacementCommand } from '../../shared/placement'
export function registerIpcHandlers(): void {
  const openSettings = (voice = false) => {
    windowManager.showDeck()
    const win = windowManager.getDeckWindow()
    const send = () => win?.webContents.send(voice ? 'desktop:open-voice-settings' : 'desktop:open-settings')
    if (win?.webContents.isLoading()) win.webContents.once('did-finish-load', send)
    else send()
  }
  ipcMain.handle(IPC_CHANNELS.DESKTOP_OPEN_SETTINGS, (_event, voice) => {
    if (isMac) openSettings(voice === true)
  })
  ipcMain.handle(IPC_CHANNELS.COMPANION_CHAT_ACTIVE, (event, active) => {
    const win=windowManager.getCompanionWindow()
    if (isMac && win && event.sender===win.webContents && active===true) {windowManager.setCompanionClickThrough(false);win.focus()}
  })
  ipcMain.handle(IPC_CHANNELS.COMPANION_MENU, event => {
    const win = windowManager.getCompanionWindow()
    if (!isMac || !win || event.sender !== win.webContents) return
    const prefs = featureSettings()
    Menu.buildFromTemplate([
      { label: 'Chat · ⌘⌥C', click: () => windowManager.broadcast(IPC_CHANNELS.COMPANION_TOGGLE_CHAT) },
      { label: 'Toggle Hey Capri · ⌘⌥L', click: () => windowManager.broadcast(IPC_CHANNELS.VOICE_TOGGLE_ALWAYS_LISTENING) },
      { type: 'separator' },
      { label: 'Game mode', type: 'checkbox', checked: windowManager.isGamingModeActive(), click: item => windowManager.setGamingMode(item.checked) },
      { label: 'Game-mode comments', submenu: [
        { label: 'Screenshots go to your cloud vision provider', enabled: false },
        ...[0,1,3,5,10].map(minutes => ({ label: minutes ? `Every ${minutes} minute${minutes===1 ? '' : 's'}` : 'Off', type: 'radio' as const, checked: prefs.gameCommentMinutes===minutes, click: () => { saveFeatures({gameCommentMinutes:minutes}); scheduleScreenComments() } }))
      ] },
      { label: 'Scanner · ⌘⌥S', click: () => scannerService.toggle() },
      { type: 'separator' },
      { label: 'Voice & companion settings…', click: () => openSettings(true) },
      { label: 'Settings…', click: () => openSettings() },
      { label: 'Open main app', click: () => windowManager.showDeck() }
    ]).popup({ window: win })
  })
  ipcMain.handle(IPC_CHANNELS.DESKTOP_CONFIGURE,(_event,update)=>{
    if(!isMac || !update || typeof update!=='object') throw new Error('Invalid Mac settings')
    saveFeatures(update)
    if(update.speechModel!==undefined) voiceService.stopServer()
    if(update.screenCommentMinutes!==undefined || update.gameCommentMinutes!==undefined) scheduleScreenComments()
    return desktopPreferences()
  })
  ipcMain.handle(IPC_CHANNELS.DESKTOP_COMMENT_STATUS,()=>screenCommentStatus())
  ipcMain.handle(IPC_CHANNELS.DESKTOP_PREFERENCES,()=>desktopPreferences())
  ipcMain.handle(IPC_CHANNELS.DESKTOP_LOGIN,(_event,enabled)=>setOpenAtLogin(enabled))
  ipcMain.handle(IPC_CHANNELS.DESKTOP_PLACE,(_event,target:PlacementCommand)=>{
    if (!isMac || !['here','roam','bottom','bottom-left','bottom-right','top','top-left','top-right','left','right','center'].includes(target)) throw new Error('Invalid desktop position')
    if (target==='roam') roamingManager.start(true); else roamingManager.pinPosition(target)
    return desktopPreferences()
  })

  ipcMain.handle(IPC_CHANNELS.PLATFORM_STATUS, () => platformStatus())
  ipcMain.handle(IPC_CHANNELS.PLATFORM_PERMISSION, (_e, permission) => requestPermission(permission))
  ipcMain.handle(IPC_CHANNELS.PLATFORM_OPEN_PERMISSION, (_e, permission) => openPermission(permission))
  ipcMain.handle(IPC_CHANNELS.SPOTIFY_SETTINGS, () => spotifyService.settings())
  ipcMain.handle(IPC_CHANNELS.SPOTIFY_CONFIGURE, (_e, settings) => { if (!isMac) throw new Error('Mac-only setting'); return spotifyService.configure(settings) })
  ipcMain.handle(IPC_CHANNELS.SPOTIFY_CONNECT, () => { if (!isMac) throw new Error('Mac-only setting'); return spotifyService.connect() })
  ipcMain.handle(IPC_CHANNELS.SPOTIFY_DISCONNECT, () => spotifyService.disconnect())
  ipcMain.handle(IPC_CHANNELS.SPOTIFY_DEVICES, () => spotifyService.devices())
  ipcMain.handle(IPC_CHANNELS.SPOTIFY_PLAY, (_e, query) => { if (!isMac || typeof query !== 'string' || query.length > 500) throw new Error('Invalid Spotify query'); return spotifyService.play(query) })

  // Deck window visibility
  ipcMain.handle(IPC_CHANNELS.DECK_TOGGLE, () => {
    return windowManager.toggleDeck()
  })

  ipcMain.handle(IPC_CHANNELS.DECK_SHOW, () => {
    windowManager.showDeck()
    return true
  })

  ipcMain.handle(IPC_CHANNELS.DECK_HIDE, () => {
    windowManager.hideDeck()
    return false
  })

  ipcMain.handle(IPC_CHANNELS.DECK_STATUS, () => {
    const deck = windowManager.getDeckWindow()
    return deck ? deck.isVisible() : false
  })

  // Window control (minimize, close)
  ipcMain.handle(IPC_CHANNELS.WINDOW_MINIMIZE, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) {
      if (win === windowManager.getDeckWindow()) {
        // If minimizing the deck, restore desktop companion
        windowManager.hideDeck()
      } else {
        win.minimize()
      }
    }
  })

  ipcMain.handle(IPC_CHANNELS.WINDOW_CLOSE, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) {
      if (win === windowManager.getDeckWindow()) {
        windowManager.hideDeck()
      } else {
        win.close()
      }
    }
  })

  // Desktop Roaming & Walking
  ipcMain.handle(IPC_CHANNELS.ROAMING_TOGGLE, () => {
    return roamingManager.toggle()
  })

  ipcMain.handle(IPC_CHANNELS.ROAMING_SET_ACTIVE, (_event, active: boolean) => {
    if (active) roamingManager.start()
    else roamingManager.stop()
    return roamingManager.getStatus()
  })

  ipcMain.handle(IPC_CHANNELS.ROAMING_GET_STATUS, () => {
    return roamingManager.getStatus()
  })

  // Mini-game Catch Capri
  ipcMain.handle(IPC_CHANNELS.GAME_CATCH_START, () => {
    roamingManager.startCatchGame()
    return true
  })

  ipcMain.handle(IPC_CHANNELS.GAME_CATCH_SUCCESS, () => {
    roamingManager.handleCatchSuccess()
    return true
  })

  // External web tabs (game links, cyberpunk music, etc.)
  ipcMain.handle(IPC_CHANNELS.SYSTEM_OPEN_EXTERNAL, async (_event, url: string) => {
    if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
      await shell.openExternal(url)
      return true
    }
    return false
  })

  // Companion state & speech
  ipcMain.handle(
    IPC_CHANNELS.COMPANION_SET_STATE,
    (_event, state: CompanionEmotionState) => {
      agentManager.setCompanionState(state)
      return state
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.COMPANION_SPEAK,
    (_event, payload: { text: string; durationMs?: number; speakVoice?: boolean; cameo?: boolean }) => {
      agentManager.setCompanionSpeech(payload.text, payload.durationMs, !!payload.speakVoice, undefined, false, !!payload.cameo)
      return true
    }
  )
  ipcMain.handle(IPC_CHANNELS.COMPANION_END_CAMEO, () => windowManager.endCompanionCameo())
  // A supporter's message, read out loud above the Deck, followed by what she has to say about it
  ipcMain.handle(
    IPC_CHANNELS.COMPANION_REMEMBER_SUPPORTER,
    async (_event, payload: { name: string; message: string; line: string }) => {
      // She starts reading right away; her answer follows as soon as the model has it
      const line = String(payload.line || '')
      const message = String(payload.message || '')
      agentManager.setCompanionSpeech(line, Math.max(5000, line.length * 70), true, undefined, false, message.trim() ? 'hold' : true)
      const reaction = await supporterReaction(String(payload.name || ''), message, consciousnessService.getPreferredLanguage())
      if (reaction) {
        console.log(`[Supporters] Her answer to ${payload.name}: "${reaction}"`)
        agentManager.setCompanionSpeech(reaction, Math.max(4000, reaction.length * 70), true, undefined, false, true)
      }
      if (message.trim()) agentManager.releaseCameoHold()
      return reaction || ''
    }
  )
  ipcMain.handle(IPC_CHANNELS.COMPANION_WARM_SUPPORTERS, () => warmSupporterModel())

  // Top-Right Tab Mode (Modo Pestaña en esquina superior derecha)
  ipcMain.handle(
    IPC_CHANNELS.COMPANION_SET_TAB_MODE,
    (_event, enabled: boolean, keepPosition = true) => {
      return windowManager.setTabMode(enabled, undefined, keepPosition)
    }
  )

  // Modo Ojos (Eye Mode - freezes walking and roaming completely)
  ipcMain.handle(
    IPC_CHANNELS.COMPANION_SET_EYE_MODE,
    (_event, enabled: boolean) => {
      roamingManager.setEyeMode(enabled)
      return true
    }
  )

  // Modo Gaming (Docked in corner, eyes loop, screen-saver topmost priority)
  ipcMain.handle(
    IPC_CHANNELS.COMPANION_SET_GAMING_MODE,
    (_event, enabled: boolean, corner = 'bottom-right') => {
      windowManager.setGamingMode(enabled, corner as any)
      return true
    }
  )

  // Always-listening gate: was this utterance addressed to Capri?
  ipcMain.handle(IPC_CHANNELS.VOICE_WAKE_CHECK, async (_event, text: string) => checkAddressed(text))

  ipcMain.handle(
    IPC_CHANNELS.COMPANION_SET_CLICK_THROUGH,
    (_event, ignore: boolean) => {
      windowManager.setCompanionClickThrough(!!ignore)
      return true
    }
  )

  ipcMain.handle(IPC_CHANNELS.COMPANION_GET_GAMING_MODE, () => {
    return windowManager.isGamingModeActive()
  })

  // Shift + Drag move Capri across screen
  ipcMain.handle(
    IPC_CHANNELS.COMPANION_MOVE_BY,
    (_event, payload: { dx: number; dy: number }) => {
      const win = windowManager.getCompanionWindow()
      if (win && !win.isDestroyed()) {
        const bounds = win.getBounds()
        const newX = bounds.x + payload.dx
        const newY = bounds.y + payload.dy
        // With the size given too: setPosition alone grows the window on scaled screens
        win.setBounds({ x: newX, y: newY, width: bounds.width, height: bounds.height }, false)
        if (windowManager.isGamingModeActive()) {
          windowManager.setSavedGamingPosition({ x: newX, y: newY })
        } else {
          roamingManager.notifyUserDrag(newX, newY)
        }
        return { x: newX, y: newY }
      }
      return null
    }
  )

  // Autonomous Boredom Action (Trigger on-demand or test)
  ipcMain.handle(
    IPC_CHANNELS.BOREDOM_TRIGGER,
    async (_event, category?: 'spotify' | 'youtube' | 'web_search') => {
      return await boredomService.triggerBoredomAction(category)
    }
  )

  // Consciousness and reboot stats
  ipcMain.handle(IPC_CHANNELS.COMPANION_GET_CONSCIOUSNESS, () => {
    return {
      ...consciousnessService.getData(),
      // The language lines go out in, not the stored one, which resets to English on load
      preferredLanguage: consciousnessService.getPreferredLanguage(),
      bootGreeting: localizeLine(consciousnessService.getBootGreeting(), consciousnessService.getPreferredLanguage())
    }
  })

  // Preferred Language management
  ipcMain.handle(IPC_CHANNELS.COMPANION_GET_LANGUAGE, () => {
    return consciousnessService.getUiLanguage()
  })
  consciousnessService.onSpokenLanguageChanged((lang) => windowManager.broadcast(IPC_CHANNELS.COMPANION_LINE_LANGUAGE, lang))

  // Spoken language already configured from a previous session: warm the translator in the background
  if (consciousnessService.getLanguageSettings().speechLang !== 'auto') {
    setTimeout(() => voiceService.warmTranslator(), 5000)
  }

  ipcMain.handle(IPC_CHANNELS.COMPANION_GET_MUSIC_PLATFORM, () => consciousnessService.getMusicPlatform())
  ipcMain.handle(IPC_CHANNELS.COMPANION_SET_MUSIC_PLATFORM, (_event, platform) => consciousnessService.setMusicPlatform(platform))

  // With the cloud service the saved API key opens, so the window can say whether "cloud" will work
  const languageSettingsView = () => ({ ...consciousnessService.getLanguageSettings(), cloudStt: cloudSttProvider() })
  ipcMain.handle(IPC_CHANNELS.COMPANION_GET_LANGUAGE_SETTINGS, () => languageSettingsView())

  // First-run setup (onboarding window)
  ipcMain.handle(IPC_CHANNELS.SETUP_STATUS, () => setupService.getStatus())

  // Only the model chosen in the panel travels along: the install never saves or activates anything
  const qwenChoice = (raw: unknown): Partial<QwenTtsConfig> | undefined =>
    raw && typeof raw === 'object' ? { mode: (raw as QwenTtsConfig).mode, model_size: (raw as QwenTtsConfig).model_size } : undefined

  ipcMain.handle(IPC_CHANNELS.SETUP_RUN, async (_event, step: SetupStep, options?: { qwen?: Partial<QwenTtsConfig> }) => {
    if (!['python','ffmpeg','ollama','model','persona','whisper','vision','qwen3tts'].includes(step)) throw new Error('Unknown setup step')
    const ok = await setupService.run(step, (s, line) => windowManager.broadcast(IPC_CHANNELS.SETUP_LOG, { step: s, line }), { qwen: qwenChoice(options?.qwen) })
    return { ok, status: await setupService.getStatus() }
  })

  ipcMain.handle(IPC_CHANNELS.SETUP_QWEN_STATUS, (_event, qwen?: Partial<QwenTtsConfig>) => setupService.qwenStatus(qwenChoice(qwen)))

  ipcMain.handle(IPC_CHANNELS.DISPLAYS_LIST, () => windowManager.listDisplays())
  ipcMain.handle(IPC_CHANNELS.DISPLAYS_MOVE, (_event, id: number) => windowManager.moveCompanionToDisplay(id))
  ipcMain.handle(IPC_CHANNELS.BOREDOM_GET_ENABLED, () => consciousnessService.isBoredomEnabled())
  ipcMain.handle(IPC_CHANNELS.BOREDOM_SET_ENABLED, (_event, enabled: boolean) => {
    consciousnessService.setBoredomEnabled(!!enabled)
    return !!enabled
  })

  ipcMain.handle(IPC_CHANNELS.COMPANION_SET_HIT_THROUGH, (_event, ignore: boolean) => {
    windowManager.setCompanionHitThrough(!!ignore)
    return true
  })

  ipcMain.handle(IPC_CHANNELS.SETUP_GET_STORAGE, () => getStorageRoot())
  // What moving there would take. Null if no folder was picked; nothing changes until it's confirmed
  ipcMain.handle(IPC_CHANNELS.SETUP_CHOOSE_STORAGE, async (_event, reset?: boolean) => {
    if (reset) return setupService.planStorageMove(null)
    const picked = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (picked.canceled || !picked.filePaths[0]) return null
    const folder = picked.filePaths[0]
    return setupService.planStorageMove(path.basename(folder).toLowerCase() === 'capridata' ? folder : path.join(folder, 'CapriData'))
  })
  ipcMain.handle(IPC_CHANNELS.SETUP_MOVE_STORAGE, async (_event, root: string | null) => {
    const ok = await setupService.moveStorage(root, (s, line) => windowManager.broadcast(IPC_CHANNELS.SETUP_LOG, { step: s, line }))
    return { ok, root: getStorageRoot(), status: await setupService.getStatus() }
  })

  ipcMain.handle(IPC_CHANNELS.ONBOARDING_OPEN, () => {
    windowManager.openOnboarding()
    return true
  })

  ipcMain.handle(IPC_CHANNELS.ONBOARDING_FINISH, () => {
    const firstTime = !consciousnessService.isOnboardingDone()
    consciousnessService.setOnboardingDone(true)
    windowManager.finishOnboarding()
    // First install: Capri introduces herself once the setup window is gone
    if (firstTime) {
      const s = consciousnessService.getLanguageSettings()
      const lang = s.textLang && s.textLang !== 'auto' ? s.textLang : consciousnessService.getPreferredLanguage()
      setTimeout(() => {
        agentManager.setCompanionState('talking')
        agentManager.setCompanionSpeech(welcomeSpeech(lang, consciousnessService.getHotkeys().talk), 22000, true)
      }, 1500)
    }
    return true
  })

  // How Capri calls the user (set during onboarding, editable later)
  ipcMain.handle(IPC_CHANNELS.COMPANION_GET_USER_PROFILE, () => ({
    name: getUserName(),
    hasName: !!consciousnessService.getUserName(),
    onboardingDone: consciousnessService.isOnboardingDone()
  }))

  ipcMain.handle(IPC_CHANNELS.COMPANION_SET_USER_NAME, (_event, name: string) => {
    const clean = String(name || '').trim()
    if (!clean) return getUserName()
    consciousnessService.setUserName(clean)
    windowManager.broadcast(IPC_CHANNELS.COMPANION_USER_NAME_CHANGED, getUserName())
    return getUserName()
  })

  ipcMain.handle(IPC_CHANNELS.COMPANION_SET_LANGUAGE_SETTINGS, (_event, next: Record<string, string>) => {
    const { sttEngine, ...langs } = next || {}
    const saved = consciousnessService.setLanguageSettings({
      ...langs,
      ...(STT_ENGINES.includes(sttEngine as SttEngine) ? { sttEngine: sttEngine as SttEngine } : {})
    })
    // Spoken language differs from the text: load the translation model now, not on the first line
    if (saved.speechLang && saved.speechLang !== 'auto') voiceService.warmTranslator()
    windowManager.broadcast(IPC_CHANNELS.COMPANION_LANGUAGE_CHANGED, consciousnessService.getUiLanguage())
    return { ...saved, cloudStt: cloudSttProvider() }
  })

  ipcMain.handle(IPC_CHANNELS.COMPANION_SET_LANGUAGE, (_event, lang: string) => {
    consciousnessService.setPreferredLanguage(lang)
    windowManager.broadcast(IPC_CHANNELS.COMPANION_LANGUAGE_CHANGED, lang)
    return lang
  })

  // Agent execution & configuration
  ipcMain.handle(
    IPC_CHANNELS.AGENT_SEND_PROMPT,
    async (_event, payload: { prompt: string; projectPath: string; mode?: any; source?: 'pet' | 'editor' }) => {
      // No workspace picked yet: work from the user's home folder
      await agentManager.sendPrompt(payload.prompt, payload.projectPath || os.homedir(), payload.mode, payload.source)
      return true
    }
  )

  ipcMain.handle(IPC_CHANNELS.AGENT_GET_CONFIG, () => {
    return agentManager.getConfig()
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_SET_CONFIG, (_event, config) => {
    return agentManager.setConfig(config)
  })

  // read, save and reset Capri's editable system prompt
  ipcMain.handle(IPC_CHANNELS.AGENT_GET_SYSTEM_PROMPT, () => getSystemPromptInfo())
  ipcMain.handle(IPC_CHANNELS.AGENT_SET_SYSTEM_PROMPT, (_event, text: string) => setSystemPrompt(text))
  ipcMain.handle(IPC_CHANNELS.AGENT_RESET_SYSTEM_PROMPT, () => resetSystemPrompt())
  ipcMain.handle(IPC_CHANNELS.AGENT_SET_PERSONA_STYLE, (_event, style: { tone?: string; teasing?: string }) => setPersonaStyle(style ?? {}))

  // Her memory: the settings window sees what she learns while it is open
  ipcMain.handle(IPC_CHANNELS.MEMORY_GET, () => memoryService.snapshot())
  ipcMain.handle(IPC_CHANNELS.MEMORY_SET_ENABLED, (_event, enabled: boolean) => memoryService.setEnabled(!!enabled))
  ipcMain.handle(IPC_CHANNELS.MEMORY_ADD, (_event, text: string) => ({ ...memoryService.remember(String(text ?? ''), 'user'), memory: memoryService.snapshot() }))
  ipcMain.handle(IPC_CHANNELS.MEMORY_DELETE, (_event, id: string) => memoryService.deleteFact(String(id ?? '')))
  ipcMain.handle(IPC_CHANNELS.MEMORY_CLEAR, () => memoryService.clearAll())
  memoryService.onChanged(() => windowManager.broadcast(IPC_CHANNELS.MEMORY_CHANGED, memoryService.snapshot()))

  // The apps she knows by name
  ipcMain.handle(IPC_CHANNELS.APPS_LIST, () => listKnownApps())
  // The file is chosen here, in the main process: the window never gets to pass a path of its own
  ipcMain.handle(IPC_CHANNELS.APPS_PICK, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const options: Electron.OpenDialogOptions = {
      properties: ['openFile'],
      defaultPath: process.platform === 'win32' ? process.env.ProgramFiles || 'C:\\' : os.homedir(),
      filters: process.platform === 'win32' ? [{ name: 'Apps', extensions: ['exe', 'lnk', 'url', 'bat', 'cmd'] }] : []
    }
    const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    const file = picked.filePaths[0]
    if (picked.canceled || !file) return null
    return addKnownApp(suggestedAppName(file), file)
  })
  ipcMain.handle(IPC_CHANNELS.APPS_RENAME, (_event, id: string, name: string) => renameKnownApp(String(id ?? ''), String(name ?? '')))
  ipcMain.handle(IPC_CHANNELS.APPS_REMOVE, (_event, id: string) => removeKnownApp(String(id ?? '')))
  ipcMain.handle(IPC_CHANNELS.APPS_OPEN, (_event, id: string) => openKnownApp(String(id ?? '')))
  onKnownAppsChanged(() => windowManager.broadcast(IPC_CHANNELS.APPS_CHANGED, listKnownApps()))

  // Any model from the Ollama library, downloaded from the settings, with progress
  ipcMain.handle(IPC_CHANNELS.OLLAMA_PULL, (_event, model: string) =>
    ollamaService.pullModel(String(model ?? ''), (progress) => windowManager.broadcast(IPC_CHANNELS.OLLAMA_PULL_PROGRESS, progress))
  )
  ipcMain.handle(IPC_CHANNELS.OLLAMA_PULL_CANCEL, () => ollamaService.cancelPull())
  // A .gguf file on this PC, added to Ollama. The file is picked here: the window never passes a path
  ipcMain.handle(IPC_CHANNELS.OLLAMA_IMPORT_GGUF, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const options: Electron.OpenDialogOptions = { properties: ['openFile'], filters: [{ name: 'GGUF', extensions: ['gguf'] }] }
    const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    const file = picked.filePaths[0]
    if (picked.canceled || !file) return false
    return ollamaService.importGguf(file, (progress) => windowManager.broadcast(IPC_CHANNELS.OLLAMA_PULL_PROGRESS, progress))
  })

  // Cyberpunk 2077 in any folder, or under Mod Organizer: the user can show Capri where
  ipcMain.handle(IPC_CHANNELS.CYBERPUNK_FOLDERS_GET, () => cyberpunkFoldersState())
  ipcMain.handle(IPC_CHANNELS.CYBERPUNK_FOLDER_PICK, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const options: Electron.OpenDialogOptions = { properties: ['openDirectory'] }
    const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    const folder = picked.filePaths[0]
    if (picked.canceled || !folder) return null
    const result = markCyberpunkFolder(folder)
    // With CET in that folder, her mod goes in right away
    if (result.info.kind !== 'unknown') cyberpunkAdapter.installCetMod()
    return { ...result, state: cyberpunkFoldersState() }
  })
  ipcMain.handle(IPC_CHANNELS.CYBERPUNK_FOLDER_REMOVE, (_event, folder: string) => unmarkCyberpunkFolder(String(folder ?? '')))
  ipcMain.handle(IPC_CHANNELS.LLM_GET_SETTINGS, () => getLlmSettings())
  ipcMain.handle(IPC_CHANNELS.LLM_SET_SETTINGS, (_event, update: LlmSettingsUpdate) => { if(isMac) scannerService.setContinuous(false); return setLlmSettings(update) })
  ipcMain.handle(IPC_CHANNELS.LLM_LIST_MODELS, (_event, baseUrl: string, apiKey?: string) => listCloudModels(baseUrl, apiKey))
  ipcMain.handle(IPC_CHANNELS.LLM_TEST, (_event, baseUrl: string, model: string, apiKey?: string) =>
    testCloudConnection(baseUrl, model, apiKey)
  )

  ipcMain.handle(IPC_CHANNELS.AGENT_DETECT_OLLAMA, async () => {
    return await agentManager.detectOllama()
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_CLEAR_HISTORY, (_event, options?: { startup?: boolean }) => {
    agentManager.clearHistory(!!options?.startup)
    return true
  })

  ipcMain.handle(
    IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
    (_event, payload: { requestId: string; approved: boolean }) => {
      agentManager.respondPermission(payload.requestId, payload.approved)
      return true
    }
  )

  ipcMain.handle(IPC_CHANNELS.AGENT_CANCEL, () => {
    agentManager.cancel()
    return true
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_GET_STATUS, () => {
    return agentManager.getStatus()
  })

  // Terminal
  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_INPUT,
    (_event, payload: { command: string; cwd: string }) => {
      terminalManager.execCommand(payload.command, payload.cwd)
      return true
    }
  )

  // Directory picker dialog
  ipcMain.handle(IPC_CHANNELS.DIALOG_SELECT_DIRECTORY, async () => {
    const deckWin = windowManager.getDeckWindow()
    const parentWin = (deckWin && !deckWin.isDestroyed() && deckWin.isVisible()) ? deckWin : undefined
    const result = await dialog.showOpenDialog(parentWin as any, {
      properties: ['openDirectory'],
      title: 'Select Project Workspace Folder // Capricorn Dev Deck'
    })

    if (!result.canceled && result.filePaths.length > 0) {
      return result.filePaths[0]
    }
    return null
  })

  // System cwd
  ipcMain.handle(IPC_CHANNELS.SYSTEM_GET_CWD, () => {
    return process.cwd()
  })

  // File System Helpers for Code Editor (Fast, Non-blocking, Text-code only)
  ipcMain.handle(IPC_CHANNELS.FS_LIST_FILES, async (_event, rootDir: string) => {
    try {
      const baseDir = rootDir || process.cwd()
      if (!fs.existsSync(baseDir)) return []

      const files: string[] = []
      const ignoreDirs = new Set([
        'node_modules', '.git', 'dist', 'out', '.vscode', 'build', '.idea',
        'coverage', '.venv', 'venv', '__pycache__', 'unused', 'target', '.next', '.cache'
      ])
      const codeExtensions = new Set([
        '.ts', '.tsx', '.js', '.jsx', '.json', '.html', '.css', '.scss',
        '.md', '.py', '.cs', '.ps1', '.bat', '.sh', '.rs', '.go', '.cpp',
        '.c', '.h', '.java', '.yaml', '.yml', '.toml', '.txt', '.xml', '.env', '.sql'
      ])

      function scan(currentDir: string, depth = 0): void {
        if (depth > 3 || files.length >= 60) return
        try {
          const entries = fs.readdirSync(currentDir, { withFileTypes: true })
          for (const entry of entries) {
            if (entry.isDirectory()) {
              if (!ignoreDirs.has(entry.name) && !entry.name.startsWith('.')) {
                scan(path.join(currentDir, entry.name), depth + 1)
              }
            } else if (entry.isFile()) {
              const ext = path.extname(entry.name).toLowerCase()
              if (codeExtensions.has(ext)) {
                const rel = path.relative(baseDir, path.join(currentDir, entry.name)).replace(/\\/g, '/')
                files.push(rel)
                if (files.length >= 60) break
              }
            }
          }
        } catch {
          // Skip inaccessible directories
        }
      }

      scan(baseDir, 0)
      return files
    } catch {
      return []
    }
  })

  // One directory level at a time (lazy file tree in the code editor)
  ipcMain.handle(IPC_CHANNELS.FS_LIST_DIR, async (_event, payload: { rootDir: string; relDir?: string }) => {
    try {
      const root = payload.rootDir || process.cwd()
      const rel = (payload.relDir || '').replace(/\\/g, '/').replace(/^\/+/, '')
      const dir = path.resolve(root, rel)
      if (!dir.startsWith(path.resolve(root)) || !fs.existsSync(dir)) return []
      const hidden = new Set(['node_modules', '.git', 'dist', 'out', 'build', 'coverage', '.venv', 'venv', '__pycache__', '.next', '.cache', '.idea', '.vscode'])
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => !hidden.has(e.name) && !(e.isDirectory() && e.name.startsWith('.')))
        .filter((e) => e.isDirectory() || e.isFile())
        .map((e) => ({ name: e.name, path: (rel ? `${rel}/` : '') + e.name, isDir: e.isDirectory() }))
        .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.isDir ? -1 : 1))
        .slice(0, 500)
    } catch {
      return []
    }
  })

  ipcMain.handle(IPC_CHANNELS.FS_READ_FILE, async (_event, payload: { rootDir: string; relPath: string }) => {
    try {
      const fullPath = path.isAbsolute(payload.relPath)
        ? payload.relPath
        : path.join(payload.rootDir || process.cwd(), payload.relPath)
      if (!fs.existsSync(fullPath)) return null
      const stat = fs.statSync(fullPath)
      if (stat.size > 512 * 1024) {
        return `// [File is too large to load in preview (${(stat.size / 1024).toFixed(1)} KB)]\n// Open directly in your IDE for full editing.`
      }
      return fs.readFileSync(fullPath, 'utf-8')
    } catch {
      return null
    }
  })

  ipcMain.handle(IPC_CHANNELS.FS_WRITE_FILE, async (_event, payload: { rootDir: string; relPath: string; content: string }) => {
    try {
      const fullPath = path.isAbsolute(payload.relPath)
        ? payload.relPath
        : path.join(payload.rootDir || process.cwd(), payload.relPath)
      const parent = path.dirname(fullPath)
      if (!fs.existsSync(parent)) {
        fs.mkdirSync(parent, { recursive: true })
      }
      fs.writeFileSync(fullPath, payload.content, 'utf-8')
      return true
    } catch {
      return false
    }
  })

  ipcMain.on(IPC_CHANNELS.VOICE_RECORDING_STATE, (_event, active: boolean) => {
    windowManager.setVoiceRecordingActive(!!active)
  })

  // Voice Core (Speech-to-Text and Text-to-Speech)
  ipcMain.handle(IPC_CHANNELS.VOICE_STT_STATE, () => voiceService.getSttState())
  ipcMain.handle(IPC_CHANNELS.ARROW_KEYS_GET, () => consciousnessService.getArrowKeysEnabled())
  ipcMain.handle(IPC_CHANNELS.ARROW_KEYS_SET, (_event, enabled: boolean) => {
    windowManager.setArrowKeysEnabled(!!enabled)
    return !!enabled
  })
  ipcMain.handle(IPC_CHANNELS.HOTKEYS_GET, () => consciousnessService.getHotkeys())
  ipcMain.handle(IPC_CHANNELS.HOTKEYS_SET, (_event, action: HotkeyAction, accelerator: string) => windowManager.setHotkey(action, String(accelerator)))
  ipcMain.handle(IPC_CHANNELS.HOTKEYS_RESET, () => windowManager.resetHotkeys())
  ipcMain.handle(IPC_CHANNELS.GAMING_OPACITY_GET, () => consciousnessService.getGamingOpacity())
  // Local models, each with its size and whether it sees, and the parts the setup installed
  ipcMain.handle(IPC_CHANNELS.MODELS_LIST, () => listLocalModels())
  ipcMain.handle(IPC_CHANNELS.MODEL_DELETE, async (_event, name: string) => (await deleteLocalModel(String(name ?? ''))) ? listLocalModels() : null)
  ipcMain.handle(IPC_CHANNELS.VISION_MODEL_GET, () => consciousnessService.getScannerVisionModel())
  ipcMain.handle(IPC_CHANNELS.VISION_MODEL_SET, (_event, model: string) => {
    consciousnessService.setScannerVisionModel(String(model || 'auto'))
    return consciousnessService.getScannerVisionModel()
  })
  ipcMain.handle(IPC_CHANNELS.PARTS_LIST, () => listInstalledParts())
  ipcMain.handle(IPC_CHANNELS.PART_REMOVE, (_event, id: string) => (['voiceEnv', 'whisper', 'ffmpeg', 'qwen3tts'].includes(id) ? removeInstalledPart(id as InstalledPartId) : listInstalledParts()))

  // The user's AI apps, as her model
  ipcMain.handle(IPC_CHANNELS.AI_APPS_LIST, () => listAiApps())
  ipcMain.handle(IPC_CHANNELS.AI_APPS_TEST, (_event, app: string, model: string) =>
    isAiAppId(app) ? testAiApp(app, String(model || '')) : { ok: false, error: 'other' }
  )

  // Running as administrator, for games that run as administrator
  ipcMain.handle(IPC_CHANNELS.ADMIN_GET, () => ({ enabled: consciousnessService.getRunAsAdmin(), elevated: isElevated() }))
  ipcMain.handle(IPC_CHANNELS.ADMIN_SET, async (_event, enabled: boolean) => {
    consciousnessService.setRunAsAdmin(!!enabled)
    // Turned on: she restarts as administrator now. Turned off: from her next start
    const relaunching = !!enabled && !isElevated() ? await relaunchElevated() : false
    return { enabled: consciousnessService.getRunAsAdmin(), elevated: isElevated(), relaunching }
  })
  // Her size, normal and in Gaming Mode
  ipcMain.handle(IPC_CHANNELS.COMPANION_SCALE_GET, () => ({ desktop: consciousnessService.getCompanionScale('desktop'), gaming: consciousnessService.getCompanionScale('gaming') }))
  ipcMain.handle(IPC_CHANNELS.COMPANION_SCALE_SET, (_event, kind: string, value: number) => windowManager.setCompanionScale(kind === 'gaming' ? 'gaming' : 'desktop', Number(value)))
  ipcMain.handle(IPC_CHANNELS.GAMING_OPACITY_SET, (_event, value: number) => {
    consciousnessService.setGamingOpacity(value)
    const saved = consciousnessService.getGamingOpacity()
    windowManager.broadcast(IPC_CHANNELS.GAMING_OPACITY_CHANGED, saved)
    return saved
  })

  ipcMain.handle(IPC_CHANNELS.VOICE_TRANSCRIBE, async (_event, audioData: ArrayBuffer | Uint8Array, partial?: boolean) => {
    try {
      const buffer = Buffer.isBuffer(audioData)
        ? audioData
        : audioData instanceof ArrayBuffer
        ? Buffer.from(audioData)
        : Buffer.from(audioData.buffer, audioData.byteOffset, audioData.byteLength)
      return await voiceService.transcribe(buffer, !!partial)
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.VOICE_SYNTHESIZE, async (_event, text: string, langOverride?: string) => {
    try {
      return await voiceService.synthesize(text, langOverride)
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.VOICE_QWEN_PREVIEW, async (_event, text: string, qwen: Partial<QwenTtsConfig>) => {
    try {
      return await voiceService.synthesize(String(text || ''), undefined, { silent: true, fresh: true, qwenPreview: qwen || {} })
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  })

  const cloneDir = (): string => path.join(voiceDataDir(), 'clone')
  const insideCloneDir = (file: string): boolean => {
    const root = path.resolve(cloneDir()) + path.sep
    return path.resolve(String(file || '')).startsWith(root)
  }

  ipcMain.handle(IPC_CHANNELS.VOICE_PICK_REFERENCE, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const options: Electron.OpenDialogOptions = {
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'm4a', 'flac', 'ogg', 'opus', 'webm', 'aac'] }]
    }
    const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    const file = picked.filePaths[0]
    if (picked.canceled || !file) return null
    fs.mkdirSync(cloneDir(), { recursive: true })
    const safeName = path.basename(file).replace(/[^\w.\-]+/g, '_')
    const copy = path.join(cloneDir(), `ref_${Date.now()}_${safeName}`)
    fs.copyFileSync(file, copy)
    return { path: copy, name: path.basename(file) }
  })

  ipcMain.handle(IPC_CHANNELS.VOICE_TRANSCRIBE_REFERENCE, async (_event, file: string) => {
    if (!insideCloneDir(file) || !fs.existsSync(file)) return { success: false, error: 'Reference audio not found' }
    try {
      return await voiceService.transcribeReference(file)
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.VOICE_DESIGN_REFERENCE, async (_event, text: string, description: string, lang?: string) => {
    try {
      return await voiceService.designReference(String(text || ''), String(description || ''), lang)
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.BENCHMARK_RUN, async (_event, req: BenchmarkRequest) => {
    return benchmarkService.run(req)
  })

  ipcMain.handle(IPC_CHANNELS.GPU_BUDGET_GET, async (_event, preview?: BudgetPreview) => {
    const provider = ['edge-tts', 'elevenlabs', 'fish-audio', 'qwen3-tts'].includes(String(preview?.provider)) ? preview?.provider : undefined
    const qwenSize = preview?.qwenSize === '1.7B' ? '1.7B' : preview?.qwenSize === '0.6B' ? '0.6B' : undefined
    return computeGpuBudget({ provider, qwenSize })
  })

  ipcMain.handle(IPC_CHANNELS.VOICE_GET_CONFIG, async () => {
    return voiceService.getConfig()
  })

  ipcMain.handle(IPC_CHANNELS.VOICE_SET_CONFIG, async (_event, config: any) => {
    return voiceService.setConfig(config)
  })

  // Media Controls (Spotify)
  ipcMain.handle(
    IPC_CHANNELS.MEDIA_CONTROL,
    async (_event, action: 'play' | 'pause' | 'play_pause' | 'next' | 'prev') => {
      try {
        return await ToolExecutor.mediaControl(action)
      } catch (err: any) {
        return { success: false, output: err?.message || String(err) }
      }
    }
  )

  ipcMain.handle(IPC_CHANNELS.MEDIA_GET_STATUS, async () => {
    try {
      return await ToolExecutor.getMediaStatus()
    } catch {
      return { isPlaying: false, title: '' }
    }
  })

  // Neural Scanner Mode Controls & Vision Events
  ipcMain.handle(IPC_CHANNELS.SCANNER_OPEN, () => {
    return scannerService.open()
  })

  ipcMain.handle(IPC_CHANNELS.SCANNER_CLOSE, () => {
    return scannerService.close()
  })

  ipcMain.handle(IPC_CHANNELS.SCANNER_TOGGLE, () => {
    return scannerService.toggle()
  })

  ipcMain.handle(IPC_CHANNELS.SCANNER_GET_STATUS, () => {
    return scannerService.getStatus()
  })

  ipcMain.handle(IPC_CHANNELS.SCANNER_LOCAL_AI, (_event,enabled:boolean) => setLocalAIEnabled(enabled))
  ipcMain.handle(IPC_CHANNELS.SCANNER_FIT_SCREEN, () => {
    const win=windowManager.getScannerWindow()
    if (!win || win.isDestroyed()) return null
    const bounds=desktopScreen.getDisplayMatching(win.getBounds()).workArea
    windowManager.setScannerBounds(bounds)
    return win.getBounds()
  })

  ipcMain.handle(IPC_CHANNELS.SCANNER_SET_BOUNDS, (_event, bounds) => {
    windowManager.setScannerBounds(bounds)
    return true
  })

  ipcMain.handle(IPC_CHANNELS.SCANNER_SCAN, async (_event, query?: string) => {
    return await scannerService.scan(query)
  })

  ipcMain.handle(IPC_CHANNELS.SCANNER_SET_CONTINUOUS, (_event, enabled: boolean) => {
    return scannerService.setContinuous(enabled)
  })

  ipcMain.handle(IPC_CHANNELS.SCANNER_WATCH_SCREEN_START, async () => {
    return await scannerService.startFullscreenWatch()
  })

  ipcMain.handle(IPC_CHANNELS.SCANNER_WATCH_SCREEN_STOP, () => {
    return scannerService.stopFullscreenWatch()
  })

  ipcMain.handle(IPC_CHANNELS.SCANNER_WATCH_SCREEN_TOGGLE, async () => {
    return await scannerService.toggleFullscreenWatch()
  })

  ipcMain.on(IPC_CHANNELS.COMPANION_SCRIPT_LINE_DONE, (_event, id: number) => scriptPlayer.onLineDone(id))
  ipcMain.on(IPC_CHANNELS.COMPANION_SCRIPT_CANCEL, () => scriptPlayer.cancel())
  ipcMain.on(IPC_CHANNELS.COMPANION_VOICE_BUSY, (_event, busy: boolean) => scannerService.setVoiceBusy(!!busy))

  ipcMain.handle(IPC_CHANNELS.SCANNER_SET_IGNORE_MOUSE, (_event, ignore: boolean) => {
    windowManager.setScannerIgnoreMouse(ignore)
    return true
  })

  // NVIDIA ShadowPlay Instant Replay Clipping
  ipcMain.handle(IPC_CHANNELS.SYSTEM_TRIGGER_CLIP, async () => {
    return await clipService.triggerClip()
  })

  // Cyberpunk 2077 Integration
  ipcMain.handle(IPC_CHANNELS.CYBERPUNK_MARK_POI, async (_event, target?: string) => {
    if (isMac) return false
    return cyberpunkAdapter.sendCommand({
      action: 'mark_closest',
      target: target || 'ripperdoc'
    })
  })

  ipcMain.handle(IPC_CHANNELS.CYBERPUNK_CLEAR_POI, async () => {
    if (isMac) return false
    await cyberpunkAdapter.sendCommand({
      action: 'clear_marker'
    })
    return true
  })

  ipcMain.handle(IPC_CHANNELS.CYBERPUNK_MARK_GIG, async (_event, gigId?: string) => {
    if (isMac) return false
    const gig = gigId ? CYBERPUNK_GIGS.find((g) => g.id === gigId) || getNextGig() : getNextGig()
    return await cyberpunkAdapter.markGig(gig)
  })

  // Watch Party & Autonomous PC Control
  ipcMain.handle('watchParty:getStatus', () => {
    return watchPartyService.getStatus()
  })

  ipcMain.handle('watchParty:startTiktok', async () => {
    return await watchPartyService.startTiktokParty()
  })

  ipcMain.handle('watchParty:startYoutube', async () => {
    return await watchPartyService.startYoutubeParty()
  })

  ipcMain.handle('watchParty:startGaming', async () => {
    return await watchPartyService.startGamingParty()
  })

  ipcMain.handle('watchParty:stop', () => {
    return watchPartyService.stopParty(true)
  })

  ipcMain.handle('watchParty:next', async () => {
    return await watchPartyService.nextTiktok()
  })

  ipcMain.handle('watchParty:like', async () => {
    return await watchPartyService.likeTiktok()
  })

  ipcMain.handle(IPC_CHANNELS.DESKTOP_CONTROLLER_ACTION, async (_event, action: string, params?: Record<string, unknown>) => {
    switch (action) {
      case 'scroll':
        return await desktopController.scroll((params?.direction as 'down' | 'up') || 'down', typeof params?.amount === 'number' ? params.amount : 360)
      case 'key':
        return await desktopController.pressKey(params?.key as any)
      case 'click':
        return await desktopController.click(typeof params?.x === 'number' ? params.x : -1, typeof params?.y === 'number' ? params.y : -1)
      case 'tiktok_next':
        return await desktopController.tiktokNext()
      case 'tiktok_like':
        return await desktopController.tiktokLike()
      case 'tiktok_prev':
        return await desktopController.tiktokPrev()
      case 'tiktok_pause':
        return await desktopController.tiktokPause()
      default:
        return false
    }
  })
}
