import { macUsageSummary } from './mac-usage'
import { roamingManager } from '../roaming/roaming-manager'
import { anchorBounds } from '../../shared/placement'
import { agentManager } from '../agents/agent-manager'
import type { AgentEventPayload } from '../ipc/channels'
/** Opt-in local diagnostics. Uses a separate --user-data-dir supplied by the runner. */
import { app, BrowserWindow, screen, desktopCapturer } from 'electron'
import fs from 'fs'
import path from 'path'
import { windowManager } from '../windows/window-manager'
import { registerIpcHandlers } from '../ipc/register-handlers'
import { platformStatus } from './mac-permissions'
import { setupService } from './setup-service'
import { macHelper, macForegroundWindow, macWindows, macWindowGeometry } from './mac-desktop'
import { spotifyService } from './spotify-service'
import { consciousnessService } from './consciousness-service'
import { ollamaService } from './ollama-service'
import { voiceService } from './voice-service'
import { scannerService } from './scanner-service'

export async function runMacSmokeTest(reportFile: string): Promise<void> {
  const report: Record<string, unknown> = {
    packaged: app.isPackaged,
    arch: process.arch,
    version: app.getVersion(),
    userData: app.getPath('userData'),
    checks: {},
  }
  const checks = report.checks as Record<string, unknown>
  const failures: string[] = []
  const check = async (name: string, fn: () => Promise<unknown>) => {
    try {
      checks[name] = { ok: true, result: await fn() }
    } catch (e) {
      checks[name] = { ok: false, error: String(e) }
      failures.push(name)
    }
  }
  const timeout = setTimeout(
    () => {
      fs.writeFileSync(reportFile, JSON.stringify({ ...report, timeout: true }, null, 2))
      app.exit(1)
    },
    app.commandLine.hasSwitch('mac-live-ai') ? 120000 : 45000,
  )
  try {
    consciousnessService.init()
    registerIpcHandlers()
    windowManager.init()
    const errors: string[] = []
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.on('render-process-gone', (_e, details) => errors.push(details.reason))
      win.webContents.on('console-message', (_e, level, message) => {
        if (level >= 3) errors.push(message)
      })
    }
    await check('position-restored-at-startup',async()=>{
      const file=path.join(app.getPath('userData'),'desktop-placement.json')
      const saved=fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : null
      if (saved && (!roamingManager.isPositionPinned() || JSON.stringify(windowManager.getCompanionWindow()!.getBounds())!==JSON.stringify(saved.bounds))) throw new Error('Saved position did not restore at startup')
      return {restored:!!saved}
    })
    await check('native-helper', () => macHelper('status'))
    await check('foreground', () => macForegroundWindow())
    await check('permissions', () => platformStatus())
    await check('dependencies', () => setupService.getStatus())
    await check('native-window-tracking', async () => {
      const native = await platformStatus()
      if (!native.capabilities.desktopAwareness) return { skipped: 'Accessibility not granted' }
      const win = (await macWindows()).find((w) => w.width >= 320 && w.height >= 220)
      if (!win) throw new Error('No eligible desktop window found with Accessibility granted')
      const geometry = await macWindowGeometry(win.hwnd)
      if (!geometry || geometry.width <= 0) throw new Error('Tracked window identity was not stable')
      windowManager.setTabMode(true, geometry)
      windowManager.updateTabWindowPosition(geometry)
      windowManager.setTabMode(false)
      return { tracked: true, width: geometry.width, height: geometry.height }
    })

    await new Promise((resolve) => setTimeout(resolve, 4500))
    await check('renderer-ipc', async () => {
      const deck = windowManager.getDeckWindow()!
      const result = await deck.webContents.executeJavaScript(
        `Promise.all([window.api.platform.status(), window.api.spotify.settings(), window.api.media.getStatus()]).then(([platform,spotify,media])=>({platform,spotify,media,body:document.body.innerText.slice(0,300)}))`,
      )
      if (!result.body || result.platform.platform !== 'darwin')
        throw new Error('Renderer or preload did not initialize')
      return result
    })
    await check('companion', async () => {
      const win = windowManager.getCompanionWindow()!
      if (win.webContents.isCrashed()) throw new Error('Companion renderer crashed')
      const image = await win.capturePage()
      fs.writeFileSync(path.join(path.dirname(reportFile), 'companion.png'), image.toPNG())
      return { bounds: win.getBounds(), screenshot: 'companion.png' }
    })
    await check('mac-settings-ui', async () => {
      const deck = windowManager.getDeckWindow()!
      await deck.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Settings')?.click()`,
      )
      let text = ''
      for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setTimeout(resolve, 400))
        text = await deck.webContents.executeJavaScript('document.body.innerText')
        if (text.toLowerCase().includes('mac settings')) break
      }
      fs.writeFileSync(path.join(path.dirname(reportFile), 'mac-settings.png'), (await deck.capturePage()).toPNG())
      if (!text.toLowerCase().includes('mac settings')) throw new Error('Mac settings did not render')
      fs.writeFileSync(path.join(path.dirname(reportFile), 'mac-settings.png'), (await deck.capturePage()).toPNG())
      return { rendered: true }
    })
    await check('gaming-mode', async () => {
      windowManager.setGamingMode(true, 'top-left')
      windowManager.setCompanionClickThrough(true)
      windowManager.setCompanionClickThrough(false)
      windowManager.setGamingMode(false)
      return true
    })
    await check('missing-voice-dependencies', async () => {
      const dependencies = await setupService.getStatus()
      if (dependencies.python.systemPython)
        return { skipped: 'Python is installed; run end-to-end voice checks separately.' }
      const result = await voiceService.synthesize('Dependency check', 'en', { silent: true })
      if (result.success || !result.error?.includes('Voice engine could not start'))
        throw new Error('Missing Python was not reported correctly')
      return { failedGracefully: true }
    })
    await check('spotify-default', async () => {
      if (spotifyService.settings().method !== 'desktop') throw new Error('Unexpected default')
      return spotifyService.settings()
    })
    await check('mac-memory-report', () => macUsageSummary())
    await check('scanner-permission', async () => {
      if (app.commandLine.hasSwitch('mac-skip-capture')) return {skipped:'Live capture deferred by user'}
      const status = await platformStatus()
      scannerService.open()
      await new Promise((resolve) => setTimeout(resolve, 1500))
      report.captureSources = (
        await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 800, height: 600 } })
      ).map((s) => ({ id: s.id, displayId: s.display_id, empty: s.thumbnail.isEmpty(), size: s.thumbnail.getSize() }))
      try {
        const captured = await scannerService.captureRegionBase64()
        if (!status.capabilities.screenCapture)
          throw new Error('Capture unexpectedly succeeded without screen permission')
        if (!captured) throw new Error('Capture returned no image')
        return { captured: true, width: captured.width, height: captured.height }
      } catch (e) {
        if (!status.capabilities.screenCapture && String(e).includes('Screen Recording'))
          return { deniedGracefully: true }
        throw e
      } finally {
        scannerService.close()
      }
    })
    if (app.commandLine.hasSwitch('mac-live-ai'))
      await check('live-chat', async () => {
        const tags = await ollamaService.queryTags()
        const model = tags.models.find((m) => m === 'qwen3:1.7b')
        if (!model)
          return { skipped: 'The diagnostic model qwen3:1.7b is not already installed. No download was started.' }
        agentManager.setConfig({ model })
        const deck = windowManager.getDeckWindow()!
        await deck.webContents.executeJavaScript(`window.__macTestEvents=[]; window.__macTestOff=window.api.agent.onEvent(event=>window.__macTestEvents.push(event)); true`)
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            agentManager.sendPrompt('Reply with exactly MAC_OK.', app.getPath('userData'), undefined, 'editor'),
            new Promise((_, reject) => {
              timer = setTimeout(() => {
                agentManager.cancel()
                reject(new Error('Live chat timed out'))
              }, 65000)
            }),
          ])
          const received: AgentEventPayload[] = await deck.webContents.executeJavaScript('window.__macTestEvents')
          const answer = received.filter(e=>e.type==='assistant.delta').map(e=>e.text || '').join('')
          const events = received.map(e=>e.type)
          if (!answer.includes('MAC_OK')) throw new Error(`Unexpected chat response: ${answer.slice(0, 400)}`)
          return { model, response: answer.slice(0, 400), events }
        } finally {
          if (timer) clearTimeout(timer)
          await deck.webContents.executeJavaScript('window.__macTestOff?.()')
        }
      })
    await check('desktop-preferences-and-position',async()=>{
      const deck=windowManager.getDeckWindow()!
      const initial=await deck.webContents.executeJavaScript('window.api.desktop.preferences()')
      if (!initial.loginSupported) throw new Error('Installed Mac app did not offer Login Items')
      const win=windowManager.getCompanionWindow()!
      const expected=anchorBounds(screen.getDisplayMatching(win.getBounds()).workArea,{width:360,height:360},'bottom-right')
      await deck.webContents.executeJavaScript("window.api.desktop.place('bottom-right')")
      await new Promise(r=>setTimeout(r,100))
      if (JSON.stringify(win.getBounds())!==JSON.stringify(expected)) throw new Error('Screen placement mismatch')
      if (windowManager.isDeckVisible()) throw new Error('Positioning did not reveal the companion')
      windowManager.showDeck();windowManager.hideDeck()
      roamingManager.startAutonomousCycle()
      await new Promise(r=>setTimeout(r,4600))
      if (JSON.stringify(win.getBounds())!==JSON.stringify(expected)) throw new Error('Pinned position moved after editor/autonomous restart')
      await deck.webContents.executeJavaScript("window.api.desktop.place('here')")
      const saved=JSON.parse(fs.readFileSync(path.join(app.getPath('userData'),'desktop-placement.json'),'utf8'))
      if (JSON.stringify(saved.bounds)!==JSON.stringify(expected)) throw new Error('Position was not persisted')
      const wasPinnedAtStartup=initial.positionPinned
      return {loginSupported:true,openAtLogin:initial.openAtLogin,pinned:true,wasPinnedAtStartup,savedBounds:saved.bounds}
    })
    report.displays = screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor }))
    report.rendererErrors = errors
    if (errors.length) failures.push('renderer-errors')
  } catch (e) {
    report.error = String(e)
    failures.push('startup')
  } finally {
    clearTimeout(timeout)
    voiceService.stopServer()
    await ollamaService.stop()
    report.failures = failures
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2))
    app.exit(failures.length ? 1 : 0)
  }
}
