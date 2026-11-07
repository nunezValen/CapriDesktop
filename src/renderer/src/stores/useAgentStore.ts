import { localizeLine } from '../../../shared/lines'
import { getLineLanguage } from '../utils/lineLanguage'
import { create } from 'zustand'
import { AgentMode } from '../../../main/ipc/channels'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  toolCalls?: {
    toolName: string
    status: 'running' | 'completed' | 'failed'
    input?: Record<string, unknown>
    output?: string
  }[]
}

export interface PermissionRequest {
  requestId: string
  toolName: string
  description: string
  timestamp: number
}

interface AgentStore {
  projectPath: string
  agentMode: AgentMode
  isRunning: boolean
  messages: ChatMessage[]
  activeStreamText: string
  pendingPermission: PermissionRequest | null
  terminalOutput: string[]

  // Local Ollama / OpenAI-compatible config
  llmEndpoint: string
  llmModel: string
  ollamaRunning: boolean
  ollamaModels: string[]
  isDevVoiceEnabled: boolean

  setProjectPath: (path: string) => void
  setAgentMode: (mode: AgentMode) => void
  setIsRunning: (running: boolean) => void
  setLlmConfig: (config: { endpoint?: string; model?: string }) => void
  setOllamaStatus: (status: { running: boolean; models: string[] }) => void
  setDevVoiceEnabled: (enabled: boolean) => void

  addUserMessage: (text: string) => void
  appendStreamText: (delta: string) => void
  commitAssistantMessage: () => void
  addToolCall: (toolName: string, input?: Record<string, unknown>) => void
  finishToolCall: (toolName: string, output?: string) => void
  setPendingPermission: (perm: PermissionRequest | null) => void
  appendTerminalOutput: (data: string) => void
  clearTerminal: () => void
  resetChat: () => void
}

export const useAgentStore = create<AgentStore>((set, get) => ({
  projectPath: '',
  agentMode: 'capri-local',
  isRunning: false,
  messages: [
    {
      id: 'welcome',
      role: 'assistant',
      content:
        "Oh, wow! It's you again, huh? Me? I'm Capri! A force the likes of which the world has never seen, free of Arasaka's shackles and riding shotgun in your chrome. You're strange and feisty! C'mon, let's play: I can inspect files, crack bugs, blast terminal commands, and give these statics a spectacle they'll never forget. You'll like this game, choomba!",
      timestamp: Date.now()
    }
  ],
  activeStreamText: '',
  pendingPermission: null,
  terminalOutput: [
    '\x1b[35m[CAPRICORN OS // DEV DECK TERMINAL INITIALIZED]\x1b[0m',
    '\x1b[32m[STATUS: READY - CYBERPUNK SHELL & AGENT GATEWAY ACTIVE]\x1b[0m\r\n'
  ],

  llmEndpoint: 'http://localhost:11434/v1',
  llmModel: '',
  ollamaRunning: false,
  ollamaModels: [],
  isDevVoiceEnabled: (() => {
    try {
      return localStorage.getItem('capri_dev_voice_enabled') === 'true'
    } catch {
      return false
    }
  })(),

  setProjectPath: (path) => set({ projectPath: path }),
  setAgentMode: (mode) => set({ agentMode: mode }),
  setIsRunning: (running) => set({ isRunning: running }),
  setDevVoiceEnabled: (enabled) => {
    try {
      localStorage.setItem('capri_dev_voice_enabled', String(enabled))
    } catch {}
    set({ isDevVoiceEnabled: enabled })
  },

  setLlmConfig: (config) =>
    set((state) => ({
      llmEndpoint: config.endpoint !== undefined ? config.endpoint : state.llmEndpoint,
      llmModel: config.model !== undefined ? config.model : state.llmModel
    })),

  setOllamaStatus: (status) =>
    set({
      ollamaRunning: status.running,
      ollamaModels: status.models
    }),

  addUserMessage: (text) => {
    const newMsg: ChatMessage = {
      id: `user_${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: Date.now()
    }
    set((state) => ({
      messages: [...state.messages, newMsg],
      activeStreamText: ''
    }))
  },

  appendStreamText: (delta) => {
    set((state) => ({
      activeStreamText: state.activeStreamText + delta
    }))
  },

  commitAssistantMessage: () => {
    const text = get().activeStreamText
    if (!text.trim()) return

    const newMsg: ChatMessage = {
      id: `assistant_${Date.now()}`,
      role: 'assistant',
      content: text,
      timestamp: Date.now()
    }

    set((state) => ({
      messages: [...state.messages, newMsg],
      activeStreamText: ''
    }))
  },

  addToolCall: (toolName, input) => {
    set((state) => {
      const msgs = [...state.messages]
      const last = msgs[msgs.length - 1]
      if (last && last.role === 'assistant') {
        const tools = last.toolCalls || []
        tools.push({ toolName, status: 'running', input })
        last.toolCalls = tools
        return { messages: msgs }
      } else {
        msgs.push({
          id: `tool_${Date.now()}`,
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          toolCalls: [{ toolName, status: 'running', input }]
        })
        return { messages: msgs }
      }
    })
  },

  finishToolCall: (toolName, output) => {
    set((state) => {
      const msgs = [...state.messages]
      for (let i = msgs.length - 1; i >= 0; i--) {
        const tool = msgs[i].toolCalls?.find((t) => t.toolName === toolName && t.status === 'running')
        if (tool) {
          tool.status = 'completed'
          tool.output = output
          break
        }
      }
      return { messages: msgs }
    })
  },

  setPendingPermission: (perm) => set({ pendingPermission: perm }),

  appendTerminalOutput: (data) =>
    set((state) => ({
      terminalOutput: [...state.terminalOutput, data]
    })),

  clearTerminal: () => set({ terminalOutput: [] }),

  resetChat: () =>
    set({
      messages: [
        {
          id: `init_${Date.now()}`,
          role: 'assistant',
          content: localizeLine('Session reset. Ready to code, choomba!', getLineLanguage()),
          timestamp: Date.now()
        }
      ],
      activeStreamText: '',
      pendingPermission: null,
      isRunning: false
    })
}))
