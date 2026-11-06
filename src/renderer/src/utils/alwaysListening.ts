/**
 * Always-on microphone with a simple voice-activity detector. Each utterance
 * (with 0.5 s of pre-roll) is encoded as 16 kHz mono WAV and passed to onUtterance.
 */

import { openMicrophone, openDefaultMicrophone } from './microphone'
export interface AlwaysListenerOptions {
  onUtterance: (wav: ArrayBuffer) => void
  /** While true (Capri speaking, push-to-talk, agent busy) audio is ignored */
  isPaused: () => boolean
  onError?: (error: Error) => void
  onLevel?: (level: number, speaking: boolean) => void
}

const FRAME = 2048
const PRE_ROLL_SEC = 0.5
const END_SILENCE_MS = 900
const MIN_SPEECH_MS = 450
const MAX_UTTERANCE_SEC = 12
const TARGET_RATE = 16000

export class AlwaysListener {
  private stream: MediaStream | null = null
  private ctx: AudioContext | null = null
  private processor: ScriptProcessorNode | null = null
  private source: MediaStreamAudioSourceNode | null = null

  private noiseFloor = 0.01
  private preRoll: Float32Array[] = []
  private current: Float32Array[] = []
  private speaking = false
  private loudFrames = 0
  private lastVoiceAt = 0
  private speechStartedAt = 0

  constructor(private opts: AlwaysListenerOptions) {}

  public get active(): boolean {
    return !!this.stream
  }

  public async start(): Promise<void> {
    if (this.stream) return
    this.stream = /Mac/i.test(navigator.platform)
      ? await openDefaultMicrophone({echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1})
      : await openMicrophone({echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1})
    try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext
    this.ctx = new AudioCtx()
    await this.ctx.resume()
    this.stream.getAudioTracks().forEach(track => {
      track.onended = () => { this.stop(); this.opts.onError?.(new Error("Microphone disconnected. Turn listening on again after reconnecting it.")) }
    })
    this.source = this.ctx.createMediaStreamSource(this.stream)
    // ScriptProcessor is deprecated but universally available in Electron and plenty for VAD
    this.processor = this.ctx.createScriptProcessor(FRAME, 1, 1)
    this.processor.onaudioprocess = (e) => this.onFrame(e.inputBuffer.getChannelData(0))
    this.source.connect(this.processor)
    this.processor.connect(this.ctx.destination)
    } catch (error) {
      this.stop()
      throw error
    }
  }

  public stop(): void {
    try {
      this.processor?.disconnect()
      this.source?.disconnect()
    } catch {}
    this.stream?.getTracks().forEach((t) => { t.onended = null; t.stop() })
    this.ctx?.close().catch(() => {})
    this.stream = null
    this.ctx = null
    this.processor = null
    this.source = null
    this.reset()
    this.preRoll = []
  }

  private reset(): void {
    this.current = []
    this.speaking = false
    this.loudFrames = 0
  }

  private onFrame(input: Float32Array): void {
    const frame = new Float32Array(input) // copy: the buffer is reused by the audio thread
    const sampleRate = this.ctx?.sampleRate || 48000
    const frameMs = (FRAME / sampleRate) * 1000
    const now = performance.now()

    if (this.opts.isPaused()) {
      this.reset()
      this.preRoll = []
      return
    }

    let sum = 0
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
    const rms = Math.sqrt(sum / frame.length)
    const threshold = Math.max(0.012, this.noiseFloor * 3)
    const loud = rms > threshold
    this.opts.onLevel?.(Math.min(100, Math.round((rms / 0.12) * 100)), this.speaking)

    if (!this.speaking) {
      // Learn the background level only while nobody is talking
      if (!loud) this.noiseFloor = this.noiseFloor * 0.97 + rms * 0.03

      this.preRoll.push(frame)
      const maxPre = Math.ceil((PRE_ROLL_SEC * 1000) / frameMs)
      while (this.preRoll.length > maxPre) this.preRoll.shift()

      this.loudFrames = loud ? this.loudFrames + 1 : 0
      if (this.loudFrames >= 2) {
        this.speaking = true
        this.speechStartedAt = now
        this.lastVoiceAt = now
        this.current = [...this.preRoll]
        this.preRoll = []
      }
      return
    }

    this.current.push(frame)
    if (loud) this.lastVoiceAt = now

    const tooLong = now - this.speechStartedAt > MAX_UTTERANCE_SEC * 1000
    if (now - this.lastVoiceAt > END_SILENCE_MS || tooLong) {
      const voicedMs = this.lastVoiceAt - this.speechStartedAt
      const chunks = this.current
      this.reset()
      if (voicedMs >= MIN_SPEECH_MS) {
        this.opts.onUtterance(encodeWav(chunks, sampleRate))
      }
    }
  }
}

/** Concatenate, downsample to 16 kHz and wrap as a 16-bit PCM mono WAV */
function encodeWav(chunks: Float32Array[], inputRate: number): ArrayBuffer {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const merged = new Float32Array(total)
  let offset = 0
  for (const c of chunks) {
    merged.set(c, offset)
    offset += c.length
  }

  const ratio = inputRate / TARGET_RATE
  const outLen = Math.floor(merged.length / ratio)
  const pcm = new Int16Array(outLen)
  for (let i = 0; i < outLen; i++) {
    // simple averaging decimation (good enough for speech)
    const start = Math.floor(i * ratio)
    const end = Math.min(merged.length, Math.floor((i + 1) * ratio))
    let acc = 0
    for (let j = start; j < end; j++) acc += merged[j]
    const v = Math.max(-1, Math.min(1, acc / Math.max(1, end - start)))
    pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff
  }

  const buffer = new ArrayBuffer(44 + pcm.byteLength)
  const view = new DataView(buffer)
  const writeStr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + pcm.byteLength, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, TARGET_RATE, true)
  view.setUint32(28, TARGET_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, pcm.byteLength, true)
  new Int16Array(buffer, 44).set(pcm)
  return buffer
}
