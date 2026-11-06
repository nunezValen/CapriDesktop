import type { DesktopPreferences } from '../../../shared/mac-types'
import type { PlacementCommand } from '../../../shared/placement'
import React, { useEffect, useState, useRef } from 'react'
import type { PlatformStatus, MacPermission } from '../../../shared/mac-types'
import type { SpotifySettings, SpotifyDevice } from '../../../main/services/spotify-service'

const permissions: { id: MacPermission; label: string; description: string }[] = [
  { id: 'microphone', label: 'Microphone', description: 'Push-to-talk and always-listening voice input.' },
  {
    id: 'screen',
    label: 'Screen Recording',
    description: 'Capture the region inside the scanner. Restart Capri after granting access.',
  },
  {
    id: 'accessibility',
    label: 'Accessibility',
    description: 'Read window positions, perch on windows and select Spotify results. If the app is enabled but access is denied, click Enable to request access for the bundled desktop helper. If needed, add it with +, then ⌘⇧G and paste /Applications/Capri Desktop.app/Contents/Resources/scripts/macos/bin/capri-desktop.',
  },
  {
    id: 'automation',
    label: 'Automation',
    description: 'Control Spotify playback. macOS asks when you first use this feature.',
  },
]
export const MacSettings: React.FC = () => {
  const [status, setStatus] = useState<PlatformStatus | null>(null)
  const [spotify, setSpotify] = useState<SpotifySettings | null>(null)
  const [clientId, setClientId] = useState('')
  const [devices, setDevices] = useState<SpotifyDevice[]>([])
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [installingSpeech,setInstallingSpeech]=useState(false)
  const [speechLog,setSpeechLog]=useState('')
  const speechSetupRef=useRef(false)
  const [minutes,setMinutes]=useState(0)
  const [gameMinutes,setGameMinutes]=useState(0)
  const [query, setQuery] = useState('')
  const [desktop,setDesktop]=useState<DesktopPreferences|null>(null)
  const [position,setPosition]=useState<PlacementCommand>('bottom')
  const refresh = async () => {
    setStatus(await window.api.platform.status())
    const prefs=await window.api.desktop.preferences()
    setDesktop(prefs)
    setMinutes(prefs.screenCommentMinutes)
    setGameMinutes(prefs.gameCommentMinutes)
    const s = await window.api.spotify.settings()
    setSpotify(s)
    setClientId(s.clientId)
  }
  useEffect(() => {
    void refresh().catch(() => {})
    const focus = () => {
      void refresh().catch(() => {})
    }
    window.addEventListener('focus', focus)
    const unsubscribe=window.api.setup.onLog(({step,line})=>{if(speechSetupRef.current && ['python','whisper'].includes(step)) setSpeechLog(line)})
    return () => {window.removeEventListener('focus', focus);unsubscribe()}
  }, [])
  if (status?.platform !== 'darwin') return null
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setMessage('')
    try {
      await fn()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const permissionGranted=(id:MacPermission)=>status.permissions[id]==='granted' || (id==='automation' && status.permissions[id]==='Spotify: granted')
  const btn = 'cp-btn-ghost border border-[#633138] px-3 py-2 text-sm disabled:opacity-40'
  return (
    <section className="cp-frame p-4 space-y-4 select-text">
      <h2 className="cp-title text-xl">Mac settings</h2>
      <div className="space-y-2">
        <h3 className="font-semibold">Whisper · voice recognition / Hey Capri</h3>
        <p className="text-xs">{desktop?.speechReady ? 'Selected speech model is installed.' : 'Install Whisper to enable push-to-talk and Hey Capri.'} Recognition stays on this device. Cloud chat is unchanged.</p>
        <select aria-label="Speech recognition model" className="cp-input p-2 bg-[#170a0b]" disabled={busy} value={desktop?.speechModel || 'base'} onChange={e=>run(async()=>setDesktop(await window.api.desktop.configure({speechModel:e.target.value as 'base'|'small'})))}>
          <option value="base">Whisper base · ~150 MB · lighter</option>
          <option value="small">Whisper small · ~500 MB · more accurate</option>
        </select>
        <button
          disabled={busy}
          className={btn}
          onClick={() =>
            run(async () => {
              speechSetupRef.current=true
              setInstallingSpeech(true)
              setSpeechLog('Checking voice dependencies…')
              try {
              const setup=await window.api.setup.getStatus()
              if(!setup.ffmpeg) throw new Error('FFmpeg is missing. Install it with brew install ffmpeg, then click Install Whisper again.')
              if(!setup.python.envReady) {
                const env=await window.api.setup.run('python')
                if(!env.ok) throw new Error('Install Python 3.11 first, then retry voice setup.')
              }
              const result = await window.api.setup.run('whisper')
              setDesktop(await window.api.desktop.preferences())
              setMessage(
                result.ok
                  ? 'Whisper is ready. Right-click Capri → Enable Hey Capri, or press ⌘⌥L.'
                  : 'Speech model setup failed. Check the Python setup and setup log.',
              )
              setSpeechLog(result.ok ? 'Whisper installed and ready.' : 'Installation failed. You can retry this button.')
              } catch(error) {setSpeechLog(error instanceof Error ? error.message : String(error));throw error}
              finally {speechSetupRef.current=false;setInstallingSpeech(false)}
            })
          }
        >
          {installingSpeech ? 'Installing Whisper…' : desktop?.speechReady ? 'Repair Whisper' : `Install Whisper · ~${desktop?.speechModel==='small' ? '500' : '150'} MB`}
        </button>
        {speechLog && <p role="status" aria-live="polite" className="text-xs text-cyan-300 whitespace-pre-wrap break-words">{speechLog}</p>}
        <p className="text-xs">
          Creates the Python voice environment if needed and downloads only the selected speech model. No system packages are installed. Enable Hey Capri from the companion’s right-click menu (⌘⌥L); push-to-talk is ⌘⌥V. Say her name with every request.
        </p>
      </div>
      <div className="space-y-3 border-b border-[#633138] pb-4">
        <label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={desktop?.openAtLogin || false} disabled={busy || !desktop?.loginSupported} onChange={e=>run(async()=>setDesktop(await window.api.desktop.setOpenAtLogin(e.target.checked)))} />Open at Login</label>
        <p className="text-xs">Start Capri automatically when you sign in to your Mac. You can also manage this in System Settings → General → Login Items.</p>
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Companion position" className="cp-input p-2 bg-[#170a0b]" value={position} onChange={e=>setPosition(e.target.value as PlacementCommand)}>
            {['bottom','bottom-left','bottom-right','top','top-left','top-right','left','right','center'].map(p=><option key={p} value={p}>{p.replace('-',' ')}</option>)}
          </select>
          <button className={btn} disabled={busy} onClick={()=>run(async()=>setDesktop(await window.api.desktop.place(position)))}>Sit here</button>
          <button className={btn} disabled={busy} onClick={()=>run(async()=>setDesktop(await window.api.desktop.place('here')))}>Stay where you are</button>
          <button className={btn} disabled={busy} onClick={()=>run(async()=>setDesktop(await window.api.desktop.place('roam')))}>Roam again</button>
        </div>
        <p className="text-xs">{desktop?.positionPinned ? 'Position locked. Drag Capri to adjust the saved spot, or choose Roam again.' : 'Free to roam.'} You can also say “sit at the bottom right of my screen” or “stay here”. The saved position survives restarts.</p>
      </div>

      <div className="space-y-2 border-b border-[#633138] pb-4">
        <h3 className="font-semibold">Mac commands</h3>
        <p className="text-xs">Try “battery status”, “how much storage do I have”, “what macOS version am I on”, “set volume to 35 percent”, “mute the speakers”, “open my downloads folder”, or “open Wi-Fi settings”. System sound is separate from Capri’s voice volume. Wi-Fi, Bluetooth and privacy changes are made by you in System Settings.</p>
        <p className="text-xs">Voice settings also contains microphone selection, sound/glitch volume, monitor selection, customizable shortcuts and game-mode opacity. Hey Capri uses the default Mac microphone; the microphone picker applies to other voice input.</p>
      </div>
      <div className="space-y-2 border-b border-[#633138] pb-4">
        <h3 className="font-semibold">Screen comments</h3>
        <p className="text-xs">Off by default. When enabled, Capri sends a screenshot of the display under your pointer to your cloud vision provider at this interval. Pauses while the Mac is locked or Capri is busy. Screen Recording permission is required.</p>
        <label className="flex flex-wrap items-center gap-2 text-sm">Every
          <input aria-label="Screen comment interval in minutes" type="number" min="0" max="120" step="1" value={minutes} onChange={e=>setMinutes(Number(e.target.value))} className="cp-input w-20 p-2 bg-[#170a0b]" /> minutes (0 = off)
          <button disabled={busy || !Number.isInteger(minutes) || minutes<0 || minutes>120} className={btn} onClick={()=>run(async()=>{setDesktop(await window.api.desktop.configure({screenCommentMinutes:minutes}));setMessage(minutes ? `Automatic cloud screen comments enabled every ${minutes} minute(s).` : 'Automatic screen comments off.')})}>Save interval</button>
        </label>
        <h3 className="font-semibold">Game screen comments</h3>
        <p className="text-xs">When a supported foreground game is detected, use this interval instead. Off by default; enabling it sends screenshots to your cloud vision provider. Capri knows the detected game name and reacts to visible play, without game telemetry. Voice works during fullscreen games; text chat may switch focus away. Borderless/windowed mode is recommended for typing.</p>
        <label className="flex flex-wrap items-center gap-2 text-sm">Every
          <input aria-label="Game comment interval in minutes" type="number" min="0" max="120" step="1" value={gameMinutes} onChange={e=>setGameMinutes(Number(e.target.value))} className="cp-input w-20 p-2 bg-[#170a0b]" /> minutes (0 = off)
          <button disabled={busy || !Number.isInteger(gameMinutes) || gameMinutes<0 || gameMinutes>120} className={btn} onClick={()=>run(async()=>{setDesktop(await window.api.desktop.configure({gameCommentMinutes:gameMinutes}));setMessage(gameMinutes ? `Game screen comments enabled every ${gameMinutes} minute(s).` : 'Game screen comments off.')})}>Save game interval</button>
        </label>
      </div>
      <p className="text-sm text-[var(--cp-muted)]">
        Permissions are optional. Chat and the companion work without desktop access.
      </p>
      {permissions.map((p) => (
        <div key={p.id} className="flex gap-3 items-center border-b border-[#381a1b] pb-3">
          <div className="flex-1">
            <strong>{p.label}</strong> <span className="text-xs text-cyan-300">{status.permissions[p.id]}</span>
            <p className="text-xs text-[var(--cp-muted)]">{p.description}</p>
          </div>
          <button
            disabled={busy || permissionGranted(p.id)}
            className={btn}
            onClick={() =>
              run(async () => {
                setStatus(await window.api.platform.requestPermission(p.id))
              })
            }
          >
            {permissionGranted(p.id) ? 'Granted' : 'Enable'}
          </button>
          <button className={btn} onClick={() => run(() => window.api.platform.openPermission(p.id))}>
            Settings
          </button>
        </div>
      ))}
      <button disabled={busy} className={btn} onClick={() => run(refresh)}>
        Refresh status
      </button>
      <div className="space-y-2">
        <h3 className="font-semibold">Install dependencies yourself</h3>
        <p className="text-xs">If you already use Homebrew, run:</p>
        <code className="block text-sm">brew install python@3.11 ffmpeg</code>
        <p className="text-xs">
          Ollama is only needed for local chat/vision, not cloud mode or voice recognition. If you do not use Homebrew, see MACOS.md for manual alternatives.
          Capri creates its own Python environment when you select the Python step. Model downloads only start when
          selected below.
        </p>
      </div>
      <label className="block text-sm">
        Spotify control method
        <select
          className="cp-input block w-full mt-2 p-2 bg-[#170a0b]"
          value={spotify?.method || 'desktop'}
          disabled={busy}
          onChange={(e) =>
            run(async () => {
              setSpotify(await window.api.spotify.configure({ method: e.target.value as 'desktop' | 'web-api' }))
            })
          }
        >
          <option value="desktop">Desktop app (AppleScript + Accessibility)</option>
          <option value="web-api">Web API (Spotify Premium)</option>
        </select>
      </label>
      {spotify?.method === 'desktop' ? (
        <p className="text-xs">
          Install and sign into Spotify. Allow Accessibility and Automation. Automatic search only presses a matching
          accessible Play result; if Spotify changes its interface, use Web API mode.
        </p>
      ) : (
        <div className="space-y-2">
          <p className="text-xs">
            Create a Spotify developer app and register this exact redirect URI: <code>{spotify?.redirectUri}</code>.
            Use the client ID, not a client secret.
          </p>
          <input
            aria-label="Spotify client ID"
            className="cp-input w-full p-2 border border-[#633138]"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="Spotify client ID"
          />
          <div className="flex gap-2 flex-wrap">
            <button
              disabled={busy}
              className={btn}
              onClick={() =>
                run(async () => {
                  setSpotify(await window.api.spotify.configure({ clientId: clientId.trim() }))
                  const r = await window.api.spotify.connect()
                  setMessage(r.output)
                  await refresh()
                })
              }
            >
              {spotify?.connected ? 'Reconnect' : 'Save & connect'}
            </button>
            <button
              className={btn}
              onClick={() =>
                run(async () => {
                  setSpotify(await window.api.spotify.disconnect())
                })
              }
            >
              Disconnect / cancel
            </button>
            <button
              disabled={busy || !spotify?.connected}
              className={btn}
              onClick={() => run(async () => setDevices(await window.api.spotify.devices()))}
            >
              Refresh devices
            </button>
          </div>
          <p className="text-xs">
            {spotify?.connected ? 'Connected' : 'Not connected'}. Open Spotify if no playback device appears.
          </p>
          <select
            aria-label="Spotify device"
            className="cp-input w-full p-2 bg-[#170a0b]"
            value={spotify?.deviceId || ''}
            onChange={(e) =>
              run(async () => setSpotify(await window.api.spotify.configure({ deviceId: e.target.value })))
            }
          >
            <option value="">Use active device</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
                {d.is_active ? ' (active)' : ''}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="flex gap-2">
        <input
          aria-label="Spotify test track"
          className="cp-input p-2 flex-1 min-w-0 border border-[#633138]"
          placeholder="Song and artist"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          disabled={busy || !query.trim()}
          className={btn}
          onClick={() =>
            run(async () => {
              const r = await window.api.spotify.play(query)
              setMessage(r.output)
            })
          }
        >
          Play track
        </button>
      </div>
      {message && (
        <p role="status" className="text-sm text-[var(--cp-yellow)] whitespace-pre-wrap">
          {message}
        </p>
      )}
      <p className="text-xs text-[var(--cp-muted)]">Drag with the left mouse button. Shake left/right deliberately to trigger the glitch reaction; ordinary moves and right-click menus do not trigger it.</p>
      <p className="text-xs text-[var(--cp-muted)]">
        This Mac release excludes Paint drawing, ShadowPlay, game integrations and shell-command voice macros.
      </p>
    </section>
  )
}
