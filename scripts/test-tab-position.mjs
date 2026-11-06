import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

function createManager(workArea) {
  const source = readFileSync(new URL('../src/main/windows/window-manager.ts', import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  })
  const exports = {}
  const events = []
  let bounds = { x: workArea.x + 100, y: workArea.y + 100, width: 420, height: 520 }
  const win = {
    isDestroyed: () => false,
    getBounds: () => bounds,
    setBounds: (value) => { bounds = { ...value } },
    setAlwaysOnTop: () => {},
    show: () => {},
    webContents: { send: (...args) => events.push(args) }
  }
  const dependencies = {
    electron: {
      screen: { getDisplayMatching: () => ({ workArea }) },
      BrowserWindow: { getAllWindows: () => [win] }
    },
    '../ipc/channels': {
      IPC_CHANNELS: { COMPANION_SET_TAB_MODE: 'tab-mode', COMPANION_STATE_CHANGED: 'state' }
    }
  }
  runInNewContext(outputText, { exports, require: (name) => dependencies[name] || {} })
  const manager = new exports.WindowManager()
  manager.companionWin = win
  return { manager, events, getBounds: () => bounds }
}

for (const workArea of [
  { x: 0, y: 0, width: 1920, height: 1040 },
  { x: -2560, y: 40, width: 2560, height: 1400 }
]) {
  test(`front sitting stays in the corner of display at ${workArea.x},${workArea.y}`, () => {
    const { manager, events, getBounds } = createManager(workArea)
    const expected = {
      x: workArea.x + workArea.width - 385,
      y: workArea.y + 40,
      width: 360,
      height: 360
    }
    const rect = { left: workArea.x + 200, top: workArea.y + 300, width: 900, height: 600 }
    for (const target of [undefined, rect]) {
      assert.equal(manager.setTabMode(true, target, false, 'front'), true)
      assert.deepEqual(getBounds(), expected)
      assert.deepEqual(events.at(-1), ['state', 'idle_front'])
      manager.updateTabWindowPosition(rect, 'front')
      assert.deepEqual(getBounds(), expected)
    }
  })
}

test('perch sitting still follows the target window and stays on screen', () => {
  const { manager, events, getBounds } = createManager({ x: 0, y: 0, width: 1920, height: 1040 })
  manager.setTabMode(true, { left: 100, top: 400, width: 1000, height: 600 })
  assert.deepEqual(getBounds(), { x: 780, y: 185, width: 360, height: 360 })
  assert.deepEqual(events.at(-1), ['state', 'idle'])
  manager.updateTabWindowPosition({ left: 200, top: 450, width: 1000, height: 600 })
  assert.deepEqual(getBounds(), { x: 880, y: 235, width: 360, height: 360 })
  manager.updateTabWindowPosition({ left: 1800, top: 0, width: 1000, height: 1000 })
  assert.deepEqual(getBounds(), { x: 1550, y: 0, width: 360, height: 360 })
})
