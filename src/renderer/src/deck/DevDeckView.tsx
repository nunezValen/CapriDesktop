import { MacSettings } from '../components/MacSettings'
import React, { useState, useEffect } from 'react'
import { CapriCommandCenter } from './CapriCommandCenter'
import { CodeEditorView } from './CodeEditorView'
import { AgentSettingsModal } from './AgentSettingsModal'
import { VoiceSettingsModal } from '../companion/VoiceSettingsModal'
import { LanguageSettingsModal } from './LanguageSettingsModal'
import { useCompanionStore } from '../stores/useCompanionStore'
import { useAgentStore } from '../stores/useAgentStore'
import { useT } from '../utils/useUiLang'
import {
  Minus,
  X,
  Settings,
  Cpu,
  MessageSquare,
  Code2,
  FolderGit2,
  FolderOpen,
  Volume2,
  VolumeX,
  Sliders,
  Languages
} from 'lucide-react'

type DeckTab = 'chat' | 'editor' | 'mac'

export const DevDeckView: React.FC = () => {
  const [isMac, setIsMac] = useState(() => /Mac/i.test(navigator.platform))
  useEffect(() => {window.api.platform.status().then(s => setIsMac(s.platform === 'darwin'))}, [])
  const [activeTab, setActiveTab] = useState<DeckTab>('chat')
  useEffect(()=>window.api.desktop.onOpenSettings(()=>setActiveTab('mac')),[])
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [settingsRevision, setSettingsRevision] = useState(0)
  const [isVoiceModalOpen, setIsVoiceModalOpen] = useState(false)
  useEffect(()=>window.api.desktop.onOpenVoiceSettings(()=>setIsVoiceModalOpen(true)),[])
  const [isLanguageModalOpen, setIsLanguageModalOpen] = useState(false)
  const { setEmotion, setSpeech } = useCompanionStore()
  const t = useT()
  const [cloudModel, setCloudModel] = useState<string | null>(null)
  const {
    isRunning,
    projectPath,
    setProjectPath,
    llmModel,
    ollamaModels,
    isDevVoiceEnabled,
    setDevVoiceEnabled,
    setLlmConfig,
    setOllamaStatus
  } = useAgentStore()

  // On mount: scan for local Ollama models and ensure Capri is in eyes mode in Dev Deck
  useEffect(() => {
    if (window.api) {
      window.api.agent.detectOllama().then((res) => {
        if (res) setOllamaStatus(res)
      })
    }
  }, [setOllamaStatus])

  // A cloud model is chosen in the settings: the top bar only shows it
  useEffect(() => {
    if (isSettingsOpen) return
    window.api?.agent.getLlmSettings().then((s) => setCloudModel(s.provider === 'cloud' ? s.model : null))
    window.api?.agent.detectOllama().then((res) => res && setOllamaStatus(res))
  }, [isSettingsOpen, activeTab, settingsRevision, setOllamaStatus])

  const handleMinimize = async () => {
    if (window.api) await window.api.window.minimize()
  }

  const handleClose = async () => {
    if (window.api) await window.api.window.close()
  }

  const handleModelChange = (modelName: string) => {
    setLlmConfig({ model: modelName })
    window.api?.agent.setConfig({ model: modelName })
  }

  // Only real, installed Ollama models (plus the current one if it isn't listed yet)
  const currentModel = llmModel
  const modelOptions = Array.from(new Set([...(ollamaModels || []), currentModel].filter(Boolean))).filter(
    (m) => !/llava|vision|-vl\b/i.test(m) || m === currentModel
  )

  return (
    <div className={`${isMac ? 'cp-deck-mac ' : ''}cp-vars cp-root w-screen h-screen flex flex-col bg-[#100607] text-stone-200 border border-[#381a1b] overflow-hidden select-none`}>

      {/* Top bar */}
      <div
        className="cp-deck-toolbar h-10 bg-[#170a0b] border-b border-[#311718] flex items-center justify-between px-3 shrink-0"
        style={{ WebkitAppRegion: 'drag', ...(isMac ? {paddingLeft:90, fontFamily:'-apple-system, BlinkMacSystemFont, sans-serif'} : {}) } as React.CSSProperties}
      >
        {/* Left: App title, status, and Project/Repo selector */}
        <div className="cp-deck-workspace flex items-center gap-2 text-[14px]">
          <span
            className={`w-2 h-2 rounded-none ${
              isRunning ? 'bg-yellow-400 animate-ping' : 'bg-cyan-400'
            }`}
          />
          <span className="cp-title text-[16px] text-cp-500">Capri</span>
          <span className="cp-label">// dev</span>
          
          {/* Clickable Project / Repository Selector */}
          <button
            onClick={async () => {
              if (window.api) {
                const dir = await window.api.system.selectDirectory()
                if (dir) {
                  setProjectPath(dir)
                  setSpeech(`Workspace switched to: ${dir.split(/[\\/]/).filter(Boolean).pop()}! Ready to breach, choomba!`, 3500)
                }
              }
            }}
            className="cp-deck-project cp-cut flex items-center gap-1.5 px-2 py-0.5 rounded-none bg-[#271212] hover:bg-[#391b1c] border border-[#472223] text-[13px] text-stone-300 hover:text-white transition-all cursor-pointer group"
            title={t('deck_workspaceTitle', { path: projectPath || t('deck_noFolderSel') })}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <FolderGit2 size={12} className="text-cyan-400 group-hover:scale-110 transition-transform" />
            <span className="truncate max-w-[160px] cp-mono text-[12px] text-stone-200">
              {projectPath ? (projectPath.split(/[\\/]/).filter(Boolean).pop() || projectPath) : t('deck_selectRepo')}
            </span>
            <FolderOpen size={10} className="text-cp-400 opacity-70 group-hover:opacity-100" />
          </button>
        </div>

        {/* Center: Developer Mode only has Code Editor and Chat */}
        <div
          className="cp-deck-tabs flex items-center gap-1 bg-[#210f10] p-0.5 rounded-none border border-[#3c1c1d]"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <button
            onClick={() => setActiveTab('chat')}
            aria-pressed={activeTab === 'chat'}
            className={`cp-cut flex items-center gap-1.5 px-3 py-1 rounded-none text-[14px] transition-colors ${
              activeTab === 'chat'
                ? 'bg-[#3c1c1d] text-white font-semibold border border-[#612f30]'
                : 'text-stone-400 hover:text-stone-200'
            }`}
            title={t('deck_tabChatTitle')}
          >
            <MessageSquare size={13} className={activeTab === 'chat' ? 'text-cp-400' : 'text-stone-400'} />
            <span>{t('deck_tabChat')}</span>
          </button>

          <button
            onClick={() => {
              setActiveTab('editor')
              setSpeech('Watching your code like a hawk, choomba!', 3000)
            }}
            className={`cp-cut flex items-center gap-1.5 px-3 py-1 rounded-none text-[14px] transition-colors ${
              activeTab === 'editor'
                ? 'bg-[#3c1c1d] text-white font-semibold border border-[#612f30]'
                : 'text-stone-400 hover:text-stone-200'
            }`}
            title={t('deck_tabEditor')}
            aria-pressed={activeTab === 'editor'}
          >
            <Code2 size={13} className={activeTab === 'editor' ? 'text-cyan-400' : 'text-stone-400'} />
            <span>{t('deck_tabEditor')}</span>
          </button>
        </div>

        {/* Right: Local Model Selector, Engine Selector & Window Controls */}
        <div
          className="cp-deck-tools flex items-center gap-2"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {/* Local Model Selector */}
          <div
            className="cp-deck-model flex items-center gap-1.5 bg-[#210f10] border border-[#3c1c1d] rounded-none px-2 py-0.5 text-[14px] text-stone-300"
            title={`${cloudModel ? 'Cloud model — change in Settings' : t('deck_modelTitle')} · ${cloudModel || currentModel}`}
            aria-label={`${t('deck_model')}: ${cloudModel || currentModel}`}
          >
            <Cpu size={12} className="text-cyan-400" />
            <span className="text-stone-500 text-[12px] uppercase">{t('deck_model')}:</span>
            <select
              value={cloudModel || currentModel}
              aria-label={t('deck_model')}
              title={cloudModel || currentModel}
              disabled={!!cloudModel}
              onChange={(e) => handleModelChange(e.target.value)}
              className="bg-[#210f10] text-stone-100 font-semibold text-[14px] outline-none cursor-pointer max-w-[180px] truncate"
              style={{ colorScheme: 'dark' }}
            >
              {(cloudModel ? [cloudModel] : modelOptions).map((m) => (
                <option key={m} value={m} className="bg-[#170a0b] text-stone-200">
                  {m}
                </option>
              ))}
            </select>
          </div>

          {/* LLM settings */}
          <button
            type="button"
            onClick={() => isMac ? setActiveTab('mac') : setIsSettingsOpen(true)}
            className="cp-deck-settings flex items-center justify-center bg-[#210f10] border border-[#3c1c1d] rounded-none p-1 text-stone-300 hover:text-stone-100 transition-colors"
            title={isMac ? 'Settings · AI, Mac & Spotify (⌘,)' : t('deck_settingsTitle')}
            aria-label={isMac ? 'Settings · AI, Mac & Spotify' : t('deck_settingsTitle')}
          >
            <Settings size={14} />
          </button>

          {/* Language Settings Button */}
          <button
            type="button"
            onClick={() => setIsLanguageModalOpen(true)}
            className="cp-cut flex items-center gap-1.5 px-2 py-0.5 rounded-none text-[14px] font-semibold border border-[#3c1c1d] bg-[#210f10] text-stone-400 hover:text-cyan-300 hover:border-cyan-500/50 transition-all cursor-pointer"
            title={t('deck_languageTitle')}
          >
            <Languages size={12} className="text-cyan-400" />
            <span className="text-[12px] uppercase font-bold text-stone-300">{t('deck_language')}</span>
          </button>

          {/* Voice Engine Settings Button */}
          <button
            type="button"
            onClick={() => setIsVoiceModalOpen(true)}
            className="cp-cut flex items-center gap-1.5 px-2 py-0.5 rounded-none text-[14px] font-semibold border border-[#3c1c1d] bg-[#210f10] text-stone-400 hover:text-cyan-300 hover:border-cyan-500/50 transition-all cursor-pointer"
            title={t('deck_voiceConfigTitle')}
          >
            <Sliders size={12} className="text-cyan-400" />
            <span className="text-[12px] uppercase font-bold text-stone-300">{t('deck_voiceConfig')}</span>
          </button>

          {/* User Option: Capri Voice in Dev Mode */}
          <button
            type="button"
            onClick={() => setDevVoiceEnabled(!isDevVoiceEnabled)}
            aria-pressed={isDevVoiceEnabled}
            className={`cp-cut flex items-center gap-1.5 px-2 py-0.5 rounded-none text-[14px] font-semibold border transition-all cursor-pointer ${
              isDevVoiceEnabled
                ? 'bg-[#ff5f57]/20 border-[#ff5f57] text-cp-300'
                : 'bg-[#210f10] border-[#3c1c1d] text-stone-500 hover:text-stone-300'
            }`}
            title={isDevVoiceEnabled ? t('deck_voiceOnTitle') : t('deck_voiceOffTitle')}
          >
            {isDevVoiceEnabled ? (
              <>
                <Volume2 size={12} className="text-[#ff5f57] animate-pulse" />
                <span className="text-[12px] uppercase font-bold text-cp-200">{t('deck_voiceOn')}</span>
              </>
            ) : (
              <>
                <VolumeX size={12} className="text-stone-500" />
                <span className="text-[12px] uppercase text-stone-500">{t('deck_voiceOff')}</span>
              </>
            )}
          </button>

          <button
            style={isMac ? {display:'none'} : undefined}
            onClick={handleMinimize}
            className="p-1 text-stone-400 hover:text-white hover:bg-stone-800 rounded-none transition-colors"
            title={t('deck_minimize')}
          >
            <Minus size={13} />
          </button>

          <button
            style={isMac ? {display:'none'} : undefined}
            onClick={handleClose}
            className="p-1 text-stone-400 hover:text-red-400 hover:bg-red-950/40 rounded-none transition-colors"
            title={t('close')}
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Main Workspace Panels (Only Code Editor and Full-Screen Chat) */}
      <div className="flex-1 flex overflow-hidden">
        {activeTab === 'chat' && <CapriCommandCenter />}
        {activeTab === 'editor' && <CodeEditorView />}
        {activeTab === 'mac' && (
          <div className="flex-1 min-w-0 overflow-y-auto px-6 pb-6">
            <div className="cp-deck-settings-nav sticky top-0 z-20 flex flex-wrap items-center gap-3 py-4 bg-[#100607] border-b border-[#381a1b] mb-5">
              <h1 className="cp-title text-xl mr-auto">Settings</h1>
              <button className="cp-btn-ghost px-3 py-2 text-sm" onClick={() => document.getElementById('deck-settings-ai')?.scrollIntoView({block:'start'})}>AI & models</button>
              <button className="cp-btn-ghost px-3 py-2 text-sm" onClick={() => document.getElementById('deck-settings-mac')?.scrollIntoView({block:'start'})}>Mac & Spotify</button>
            </div>
            <div className="mx-auto max-w-5xl space-y-6">
              <div id="deck-settings-ai" className="scroll-mt-20">
                <AgentSettingsModal isOpen embedded onClose={() => setActiveTab('chat')} onSaved={() => setSettingsRevision(value => value + 1)} />
              </div>
              <div id="deck-settings-mac" className="scroll-mt-20"><MacSettings /></div>
            </div>
          </div>
        )}
      </div>

      {isMac && <div className="cp-deck-footer h-9 shrink-0 border-t border-[#381a1b] flex items-center justify-between px-4"><span className="cp-label">Apple Silicon</span><button className="cp-btn-ghost text-sm" aria-pressed={activeTab === 'mac'} title="AI, Mac & Spotify settings (⌘,)" onClick={() => setActiveTab('mac')}>Settings</button></div>}

      {/* Settings Modal */}
      {isSettingsOpen && (
        <AgentSettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
      )}

      <LanguageSettingsModal isOpen={isLanguageModalOpen} onClose={() => setIsLanguageModalOpen(false)} />

      {/* Voice TTS Settings Modal */}
      <VoiceSettingsModal
        isOpen={isVoiceModalOpen}
        onClose={() => setIsVoiceModalOpen(false)}
      />
    </div>
  )
}
