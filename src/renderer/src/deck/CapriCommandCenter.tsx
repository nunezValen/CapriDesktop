import React, { useRef, useEffect, useState } from 'react'
import { useCompanionStore } from '../stores/useCompanionStore'
import { useAgentStore } from '../stores/useAgentStore'
import { AgentChat } from './AgentChat'
import { useT } from '../utils/useUiLang'
import { Eye, Sliders, MessageSquarePlus } from 'lucide-react'
import ojos2Video from '../assets/ojos2.mp4'
import capri2Video from '../assets/Capri2.mp4'
import ojosGif from '../assets/capri/ojos/ojos.gif'
import ojosWebp from '../assets/capri/ojos/ojos.webp'

export const CapriCommandCenter: React.FC = () => {
  const t = useT()
  const { emotion, speech, setEmotion } = useCompanionStore()
  const { isRunning, resetChat } = useAgentStore()
  const capri2VideoRef = useRef<HTMLVideoElement>(null)
  const ojosVideoRef = useRef<HTMLVideoElement>(null)
  const [videoError, setVideoError] = useState(false)
  const [bgDimLevel, setBgDimLevel] = useState<'low' | 'medium' | 'high'>('medium')

  useEffect(() => {
    if (emotion === 'capri2') {
      if (capri2VideoRef.current) {
        capri2VideoRef.current.currentTime = 0
        capri2VideoRef.current.play().catch(() => {})
      }
    } else {
      if (ojosVideoRef.current) {
        ojosVideoRef.current.play().catch((err) => {
          if (err && err.name !== 'AbortError' && err.name !== 'NotAllowedError') {
            setVideoError(true)
          }
        })
      }
    }
  }, [emotion])

  // Calculate overlay opacity based on user setting
  const overlayClass = {
    low: 'bg-black/30', // Very transparent: eyes pop out vividly
    medium: 'bg-black/55', // Balanced: clear eyes + high text contrast
    high: 'bg-black/75' // Darker: subtle eyes in background
  }[bgDimLevel]

  return (
    <div className="relative w-full h-full overflow-hidden bg-black select-none">
      {/* =========================================================================
          BACKGROUND LAYER: CAPRI FULL-SCREEN VISION FEED (OJOS2 / CAPRI2)
         ========================================================================= */}
      <div className="absolute inset-0 z-0 flex items-center justify-center overflow-hidden bg-black pointer-events-none select-none">
        {emotion === 'capri2' ? (
          <video
            key="capri2-active-video"
            ref={capri2VideoRef}
            src={capri2Video}
            autoPlay
            muted
            playsInline
            className="w-full h-full object-cover transition-opacity duration-500"
            onEnded={() => {
              setEmotion('ojos')
              if (window.api) window.api.companion.setState('ojos')
            }}
          />
        ) : videoError ? (
          <img
            src={ojosWebp || ojosGif}
            alt="Capri Ojos Vision"
            className="w-full h-full object-cover object-center transition-opacity duration-500"
          />
        ) : (
          <video
            key="ojos2-loop-video"
            ref={ojosVideoRef}
            src={ojos2Video}
            poster={ojosWebp}
            autoPlay
            loop
            muted
            playsInline
            onCanPlay={() => {
              if (ojosVideoRef.current && ojosVideoRef.current.paused) {
                ojosVideoRef.current.play().catch(() => {})
              }
            }}
            onError={() => setVideoError(true)}
            className="w-full h-full object-cover object-center transition-opacity duration-500"
          />
        )}

        {/* Cyberpunk Scanlines & Vignette */}
        <div className={`absolute inset-0 transition-colors duration-300 ${overlayClass}`} />
        <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_center,_transparent_30%,_rgba(0,0,0,0.8)_95%)]" />
      </div>

      {/* =========================================================================
          FOREGROUND LAYER: NETWATCH / NETRUNNER SEMI-TRANSPARENT TERMINAL
         ========================================================================= */}
      <div className="relative z-10 w-full h-full flex flex-col">
        {/* Netwatch Style Top Sub-Bar */}
        <div className="cp-deck-chatbar h-8 bg-black/60 border-b border-[#311718] px-3 flex items-center justify-between text-[13px] text-stone-300 backdrop-blur-md shrink-0">
          <div className="flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-none ${
                emotion === 'capri2'
                  ? 'bg-yellow-400 animate-ping'
                  : isRunning
                  ? 'bg-yellow-400 animate-pulse'
                  : 'bg-cyan-400'
              }`}
            />
            <span className="text-stone-200 font-semibold tracking-wide flex items-center gap-1.5">
              <Eye size={12} className="text-cyan-400" />
              <span>CAPRI</span>
              <span className="text-stone-500 font-normal">{isRunning ? t('cc_working') : t('cc_online')}</span>
            </span>
          </div>

          <div className="flex items-center gap-2 text-[12px] text-stone-400">
            <button
              onClick={resetChat}
              disabled={isRunning}
              className="flex items-center gap-1 bg-[#1f0e0e]/80 border border-[#3c1c1d] rounded-none px-1.5 py-0.5 text-stone-300 hover:text-white hover:border-cp-500/50 disabled:opacity-40 cursor-pointer"
              title={t('cc_newChatTitle')}
            >
              <MessageSquarePlus size={11} />
              <span className="text-[11px]">{t('cc_newChat')}</span>
            </button>
            {/* Opacity Control for terminal transparency */}
            <div className="flex items-center gap-1 bg-[#1f0e0e]/80 border border-[#3c1c1d] rounded-none px-1.5 py-0.5">
              <Sliders size={10} className="text-stone-400" />
              <span className="text-stone-500 text-[11px]">{t('cc_backdrop')}:</span>
              <button
                onClick={() => setBgDimLevel('low')}
                aria-pressed={bgDimLevel === 'low'}
                className={`px-1.5 py-0.2 rounded-none text-[11px] transition-colors ${
                  bgDimLevel === 'low'
                    ? 'bg-cp-600/40 text-cp-300 font-bold border border-cp-500/50'
                    : 'text-stone-400 hover:text-white'
                }`}
                title={t('cc_light')}
              >
                {t('cc_light')}
              </button>
              <button
                onClick={() => setBgDimLevel('medium')}
                aria-pressed={bgDimLevel === 'medium'}
                className={`px-1.5 py-0.2 rounded-none text-[11px] transition-colors ${
                  bgDimLevel === 'medium'
                    ? 'bg-cp-600/40 text-cp-300 font-bold border border-cp-500/50'
                    : 'text-stone-400 hover:text-white'
                }`}
                title={t('cc_medium')}
              >
                {t('cc_medium')}
              </button>
              <button
                onClick={() => setBgDimLevel('high')}
                aria-pressed={bgDimLevel === 'high'}
                className={`px-1.5 py-0.2 rounded-none text-[11px] transition-colors ${
                  bgDimLevel === 'high'
                    ? 'bg-cp-600/40 text-cp-300 font-bold border border-cp-500/50'
                    : 'text-stone-400 hover:text-white'
                }`}
                title={t('cc_dark')}
              >
                {t('cc_dark')}
              </button>
            </div>
          </div>
        </div>

        {/* Live Speech / Subtitle Line */}
        <div className="bg-black/40 border-b border-[#311718]/70 px-3 py-1 flex items-center justify-between text-[14px] backdrop-blur-sm shrink-0">
          <div className="flex items-center gap-2 text-stone-300 truncate max-w-[80%]">
            <span className="text-cp-400 font-bold text-[14px]">&gt;</span>
            <span className="text-[13px] truncate">
              {speech ||
                (emotion === 'capri2'
                  ? t('cc_lineDone')
                  : isRunning
                  ? t('cc_lineWorking')
                  : t('cc_lineIdle'))}
            </span>
          </div>

        </div>

        {/* Full-Screen Semi-Transparent Chat Terminal over Capri's Eyes */}
        <div className="flex-1 w-full h-full flex flex-col overflow-hidden">
          <AgentChat transparent={true} />
        </div>
      </div>
    </div>
  )
}
