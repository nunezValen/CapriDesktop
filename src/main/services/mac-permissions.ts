import { platformCapabilities } from '../../shared/platform-policy'
import { shell, systemPreferences } from 'electron'
import { isMac } from './platform'
import { macHelper, appleScript, launchMacApp } from './mac-desktop'
import type { MacPermission, PlatformStatus } from '../../shared/mac-types'

const panes: Record<MacPermission, string> = {
  microphone: 'Privacy_Microphone',
  screen: 'Privacy_ScreenCapture',
  accessibility: 'Privacy_Accessibility',
  automation: 'Privacy_Automation',
}
export async function platformStatus(): Promise<PlatformStatus> {
  const native = isMac
    ? await macHelper<{ accessibility: boolean; spotifyAutomation: string; systemEventsAutomation: string }>(
        'status',
      ).catch(() => ({ accessibility: false, spotifyAutomation: 'unavailable', systemEventsAutomation: 'unavailable' }))
    : null
  const ax = native?.accessibility ?? !isMac
  return {
    platform: process.platform,
    permissions: {
      microphone: isMac ? systemPreferences.getMediaAccessStatus('microphone') : 'not-required',
      screen: isMac ? systemPreferences.getMediaAccessStatus('screen') : 'not-required',
      accessibility: !isMac || ax ? 'granted' : systemPreferences.isTrustedAccessibilityClient(false) ? 'App granted; desktop helper needs access' : 'not-granted',
      automation: native ? `Spotify: ${native.spotifyAutomation}` : 'not-required',
    },
    capabilities: platformCapabilities(
      process.platform,
      ax,
      !isMac || systemPreferences.getMediaAccessStatus('screen') === 'granted',
    ),
  }
}
export async function openPermission(permission: MacPermission): Promise<void> {
  if (!isMac || !Object.hasOwn(panes, permission)) throw new Error('Invalid Mac permission')
  await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${panes[permission]}`)
}
export async function requestPermission(permission: MacPermission): Promise<PlatformStatus> {
  if (!isMac || !Object.hasOwn(panes, permission)) throw new Error('Invalid Mac permission')
  if (permission === 'accessibility') {
    systemPreferences.isTrustedAccessibilityClient(true)
    await macHelper('request-accessibility').catch(() => {})
    await openPermission(permission)
  } else if (permission === 'microphone') await systemPreferences.askForMediaAccess('microphone')
  else if (permission === 'automation') {
    // Explicit user action: start Spotify so macOS can request this app's playback permission.
    if (!(await launchMacApp('Spotify'))) throw new Error('Install Spotify in Applications first.')
    try {
      await appleScript('tell application "Spotify" to get player state')
    } catch {
      await openPermission(permission)
    }
  } else await openPermission(permission)
  return platformStatus()
}
