import { localizeLine } from '../../../shared/lines'
import { personalize } from '../utils/userName'
import React from 'react'
import { X } from 'lucide-react'
import { useUiLang } from '../utils/useUiLang'

interface SpeechBubbleProps {
  text: string | null
  userPrompt?: string | null
  state?: string
  isExecuting?: boolean
  compact?: boolean
  isRecordingVoice?: boolean
  isProcessingVoice?: boolean
  liveVoiceText?: string | null
  audioLevel?: number
  tailPosition?: 'bottom' | 'top'
  onStopVoice?: () => void
  /** Discards the recording without sending it */
  onCancelVoice?: () => void
  onClose?: () => void
  children?: React.ReactNode
}

export const SpeechBubble: React.FC<SpeechBubbleProps> = ({
  text,
  userPrompt,
  state: _state,
  isExecuting = false,
  compact = false,
  isRecordingVoice = false,
  isProcessingVoice = false,
  liveVoiceText = null,
  audioLevel = 0,
  tailPosition = 'bottom',
  onStopVoice,
  onCancelVoice,
  onClose,
  children
}) => {
  const uiLang = useUiLang()
  const es = uiLang === 'es'
  // Dynamic animated thinking dots: thinking. -> thinking.. -> thinking...
  const [thinkingDots, setThinkingDots] = React.useState('.')
  React.useEffect(() => {
    if (!isExecuting) return
    setThinkingDots('.')
    const frames = ['.', '..', '...']
    let i = 0
    const interval = setInterval(() => {
      i = (i + 1) % frames.length
      setThinkingDots(frames[i])
    }, 350)
    return () => clearInterval(interval)
  }, [isExecuting])

  const displayText = personalize(
    isExecuting ? text || `${localizeLine('thinking', uiLang)}${thinkingDots}` : text || (children ? "What's on your mind, {name}?" : '')
  )

  // If there is no text, no active execution, no recording, and no interactive input children, don't render anything
  if (!displayText && !isExecuting && !children && !isRecordingVoice && !isProcessingVoice) {
    return null
  }

  return (
    <div
      data-capri-ui="true"
      className={`relative z-40 w-full ${compact ? 'max-w-[320px]' : 'max-w-[380px]'} mx-auto animate-fade-in font-terminal select-text pt-1`}
      style={{
        WebkitAppRegion: 'no-drag'
      } as React.CSSProperties}
    >
      {/* Outer Cyan Neon Border with Chamfered Corners (Cut Top-Left and Cut Bottom-Right) */}
      <div className="hud-chamfer-box p-[2px] bg-[#00f0ff] shadow-[0_0_14px_rgba(0,240,255,0.4)]">
        {/* Inner Dark Surface */}
        <div className={`hud-chamfer-box-inner bg-[#080a12]/95 backdrop-blur-xl ${compact ? 'px-2.5 py-1.5' : 'px-3.5 py-2'} relative`}>
          {/* Header Controls (Dismiss) */}
          {onClose && (
            <div className="absolute top-2 right-2.5 flex items-center gap-1.5 z-10">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onClose()
                }}
                className="w-4 h-4 flex items-center justify-center rounded text-zinc-500 hover:text-white transition-colors cursor-pointer"
                title="Dismiss"
              >
                <X size={12} />
              </button>
            </div>
          )}

          {/* Vertical Red/Magenta Accent Line on the left */}
          <div className={`border-l-[3px] border-[#ff003c] ${compact ? 'pl-2 pr-2.5 gap-0.5' : 'pl-3 pr-4 gap-1'} flex flex-col shadow-[-2px_0_10px_rgba(255,0,60,0.5)]`}>
            {/* Real-time Voice Command Stream */}
            {(isRecordingVoice || isProcessingVoice) ? (
              <div className="flex flex-col gap-1.5 py-0.5 w-full animate-fade-in">
                <div className="flex items-center justify-between text-[11px] font-bold text-[#ff0055] tracking-wider">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-[#ff0055] animate-ping" />
                    <span className="font-terminal uppercase text-[#00f0ff]">
                      {isProcessingVoice ? '[DECODING VOICE...]' : '[RECORDING // LISTENING...]'}
                    </span>
                  </div>
                  {/* Real-time audio waveform / equalizer bars */}
                  <div className="flex items-end gap-0.5 h-3">
                    {[0.6, 1.1, 1.5, 0.9, 1.3, 0.7].map((factor, i) => (
                      <div
                        key={i}
                        className="w-1 bg-[#00f0ff] rounded-full transition-all duration-75 shadow-[0_0_4px_#00f0ff]"
                        style={{
                          height: `${Math.max(2, Math.min(13, Math.round(((audioLevel || 0) / 100) * 13 * factor)))}px`
                        }}
                      />
                    ))}
                  </div>
                </div>

                {/* Live stream of captured words */}
                <div className="min-h-[26px] text-[12px] font-mono text-cyan-200 bg-black/75 px-2.5 py-1.5 rounded border border-cyan-400/60 shadow-[0_0_10px_rgba(0,240,255,0.25)] flex items-center flex-wrap break-words leading-tight">
                  <span className="text-[#fcee0a] font-bold mr-1.5 select-none font-terminal">&gt; you:</span>
                  <span className="text-white">
                    {liveVoiceText ? `"${liveVoiceText}"` : (isProcessingVoice ? 'Processing command...' : 'Listening... your words will appear here...')}
                  </span>
                  <span
                    className="inline-block w-1.5 h-3.5 ml-1 bg-[#00f0ff] align-middle shadow-[0_0_6px_#00f0ff]"
                    style={{ animation: 'blink-caret 0.7s infinite' }}
                  />
                </div>

                <div className="flex items-center justify-between mt-0.5 text-[9px] text-zinc-400 font-mono">
                  <span>{es ? '↓ envía · Esc cancela' : localizeLine('↓ sends · Esc cancels', uiLang)}</span>
                  <div className="flex items-center gap-1">
                  {onCancelVoice && isRecordingVoice && (
                    <button
                      type="button"
                      onClick={onCancelVoice}
                      className="px-2 py-0.5 rounded bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 border border-zinc-600 text-[10px] font-bold cursor-pointer transition-colors shadow-sm flex items-center gap-1"
                      title={es ? 'Descartar la grabación' : localizeLine('Discard the recording', uiLang)}
                    >
                      <span>{es ? '[CANCELAR]' : `[${localizeLine('Cancel', uiLang).toUpperCase()}]`}</span>
                      <span className="text-[9px] px-1 bg-zinc-600 text-white rounded">Esc</span>
                    </button>
                  )}
                  {onStopVoice && (
                    <button
                      type="button"
                      onClick={onStopVoice}
                      className="px-2 py-0.5 rounded bg-[#ff003c]/20 hover:bg-[#ff003c]/40 text-[#ff0055] border border-[#ff003c]/70 text-[10px] font-bold cursor-pointer transition-colors shadow-sm flex items-center gap-1"
                    >
                      <span>{es ? '[ENVIAR]' : `[${localizeLine('Send', uiLang).toUpperCase()}]`}</span>
                      <span className="text-[9px] px-1 bg-[#ff003c] text-white rounded">↓</span>
                    </button>
                  )}
                  </div>
                </div>
              </div>
            ) : (
              <>
                {/* User prompt line (only rendered when an active user prompt exists - never shows stale prompts) */}
                {userPrompt && (
                  <div className="text-[11px] leading-tight text-[#8f9bb3] tracking-wide truncate">
                    &gt; you: {userPrompt}
                  </div>
                )}

                {/* AI Name tag in Cyberpunk Yellow: > capri */}
                <div className="text-[12px] font-bold text-[#fcee0a] tracking-wider flex items-center gap-1.5 font-terminal lowercase">
                  <span>&gt; capri:</span>
                  {isExecuting && (
                    <span className="text-[10px] text-[#00f0ff] animate-pulse font-normal tracking-normal uppercase">
                      [{localizeLine('Processing', uiLang).toUpperCase()}...]
                    </span>
                  )}
                </div>

                {/* AI Dialogue text */}
                {displayText && (
                  <div className={`${compact ? 'text-[11px] leading-tight' : 'text-[12px] leading-snug'} text-[#f8fafc] font-normal tracking-wide break-words max-h-[180px] overflow-y-auto overscroll-contain`}>
                    {displayText}
                    <span
                      className="inline-block w-1.5 h-3.5 ml-1 bg-[#00f0ff] align-middle shadow-[0_0_6px_#00f0ff]"
                      style={{ animation: 'blink-caret 0.9s infinite' }}
                    />
                  </div>
                )}

                {/* Interactive Child Elements (e.g. Minimal Input Bar on Ctrl + Click) */}
                {children}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Speech Bubble Tail: Points UP when bubble is below Capri (gaming mode), or down when above Capri */}
      {tailPosition === 'top' ? (
        <div className="absolute -top-[9px] left-16 w-5 h-3 overflow-visible pointer-events-none z-30">
          <svg viewBox="0 0 20 12" className="w-full h-full drop-shadow-[0_-2px_4px_rgba(0,240,255,0.5)]">
            <polygon
              points="1,11 6,1 18,11"
              fill="#080a12"
              stroke="#00f0ff"
              strokeWidth="2"
              strokeLinejoin="round"
            />
            <line x1="2" y1="11" x2="17" y2="11" stroke="#080a12" strokeWidth="2.5" />
          </svg>
        </div>
      ) : (
        <div className="absolute -bottom-[9px] right-24 w-5 h-3 overflow-visible pointer-events-none z-30">
          <svg viewBox="0 0 20 12" className="w-full h-full drop-shadow-[0_2px_4px_rgba(0,240,255,0.5)]">
            <polygon
              points="1,0 6,11 18,0"
              fill="#080a12"
              stroke="#00f0ff"
              strokeWidth="2"
              strokeLinejoin="round"
            />
            <line x1="2" y1="0" x2="17" y2="0" stroke="#080a12" strokeWidth="2.5" />
          </svg>
        </div>
      )}
    </div>
  )
}
