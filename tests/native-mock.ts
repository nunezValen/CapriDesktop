export const calls: string[] = []
export let nativeStatus = { accessibility: false, spotifyAutomation: 'denied', systemEventsAutomation: 'denied' }
export const macHelper = async (command: string) => {
  calls.push(command)
  if (command === 'status') return nativeStatus
  if (command === 'spotify-search' && desktopMode === 'opening') { desktopMode='success'; return {retryable:true,error:'Spotify search is still opening.'} }
  if (command === 'spotify-result')
    return desktopMode === 'success'
      ? { candidates: [{ uri: 'spotify:track:1234567890123456789012', title: 'Example', artist:'Artist' }] }
      : { error: 'Spotify lost focus; search cancelled.' }
  if (command === 'processes') return [{ name: 'Safari' }]
  return []
}
export const macWindows = async () => []
export const quitMacApp = async (name: string) => {
  calls.push(`quit:${name}`)
  return true
}
export const launchMacApp = async (name: string) => {
  calls.push(`launch:${name}`)
  return true
}
let volume:number|null=null
let muted=false
export function mockSystemVolume(value:number|null){volume=value;muted=false}
export const appleScript = async (script='') => {
  calls.push('applescript')
  if(volume!==null) {
    const set=script.match(/set volume output volume (\d+)/)
    if(set) volume=Number(set[1])
    if(script.includes('set volume with output muted')) muted=true
    if(script.includes('set volume without output muted')) muted=false
    if(script.includes('return output muted')) return String(muted)
    if(script.includes('return output volume')) return String(volume)
    return `${volume}|${muted}`
  }
  if (desktopMode === 'success') return 'playing\nArtist - Example\nspotify:track:1234567890123456789012'
  throw new Error('Automation denied (test)')
}
let desktopMode = 'denied'
export function setDesktopMode(mode: string) {
  desktopMode = mode
  nativeStatus.spotifyAutomation = mode === 'success' ? 'granted' : 'denied'
}
