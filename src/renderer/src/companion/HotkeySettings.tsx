import React, { useEffect, useState } from 'react'
import { Keyboard } from 'lucide-react'
import { useT } from '../utils/useUiLang'
import { acceleratorFromEvent, DEFAULT_HOTKEYS, formatHotkey, HOTKEY_ACTIONS, type HotkeyAction, type HotkeyProblem, type Hotkeys } from '../../../shared/hotkeys'

const ACTION_LABEL = { talk: 'vs_hotkeyTalk', listen: 'vs_hotkeyListen', chat: 'vs_hotkeyChat' } as const
const PROBLEM_TEXT = { needsModifier: 'vs_hotkeyNeedsModifier', reserved: 'vs_hotkeyReserved', inUse: 'vs_hotkeyInUse', taken: 'vs_hotkeyTaken' } as const

/** Which keys do what, chosen by pressing them, and whether they also work over other apps */
export const HotkeySettings: React.FC = () => {
  const t = useT()
  const isMac=/Mac/i.test(navigator.platform)
  const [hotkeys, setHotkeys] = useState<Hotkeys>(DEFAULT_HOTKEYS)
  const [enabled, setEnabled] = useState(true)
  const [choosing, setChoosing] = useState<HotkeyAction | null>(null)
  const [problem, setProblem] = useState<HotkeyProblem | null>(null)

  useEffect(() => {
    window.api.voice.getHotkeys().then(setHotkeys).catch(() => {})
    window.api.voice.getArrowKeys().then(setEnabled).catch(() => {})
  }, [])

  useEffect(() => {
    if (!choosing) return
    const onKey = (e: KeyboardEvent) => {
      // First in line, so the key being chosen doesn't also do what it does now
      e.preventDefault()
      e.stopPropagation()
      if (e.code === 'Escape') {
        setChoosing(null)
        return
      }
      const accelerator = acceleratorFromEvent(e)
      if (!accelerator) return // a modifier on its own: still pressing the combination
      setChoosing(null)
      void window.api.voice.setHotkey(choosing, accelerator).then((result) => {
        setHotkeys(result.hotkeys)
        setProblem(result.problem)
      })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [choosing])

  return (
    <div className="p-3 bg-black/60 border border-stone-800 space-y-2">
      <span className="text-stone-300 font-semibold text-[14px] flex items-center gap-1.5">
        <Keyboard size={14} className="text-cp-400" /> {t('vs_hotkeys')}
      </span>
      {HOTKEY_ACTIONS.map((action) => (
        <div key={action} className="flex items-center justify-between gap-2 text-[13px] text-stone-300">
          <span>{t(ACTION_LABEL[action])}</span>
          <button
            type="button"
            onClick={() => {
              setProblem(null)
              setChoosing(choosing === action ? null : action)
            }}
            className={`min-w-[130px] px-3 py-1 border text-[13px] ${choosing === action ? 'border-cp-400 text-cp-400' : 'border-stone-700 text-stone-200 hover:border-stone-500'}`}
          >
            {choosing === action ? t('vs_hotkeyPress') : formatHotkey(hotkeys[action])}
          </button>
        </div>
      ))}
      {problem && <p className="text-[13px] text-amber-400">{isMac && problem==='reserved' ? 'That key is reserved by Capri. Choose another combination.' : t(PROBLEM_TEXT[problem])}</p>}
      <label className="flex items-center gap-2 text-[13px] text-stone-300 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.target.checked)
            void window.api.voice.setArrowKeys(e.target.checked)
          }}
        />
        {isMac ? 'Use these shortcuts in other apps (⌘⌥V always works)' : t('vs_arrowKeys')}
      </label>
      <button
        type="button"
        onClick={() => {
          setProblem(null)
          setChoosing(null)
          void window.api.voice.resetHotkeys().then(setHotkeys)
        }}
        className="px-3 py-1 border border-stone-700 text-stone-200 text-[13px] hover:border-stone-500"
      >
        {isMac ? 'Reset Mac shortcuts' : t('vs_hotkeyReset')}
      </button>
    </div>
  )
}
