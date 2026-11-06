import { de } from './de'
import { en, MessageKey, Messages } from './en'
import { es } from './es'
import { fr } from './fr'
import { it } from './it'
import { ja } from './ja'
import { ko } from './ko'
import { pt } from './pt'
import { ru } from './ru'
import { zh } from './zh'

export const UI_LANGUAGES = [
  { code: 'es', label: 'Español' },
  { code: 'en', label: 'English' },
  { code: 'pt', label: 'Português' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'it', label: 'Italiano' },
  { code: 'ru', label: 'Русский' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'zh', label: '中文' }
] as const

export type UiLang = (typeof UI_LANGUAGES)[number]['code']
export type { MessageKey }

const CATALOG: Record<UiLang, Messages> = { es, en, pt, fr, de, it, ru, ja, ko, zh }

/** The interface language for any language code ('pt-BR' -> 'pt'), English when there is no translation */
export function toUiLang(lang: string | null | undefined): UiLang {
  const code = String(lang || '').toLowerCase().slice(0, 2)
  return (code in CATALOG ? code : 'en') as UiLang
}

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string

export function translator(lang: UiLang): Translate {
  const messages = CATALOG[lang]
  return (key, vars) => {
    const text = messages[key] ?? en[key]
    return vars ? text.replace(/\{(\w+)\}/g, (all, name) => (name in vars ? String(vars[name]) : all)) : text
  }
}
