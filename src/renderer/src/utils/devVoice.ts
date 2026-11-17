import { voiceVolume } from './soundSettings'
import { personalize } from './userName'
import dialogueBlipAudio from '../assets/dialogue_blip.wav'
import { useAgentStore } from '../stores/useAgentStore'
import { useCompanionStore } from '../stores/useCompanionStore'

let activeDevAudio: HTMLAudioElement | null = null
let currentVoiceId = 0

/**
 * Extracts a concise, conversational voice excerpt from assistant text by stripping
 * raw code blocks, markdown symbols, and technical syntax.
 */
export function extractSpokenDevExcerpt(rawText: string): string {
  if (!rawText) return ''

  // Strip triple-backtick code blocks and html tags
  let cleaned = rawText
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/<\/?[^>]+(>|$)/g, ' ')

  // Strip URLs and markdown links
  cleaned = cleaned
    .replace(/https?:\/\/[^\s]+/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Emotion tags like [excited] go whole: stripping only the brackets left the word to be read out
    .replace(/\[[a-zA-Z0-9_\s\-]+\]/g, ' ')

  // Strip markdown syntax symbols, emojis, and noisy characters
  cleaned = cleaned
    .replace(/[\u{1F300}-\u{1F9FF}]|[\u{1FA00}-\u{1FAFF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, '')
    .replace(/[#*_~>|\\{}[\]^]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  // If nothing is left (e.g. prompt only returned raw code), return a cheerful netrunner voice line
  if (!cleaned || cleaned.length < 5) {
    const fallbackLines = [
      "Done! Code is patched and ready, choomba!",
      "Executed! Check out the updated code!",
      "Target breached! Script updated with zero ICE alarms!"
    ]
    return fallbackLines[Math.floor(Math.random() * fallbackLines.length)]
  }

  // Take first 1-3 sentences, maximum ~220 characters for crisp dialogue
  const sentences = cleaned.split(/(?<=[.!?])\s+/).filter(Boolean)
  let excerpt = ''
  for (const s of sentences) {
    if ((excerpt + ' ' + s).length > 220) break
    excerpt = excerpt ? `${excerpt} ${s}` : s
  }

  return (excerpt || cleaned.slice(0, 200)).trim()
}

type DevLineOptions = { isFullExcerpt?: boolean; onStart?: () => void; onEnd?: () => void }

// Lines play one after another (no overlapping or cutting each other off). Anything the user
// does interrupts: stopDevVoice() clears the queue and stops the current line.
const devQueue: { text: string; options?: DevLineOptions }[] = []
let devPumping = false
let finishCurrentLine: (() => void) | null = null

/**
 * Stop any ongoing voice speech immediately and forget queued lines.
 */
export function stopDevVoice(): void {
  devQueue.length = 0
  currentVoiceId++
  if (activeDevAudio) {
    try {
      activeDevAudio.pause()
      activeDevAudio.currentTime = 0
    } catch {}
    activeDevAudio = null
  }
  finishCurrentLine?.()
  finishCurrentLine = null
}

// The deck going away (task finished while the user was elsewhere) hands the voice over to the
// desktop Capri's wake-up line: the deck must not keep talking underneath it
try {
  window.api?.deck?.onStatusChanged?.((open: boolean) => {
    if (!open) stopDevVoice()
  })
} catch {}

/**
 * Speaks text using Capri's neural voice (Edge TTS or dialogue blip) in Dev Mode, queued after
 * whatever she is already saying. Respects isDevVoiceEnabled setting.
 */
export async function speakDevVoice(text: string, options?: DevLineOptions): Promise<void> {
  if (!useAgentStore.getState().isDevVoiceEnabled) return
  if (devQueue.length >= 4) devQueue.shift()
  devQueue.push({ text, options })
  if (devPumping) return
  devPumping = true
  try {
    while (devQueue.length) {
      const next = devQueue.shift() as { text: string; options?: DevLineOptions }
      await playDevLine(next.text, next.options)
    }
  } finally {
    devPumping = false
  }
}

/** Plays one line; resolves when it finished (or was stopped) */
function playDevLine(text: string, options?: DevLineOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      if (finishCurrentLine === finish) finishCurrentLine = null
      resolve()
    }
    finishCurrentLine = finish
    void (async () => {
      const clean = personalize(options?.isFullExcerpt ? text : extractSpokenDevExcerpt(text))
      if (!clean) return finish()

      const voiceId = ++currentVoiceId
      const { setEmotion, setSpeech } = useCompanionStore.getState()
      const ended = () => {
        setEmotion('ojos')
        options?.onEnd?.()
        finish()
      }

      // Update speech bubble & animation
      setSpeech(clean, Math.max(3500, clean.length * 60))
      setEmotion('capri2')

      try {
        options?.onStart?.()

        // Try neural voice synthesis via main process Edge TTS
        if (window.api?.voice?.synthesize) {
          const res = await window.api.voice.synthesize(clean)
          if (voiceId !== currentVoiceId) return finish() // stopped while synthesizing

          if (res.success && res.audioDataUrl) {
            const audio = new Audio(res.audioDataUrl)
            audio.volume = voiceVolume()
            audio.playbackRate = 1.05
            activeDevAudio = audio
            audio.onended = () => {
              if (activeDevAudio === audio) activeDevAudio = null
              ended()
            }
            audio.onerror = () => {
              if (activeDevAudio === audio) activeDevAudio = null
              ended()
            }
            await audio.play().catch(() => ended())
            return
          }
        }

        // Fallback: Dialogue Blip audio with automatic duration
        const blip = new Audio(dialogueBlipAudio)
        blip.volume = 0.65
        activeDevAudio = blip
        const duration = Math.min(5000, Math.max(2000, clean.length * 45))
        await blip.play().catch(() => {})
        setTimeout(() => {
          if (activeDevAudio === blip) activeDevAudio = null
          if (voiceId === currentVoiceId) ended()
          else finish()
        }, duration)
      } catch (err) {
        console.warn('[speakDevVoice] failed:', err)
        ended()
      }
    })()
  })
}

/**
 * Speaks a quick acknowledgement when the user sends a message in dev mode.
 */
export async function speakDevAck(): Promise<void> {
  const acks = [
    "Analyzing that code, choomba!",
    "Jacking in and executing, choomba!",
    "Whoa, let's see what you've got here!",
    "Watching your code like a hawk, choomba!"
  ]
  const randomAck = acks[Math.floor(Math.random() * acks.length)]
  // The user just sent something: interrupt whatever she was saying
  stopDevVoice()
  await speakDevVoice(randomAck, { isFullExcerpt: true })
}
