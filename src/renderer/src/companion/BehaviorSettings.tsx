import React, { useEffect, useState } from 'react'
import { Monitor } from 'lucide-react'
import { useT } from '../utils/useUiLang'
import { GAMING_OPACITY_MIN } from '../../../shared/hotkeys'

interface DisplayInfo {
  id: number
  label: string
  width: number
  height: number
  primary: boolean
  current: boolean
}

/** Which monitor she lives on, and whether she may do things on her own when she's bored */
export const BehaviorSettings: React.FC = () => {
  const t = useT()
  const [displays, setDisplays] = useState<DisplayInfo[]>([])
  const [boredom, setBoredom] = useState(true)
  const [gamingOpacity, setGamingOpacity] = useState(1)

  const load = () => window.api.companion.listDisplays().then(setDisplays).catch(() => {})

  useEffect(() => {
    void load()
    window.api.boredom.getEnabled().then(setBoredom).catch(() => {})
    window.api.companion.getGamingOpacity().then(setGamingOpacity).catch(() => {})
  }, [])

  const current = displays.find((d) => d.current)

  return (
    <div className="p-3 bg-black/60 border border-stone-800 space-y-3">
      <label className="block text-[13px] text-stone-300">
        <span className="font-semibold text-[14px] flex items-center gap-1.5 mb-1.5">
          <Monitor size={14} className="text-cp-400" /> {t('vs_monitor')}
        </span>
        <select
          value={current?.id ?? ''}
          disabled={displays.length < 2}
          onChange={(e) => {
            void window.api.companion.moveToDisplay(Number(e.target.value)).then(load)
          }}
          className="w-full bg-black border border-stone-700 text-stone-200 px-2 py-1.5 text-[13px] disabled:opacity-60"
        >
          {displays.map((d, i) => (
            <option key={d.id} value={d.id}>
              {i + 1}. {d.label || t('vs_monitor')} ({d.width}x{d.height}){d.primary ? ` - ${t('vs_monitorMain')}` : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-[13px] text-stone-300 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={boredom}
          onChange={(e) => {
            setBoredom(e.target.checked)
            void window.api.boredom.setEnabled(e.target.checked)
          }}
        />
        {/Mac/i.test(navigator.platform) ? 'Allow Capri to open music/tabs when bored (off by default)' : t('vs_boredom')}
      </label>
      <label className="block text-[13px] text-stone-300">
        <span className="flex justify-between mb-1">
          <span>{t('vs_gamingOpacity')}</span>
          <span className="text-stone-400">{Math.round(gamingOpacity * 100)}%</span>
        </span>
        <input
          type="range"
          min={GAMING_OPACITY_MIN * 100}
          max="100"
          step="5"
          value={Math.round(gamingOpacity * 100)}
          onChange={(e) => {
            const value = parseInt(e.target.value, 10) / 100
            setGamingOpacity(value)
            void window.api.companion.setGamingOpacity(value)
          }}
          className="w-full"
        />
      </label>
    </div>
  )
}
