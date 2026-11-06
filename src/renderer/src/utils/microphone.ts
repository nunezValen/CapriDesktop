/**
 * Opens the microphone for every part of the app that listens. A headset that's busy or a saved
 * device that was unplugged shouldn't mean silence: it falls back to the others before giving up.
 */

const STORAGE_KEY = 'capri.micDevice'
const OPEN_TIMEOUT_MS = 8000

export type MicError = 'denied' | 'none' | 'busy' | 'other'

export function getSavedMic(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || ''
  } catch {
    return ''
  }
}

export function saveMic(deviceId: string): void {
  try {
    if (deviceId) localStorage.setItem(STORAGE_KEY, deviceId)
    else localStorage.removeItem(STORAGE_KEY)
  } catch {}
}

export function micErrorKind(err: unknown): MicError {
  const name = String((err as { name?: string })?.name || '')
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'denied'
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return 'none'
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return 'busy'
  return 'other'
}

// Some drivers never answer: without a limit the key would look dead until she's restarted
function openWithin(constraints: MediaStreamConstraints): Promise<MediaStream> {
  return new Promise((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => {
      done = true
      reject(Object.assign(new Error('The microphone did not answer'), { name: 'AbortError' }))
    }, OPEN_TIMEOUT_MS)
    navigator.mediaDevices.getUserMedia(constraints).then(
      (stream) => {
        clearTimeout(timer)
        if (done) stream.getTracks().forEach((t) => t.stop())
        else resolve(stream)
      },
      (err) => {
        clearTimeout(timer)
        if (!done) reject(err)
      }
    )
  })
}

export async function openDefaultMicrophone(audio: MediaTrackConstraints = {}): Promise<MediaStream> {
  return openWithin({audio:{...audio,deviceId:'default'},video:false})
}
export async function openMicrophone(audio: MediaTrackConstraints = {}): Promise<MediaStream> {
  const saved = getSavedMic()
  if (saved) {
    try {
      return await openWithin({ audio: { ...audio, deviceId: { exact: saved } } })
    } catch (err) {
      console.warn('[Microphone] The saved microphone failed, using the default one:', err)
    }
  }

  let firstError: unknown
  try {
    return await openWithin({ audio: Object.keys(audio).length ? audio : true })
  } catch (err) {
    firstError = err
    // Permission is for the whole system: another device won't change that answer
    if (micErrorKind(err) === 'denied') throw err
  }

  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[])
  for (const device of devices) {
    if (device.kind !== 'audioinput' || device.deviceId === 'default' || device.deviceId === saved) continue
    try {
      return await openWithin({ audio: { ...audio, deviceId: { exact: device.deviceId } } })
    } catch (err) {
      console.warn(`[Microphone] "${device.label}" failed:`, err)
    }
  }
  throw firstError
}

/** The line Capri says when the microphone can't be opened */
export function micErrorLine(kind: MicError): string {
  switch (kind) {
    case 'denied':
      return 'The system is blocking my microphone, choomba. Allow it in your privacy settings.'
    case 'none':
      return "I can't find any microphone, choomba. Plug one in or pick another in my voice settings."
    case 'busy':
      return 'Another app is holding the microphone, choomba. Close it and try again.'
    default:
      return "I couldn't open the microphone, choomba. Try picking another one in my voice settings."
  }
}
