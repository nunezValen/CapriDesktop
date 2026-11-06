import React, { useState, useEffect, useRef } from 'react'
import { useT } from '../utils/useUiLang'
import { Send, Square, CheckCircle2, XCircle, AlertTriangle, Terminal as TerminalIcon, Bot } from 'lucide-react'
import { useAgentStore, PermissionRequest } from '../stores/useAgentStore'
import { useCompanionStore } from '../stores/useCompanionStore'
import { speakDevVoice, speakDevAck } from '../utils/devVoice'
import { MicButton } from './MicButton'

interface AgentChatProps {
  transparent?: boolean
}

export const AgentChat: React.FC<AgentChatProps> = ({ transparent = false }) => {
  const tr = useT()
  const [promptInput, setPromptInput] = useState('')
  const chatScrollRef = useRef<HTMLDivElement>(null)

  const {
    projectPath,
    agentMode,
    isRunning,
    setIsRunning,
    messages,
    activeStreamText,
    pendingPermission,
    addUserMessage,
    appendStreamText,
    commitAssistantMessage,
    addToolCall,
    finishToolCall,
    setPendingPermission
  } = useAgentStore()

  const { setEmotion, setSpeech } = useCompanionStore()
  const [lang, setLang] = useState<string>('es')

  useEffect(() => {
    if (window.api?.companion?.getLanguage) {
      window.api.companion.getLanguage().then((l: string) => {
        if (l) setLang(l)
      }).catch(() => {})
    }
    if (window.api?.companion?.onLanguageChanged) {
      const unsub = window.api.companion.onLanguageChanged((l: string) => setLang(l))
      return unsub
    }
    return
  }, [])

  // Auto-scroll chat to bottom
  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight
    }
  }, [messages, activeStreamText, pendingPermission])

  // Subscribe to Agent IPC events
  useEffect(() => {
    if (!window.api) return

    const unsub = window.api.agent.onEvent((event) => {
      switch (event.type) {
        case 'session.started':
          setIsRunning(true)
          setEmotion('talking')
          break

        case 'assistant.delta':
          if (event.text) {
            appendStreamText(event.text)
          }
          break

        case 'tool.started':
          if (event.toolName) {
            addToolCall(event.toolName, event.toolInput)
            setEmotion('curious')
          }
          break

        case 'tool.finished':
          if (event.toolName) {
            finishToolCall(event.toolName, event.toolOutput)
          }
          break

        case 'permission.requested':
          if (event.requestId && event.toolName) {
            setPendingPermission({
              requestId: event.requestId,
              toolName: event.toolName,
              description: event.permissionDescription || 'Permission requested',
              timestamp: Date.now()
            })
          }
          break

        case 'session.finished':
          setIsRunning(false)
          commitAssistantMessage()
          setPendingPermission(null)
          setEmotion('capri2')
          if (!document.hasFocus()) {
            // User is looking at another window, desktop companion handles the wake-up
            break
          }
          {
            const allMsgs = useAgentStore.getState().messages
            const lastMsg = allMsgs[allMsgs.length - 1]
            const responseText = lastMsg && lastMsg.role === 'assistant' ? lastMsg.content : ''
            if (useAgentStore.getState().isDevVoiceEnabled && responseText) {
              speakDevVoice(responseText)
            } else {
              setSpeech(
                lang === 'es'
                  ? "¡Chau chau, choomba! ¡Lo lograste! ¡Démosles a estos estáticos un espectáculo que jamás olviden!"
                  : "Bye-bye, choomba! Yay, you did it! Let's give these statics a spectacle they'll never forget!",
                6500
              )
            }
          }
          break

        case 'session.error':
          setIsRunning(false)
          if (event.error) {
            appendStreamText(`\n[ERROR: ${event.error}]\n`)
          }
          commitAssistantMessage()
          setPendingPermission(null)
          break
      }
    })

    return () => unsub()
  }, [
    setIsRunning,
    appendStreamText,
    addToolCall,
    finishToolCall,
    setPendingPermission,
    commitAssistantMessage
  ])

  const handleSend = async (e?: React.FormEvent, spoken?: string) => {
    if (e) e.preventDefault()
    const trimmed = (spoken ?? promptInput).trim()
    if (!trimmed || isRunning) return

    addUserMessage(trimmed)
    setPromptInput('')
    setIsRunning(true)

    // Capri reacts with speech
    setEmotion('talking')
    if (window.api) window.api.companion.setState('talking')
    setSpeech(
      lang === 'es'
        ? "Te va a gustar esto... ¡Conectando y ejecutando código, choomba!"
        : "You'll like this game... Jacking in and executing code, choomba!",
      3500
    )

    if (useAgentStore.getState().isDevVoiceEnabled) {
      speakDevAck()
    }

    if (window.api) {
      await window.api.agent.sendPrompt(trimmed, projectPath, agentMode, 'editor')
    }
  }

  const handleCancel = async () => {
    if (window.api) {
      await window.api.agent.cancel()
    }
    setIsRunning(false)
    setPendingPermission(null)
    commitAssistantMessage()
  }

  const handlePermission = async (req: PermissionRequest, approved: boolean) => {
    if (window.api) {
      await window.api.agent.respondPermission(req.requestId, approved)
    }
    setPendingPermission(null)
    if (approved) {
      setEmotion('working')
      setSpeech(
        lang === 'es'
          ? "¡Bien jugado, boo! Autorizado, atravesando el ICE..."
          : "That was all you, boo! Authorized, pushing through ICE...",
        3000
      )
    } else {
      setEmotion('curious')
      setSpeech(
        lang === 'es'
          ? "¿Te dio miedo? Acción denegada. ¡Dale, no seas tímido, choomba!"
          : "Gave you a handicap, huh? Action denied. Go on, don't be shy, choomba!",
        3000
      )
    }
  }

  return (
    <div
      className={`flex-1 flex flex-col h-full ${
        transparent ? 'bg-transparent' : 'bg-[#180b0b]/60'
      } overflow-hidden select-text`}
    >
      {/* Messages Scroll Area */}
      <div ref={chatScrollRef} className="cp-deck-messages flex-1 p-3 overflow-y-auto space-y-3 cp-mono text-[14px]">
        {messages.map((msg) => {
          const isUser = msg.role === 'user'

          return (
            <div
              key={msg.id}
              className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} space-y-1`}
            >
              <div className="flex items-center gap-1.5 text-[12px] text-stone-400 px-1">
                {isUser ? (
                  <>
                    <span className="text-stone-300 font-semibold">{tr('chat_you')}</span>
                    <span className="text-cyan-400">&gt;</span>
                  </>
                ) : (
                  <>
                    <span className="text-stone-300 font-semibold">capri</span>
                    <span className="text-cyan-400">&gt;</span>
                  </>
                )}
                <span className="text-stone-600">
                  {new Date(msg.timestamp).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit'
                  })}
                </span>
              </div>

              {/* Message Bubble (Minimalist Terminal Style) */}
              <div
                className={`cp-cut max-w-[90%] rounded-none p-3 leading-relaxed whitespace-pre-wrap ${
                  transparent
                    ? isUser
                      ? 'bg-[#281213]/75 border border-[#55292a]/80 text-stone-100 backdrop-blur-md'
                      : 'bg-[#140909]/75 border border-[#3b1c1d]/80 text-stone-200 backdrop-blur-md'
                    : isUser
                    ? 'bg-[#271212] border border-[#411f20] text-stone-100'
                    : 'bg-[#180b0b] border border-[#311718] text-stone-200'
                }`}
              >
                {msg.content}

                {/* Render Tool Calls in Assistant Message */}
                {msg.toolCalls && msg.toolCalls.length > 0 && (
                  <div className="mt-2 space-y-1.5 border-t border-[#311718] pt-2">
                    {msg.toolCalls.map((t, idx) => (
                      <div
                        key={idx}
                        className={`${
                          transparent ? 'bg-[#100707]/80 backdrop-blur-sm' : 'bg-[#100707]'
                        } border border-[#381a1b] rounded-none p-2 text-[14px]`}
                      >
                        <div className="flex items-center justify-between text-[13px] mb-1">
                          <span className="text-stone-300 font-semibold flex items-center gap-1">
                            <TerminalIcon size={12} className="text-cyan-400" />
                            <span>{tr('chat_tool')}: {t.toolName}</span>
                          </span>
                          <span
                            className={`px-1.5 py-0.2 rounded-none text-[11px] cp-mono ${
                              t.status === 'completed'
                                ? 'bg-cyan-950/60 text-cyan-400 border border-cyan-500/40'
                                : t.status === 'running'
                                ? 'bg-yellow-950/60 text-yellow-400 border border-yellow-500/40 animate-pulse'
                                : 'bg-red-950/60 text-red-400 border border-red-500/40'
                            }`}
                          >
                            {t.status === 'completed' ? tr('chat_statusCompleted') : t.status === 'running' ? tr('chat_statusRunning') : tr('chat_statusFailed')}
                          </span>
                        </div>
                        {t.input && (
                          <div className="text-stone-500 text-[12px] truncate">
                            {tr('chat_params')}: {JSON.stringify(t.input)}
                          </div>
                        )}
                        {t.output && (
                          <div className="text-stone-300 text-[12px] mt-1 bg-black/60 p-1.5 rounded-none max-h-40 overflow-y-auto whitespace-pre cp-mono border border-stone-900">
                            {t.output}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )
        })}

        {/* Live streaming text bubble */}
        {activeStreamText && (
          <div className="flex flex-col items-start space-y-1">
            <div className="flex items-center gap-1.5 text-[12px] text-stone-400 px-1 cp-mono">
              <Bot size={11} className="text-cyan-400" />
              <span>capri &gt; {tr('chat_streaming')}</span>
            </div>
            <div
              className={`cp-cut max-w-[90%] rounded-none p-3 ${
                transparent
                  ? 'bg-[#140909]/80 border border-cp-500/50 text-stone-100 backdrop-blur-md'
                  : 'bg-[#180b0b] border border-[#3c1c1d] text-stone-100'
              } whitespace-pre-wrap leading-relaxed`}
            >
              {activeStreamText}
              <span
                className="inline-block w-1.5 h-3.5 ml-1 bg-cyan-400 align-middle"
                style={{ animation: 'blink-caret 0.8s infinite' }}
              />
            </div>
          </div>
        )}

        {/* Pending Permission Request Card */}
        {pendingPermission && (
          <div
            className={`p-3 my-2 border border-yellow-500/40 ${
              transparent ? 'bg-[#161208]/85 backdrop-blur-md' : 'bg-[#161208]'
            } text-yellow-200 rounded-none text-[14px]`}
          >
            <div className="flex items-center gap-2 mb-1.5 text-yellow-400 font-bold cp-mono">
              <AlertTriangle size={14} />
              <span>{tr('chat_approval')}: {pendingPermission.toolName}</span>
            </div>
            <p className="cp-mono text-[14px] text-stone-300 mb-3 leading-normal">
              {pendingPermission.description}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => handlePermission(pendingPermission, true)}
                className="terminal-btn text-cyan-400 border-cyan-500/40 hover:bg-cyan-950/40 py-1 px-3 text-[14px] flex items-center gap-1.5"
              >
                <CheckCircle2 size={13} />
                <span>{tr('chat_approve')}</span>
              </button>
              <button
                onClick={() => handlePermission(pendingPermission, false)}
                className="terminal-btn text-red-400 border-red-500/40 hover:bg-red-950/40 py-1 px-3 text-[14px] flex items-center gap-1.5"
              >
                <XCircle size={13} />
                <span>{tr('chat_reject')}</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Terminal CLI Prompt Input Bar */}
      <form
        onSubmit={handleSend}
        className={`cp-deck-composer p-2.5 ${
          transparent
            ? 'bg-black/65 border-t border-[#311718]/80 backdrop-blur-md'
            : 'bg-[#170a0b] border-t border-[#311718]'
        } flex items-center gap-2 cp-mono`}
      >
        <span className="text-cp-400 font-bold text-[14px] select-none pl-1 flex items-center gap-1">
          <span>capri</span>
          <span className="text-cyan-400">&gt;</span>
        </span>
        <input
          type="text"
          aria-label={tr('chat_placeholder')}
          value={promptInput}
          onChange={(e) => setPromptInput(e.target.value)}
          placeholder={
            isRunning ? tr('chat_placeholderBusy') : tr('chat_placeholder')
          }
          disabled={isRunning}
          className={`flex-1 ${
            transparent
              ? 'bg-black/55 border-[#3f1e1f]/90 backdrop-blur-sm'
              : 'bg-[#210f10] border-[#3c1c1d]'
          } border text-stone-100 text-[14px] px-3 py-2 rounded-none focus:outline-none focus:border-cp-500 transition-colors`}
        />

        {/* Always mounted: unmounting it when a task started threw away a recording in progress */}
        <MicButton
          onText={(text) => {
            // Capri got busy while you were talking: keep the text in the box instead of losing it
            if (useAgentStore.getState().isRunning) setPromptInput(text)
            else handleSend(undefined, text)
          }}
          disabled={isRunning}
          className="py-1.5 px-2"
        />
        {isRunning ? (
          <button
            type="button"
            onClick={handleCancel}
            className="terminal-btn text-yellow-400 border-yellow-500/40 hover:bg-yellow-950/40 py-1.5 px-3 text-[14px] flex items-center gap-1"
            title={tr('chat_stopTitle')}
          >
            <Square size={12} />
            <span>{tr('cancel')}</span>
          </button>
        ) : (
          <>
          <button
            type="submit"
            disabled={!promptInput.trim()}
            className="terminal-btn text-stone-200 hover:text-white py-1.5 px-3 text-[14px] flex items-center gap-1 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <Send size={12} />
            <span>{tr('chat_run')}</span>
          </button>
          </>
        )}
      </form>
    </div>
  )
}
