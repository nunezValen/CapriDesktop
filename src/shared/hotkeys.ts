/**
 * Her configurable keys. They're stored as Electron accelerators ("Down", "Control+Alt+K"), the same
 * text the global shortcuts take, so the main process and the windows compare the same thing.
 */

export type HotkeyAction = 'talk' | 'listen' | 'chat'
export type Hotkeys = Record<HotkeyAction, string>
export type HotkeyProblem = 'needsModifier' | 'reserved' | 'inUse' | 'taken'

export function defaultHotkeys(platform:string): Hotkeys {
  return platform==='darwin' ? {talk:'Alt+Super+V',listen:'Alt+Super+L',chat:'Alt+Super+C'} : {talk:'Down',listen:'Right',chat:'Left'}
}
const macPlatform=(typeof process!=='undefined' && process.platform==='darwin') || (typeof navigator!=='undefined' && /Mac/i.test(navigator.platform))
export const DEFAULT_HOTKEYS: Hotkeys = defaultHotkeys(macPlatform ? 'darwin' : 'other')
export const HOTKEY_ACTIONS: HotkeyAction[] = ['talk', 'listen', 'chat']

/** Her fixed shortcuts, and Escape, which cancels a recording and a key being chosen */
const RESERVED = new Set(['Control+Alt+V', 'Control+Alt+S', 'Control+Alt+G', 'Alt+Super+V', 'Alt+Super+S', 'Alt+Super+G', 'Escape'])

const NAMED_KEYS: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Space: 'Space',
  Enter: 'Return',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Escape: 'Escape',
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv',
  NumpadDecimal: 'numdec'
}

/** The key's place on the keyboard rather than its letter: with Ctrl+Alt some layouts type another symbol */
function keyName(code: string): string | null {
  const letter = code.match(/^Key([A-Z])$/)
  if (letter) return letter[1]
  const digit = code.match(/^Digit(\d)$/)
  if (digit) return digit[1]
  const numpad = code.match(/^Numpad(\d)$/)
  if (numpad) return `num${numpad[1]}`
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code
  return NAMED_KEYS[code] ?? null
}

interface KeyPress {
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

/** The accelerator for a key press, or null for a modifier alone or a key shortcuts can't use */
export function acceleratorFromEvent(e: KeyPress): string | null {
  const key = keyName(e.code)
  if (!key) return null
  return [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super', key].filter(Boolean).join('+')
}

/** Why a key can't be used for an action, or null if it can */
export function hotkeyProblem(accelerator: string, action: HotkeyAction, current: Hotkeys): HotkeyProblem | null {
  if (RESERVED.has(accelerator)) return 'reserved'
  // Global shortcuts swallow the key in every app: a plain letter would stop you typing it anywhere
  if (/^(?:[A-Z0-9]|Space|Return|Tab|Backspace|Delete)$/.test(accelerator)) return 'needsModifier'
  if (HOTKEY_ACTIONS.some((other) => other !== action && current[other] === accelerator)) return 'inUse'
  return null
}

/** What was saved, with the default for anything missing or damaged */
export function normalizeHotkeys(saved: unknown): Hotkeys {
  const source = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>
  const pick = (action: HotkeyAction) => {
    const value = source[action]
    return typeof value === 'string' && value ? value : DEFAULT_HOTKEYS[action]
  }
  return { talk: pick('talk'), listen: pick('listen'), chat: pick('chat') }
}

const SYMBOLS: Record<string, string> = { Up: '↑', Down: '↓', Left: '←', Right: '→', Control: 'Ctrl', Super: macPlatform ? '⌘' : 'Win', Return: 'Enter' }

/** How a key is shown to the user */
export function formatHotkey(accelerator: string): string {
  return accelerator
    .split('+')
    .map((part) => SYMBOLS[part] ?? part.replace(/^num(\d)$/, 'Num $1'))
    .join(' + ')
}

export const GAMING_OPACITY_MIN = 0.2

export function clampGamingOpacity(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 1
  return Math.min(1, Math.max(GAMING_OPACITY_MIN, n))
}
