import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Download, X, ChevronRight, ChevronLeft, Mic, Film, Cpu, Brain, Sparkles } from 'lucide-react'
import type { SetupStatus } from '../../../preload/index.d'
import { LlmProviderForm, LlmProviderFormHandle } from '../components/LlmProviderForm'
import { MessageKey, toUiLang, translator, UI_LANGUAGES, UiLang } from '../i18n'

type StepId = 'python' | 'ffmpeg' | 'ollama' | 'model' | 'persona'

const STEP_ICONS: Record<StepId, React.ReactNode> = {
  python: <Mic size={16} />,
  ffmpeg: <Film size={16} />,
  ollama: <Cpu size={16} />,
  model: <Brain size={16} />,
  persona: <Sparkles size={16} />
}
const STEP_TEXT: Record<StepId, [MessageKey, MessageKey]> = {
  python: ['ob_pythonTitle', 'ob_pythonDesc'],
  ffmpeg: ['ob_ffmpegTitle', 'ob_ffmpegDesc'],
  ollama: ['ob_ollamaTitle', 'ob_ollamaDesc'],
  model: ['ob_modelTitle', 'ob_modelDesc'],
  persona: ['ob_personaTitle', 'ob_personaDesc']
}
const LOCAL_ORDER: StepId[] = ['python', 'ffmpeg', 'ollama', 'model', 'persona']
const CLOUD_ORDER: StepId[] = ['python', 'ffmpeg']
const PAGE_TAGS: MessageKey[] = ['ob_page1', 'ob_page2', 'ob_page3', 'ob_page4', 'ob_page5']

function isReady(step: StepId, s: SetupStatus | null): boolean {
  if (!s) return false
  switch (step) {
    case 'python':
      return s.python.envReady
    case 'ffmpeg':
      return s.ffmpeg
    case 'ollama':
      return s.ollama.installed
    case 'model':
      return s.model
    case 'persona':
      return s.persona
  }
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** Small mono tag + big condensed title used at the top of every page */
const PageHead: React.FC<{ index: number; tag: string; title: string; sub?: string }> = ({ index, tag, title, sub }) => (
  <div>
    <div className="cp-label">
      {pad(index + 1)} // {tag}
    </div>
    <h1 className="cp-title mt-2 text-[34px] text-[var(--cp-red)]">{title}</h1>
    {sub && <p className="mt-3 text-[15px] leading-snug text-[var(--cp-muted)] max-w-[480px]">{sub}</p>}
  </div>
)

export const OnboardingView: React.FC = () => {
  const initialLang = toUiLang(navigator.language)
  const [lang, setLang] = useState<UiLang>(initialLang)
  const [langChoice, setLangChoice] = useState<string>(initialLang)
  const [page, setPage] = useState(0)
  const [name, setName] = useState('')
  useEffect(() => {
    window.api.companion.getUserProfile().then((p) => {
      if (p.hasName) setName((typed) => typed || p.name)
    }).catch(() => {})
  }, [])
  const [provider, setProvider] = useState<'local' | 'cloud' | 'claude-code'>('local')
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [running, setRunning] = useState<StepId | null>(null)
  const [failed, setFailed] = useState<Set<StepId>>(new Set())
  const [log, setLog] = useState<string[]>([])
  const logRef = useRef<HTMLDivElement>(null)
  const brainRef = useRef<LlmProviderFormHandle>(null)
  const t = useMemo(() => translator(lang), [lang])
  const order = provider !== 'local' ? CLOUD_ORDER : LOCAL_ORDER

  useEffect(() => {
    window.api.setup.getStatus().then(setStatus).catch(() => {})
    return window.api.setup.onLog(({ line }) => setLog((prev) => [...prev.slice(-300), line]))
  }, [])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [log])

  const chooseLanguage = async (value: string) => {
    setLangChoice(value)
    if (value !== 'auto') setLang(toUiLang(value))
    await window.api.companion.setLanguageSettings({ textLang: value, speechLang: value === 'auto' ? 'auto' : value, micLang: value })
  }

  const saveName = async () => {
    const clean = name.trim()
    if (clean) await window.api.companion.setUserName(clean)
    setPage(2)
  }

  const saveBrain = async () => {
    if (!(await brainRef.current?.save())) return
    // In cloud mode the Ollama steps are not needed
    window.api.setup.getStatus().then(setStatus).catch(() => {})
    setPage(3)
  }

  const runStep = async (step: StepId): Promise<boolean> => {
    setRunning(step)
    setLog((prev) => [...prev, `── ${t(STEP_TEXT[step][0])} ──`])
    try {
      const res = await window.api.setup.run(step)
      setStatus(res.status)
      setFailed((prev) => {
        const next = new Set(prev)
        if (res.ok) next.delete(step)
        else next.add(step)
        return next
      })
      return res.ok
    } finally {
      setRunning(null)
    }
  }

  const installAll = async () => {
    for (const step of order) {
      if (isReady(step, status)) continue
      const ok = await runStep(step)
      // The model and persona need Ollama; stop the chain if a prerequisite failed
      if (!ok && (step === 'ollama' || step === 'model')) break
    }
  }

  const finish = async () => {
    await window.api.setup.finish()
  }

  const allReady = order.every((s) => isReady(s, status))
  const readyCount = order.filter((s) => isReady(s, status)).length
  const displayName = name.trim() || 'choom'

  return (
    <div className="cp-vars cp-root w-screen h-screen overflow-hidden flex flex-col select-none">
      {/* Top bar (window drag area) */}
      <div className="h-11 shrink-0 flex items-center justify-between px-6" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <div className="flex items-baseline gap-3">
          <span className="cp-title text-[17px] text-[var(--cp-red)]">Capri</span>
          <span className="cp-label">// setup</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="cp-label">
            {pad(page + 1)}/{pad(PAGE_TAGS.length)}
          </span>
          <div className="flex gap-1">
            {PAGE_TAGS.map((_, i) => (
              <span key={i} className={`cp-seg w-6 ${i <= page ? 'on' : ''}`} />
            ))}
          </div>
        </div>
      </div>
      <div className="cp-rule mx-6 shrink-0" />

      <div key={page} className="cp-page cp-scroll flex-1 overflow-y-auto px-8 py-7">
        {page === 0 && (
          <div className="space-y-7">
            <PageHead index={0} tag={t(PAGE_TAGS[0])} title={t('ob_hello')} sub={t('ob_helloSub')} />
            <div className="space-y-2.5">
              <div className="cp-label">{t('ob_langTitle')}</div>
              <div className="grid grid-cols-2 gap-2">
                {UI_LANGUAGES.map((l) => {
                  const active = langChoice === l.code
                  return (
                    <button
                      key={l.code}
                      onClick={() => chooseLanguage(l.code)}
                      className={`cp-frame cp-option cp-plain flex items-center justify-between pl-5 pr-4 py-2.5 text-left cursor-pointer ${active ? 'is-active' : ''}`}
                    >
                      {active && <span className="cp-marker" />}
                      <span className={`text-[16px] font-semibold tracking-[0.06em] ${active ? 'text-[var(--cp-red-hi)]' : 'text-[var(--cp-red-dim)]'}`}>{l.label}</span>
                      {active && <Check size={16} className="text-[var(--cp-cyan)]" />}
                    </button>
                  )
                })}
              </div>
              <button
                onClick={() => chooseLanguage('auto')}
                className={`cp-frame cp-option cp-plain w-full flex items-center justify-between pl-5 pr-4 py-2.5 text-left cursor-pointer ${langChoice === 'auto' ? 'is-active' : ''}`}
              >
                {langChoice === 'auto' && <span className="cp-marker" />}
                <span className={`text-[15px] font-semibold tracking-[0.04em] ${langChoice === 'auto' ? 'text-[var(--cp-red-hi)]' : 'text-[var(--cp-red-dim)]'}`}>{t('ob_auto')}</span>
                {langChoice === 'auto' && <Check size={16} className="text-[var(--cp-cyan)]" />}
              </button>
            </div>
          </div>
        )}

        {page === 1 && (
          <div className="space-y-6">
            <PageHead index={1} tag={t(PAGE_TAGS[1])} title={t('ob_nameTitle')} />
            <div className="cp-frame is-active flex items-center gap-3 px-4 py-3.5">
              <span className="cp-mono text-[var(--cp-red)] text-lg">&gt;</span>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value.slice(0, 40))}
                onKeyDown={(e) => e.key === 'Enter' && name.trim() && saveName()}
                placeholder={t('ob_namePlaceholder')}
                className="cp-input flex-1 text-[20px] font-semibold tracking-wide select-text"
              />
            </div>
            <p className="text-[14px] text-[var(--cp-muted)]">{t('ob_nameHint')}</p>
          </div>
        )}

        {page === 2 && (
          <div className="space-y-5">
            <PageHead index={2} tag={t(PAGE_TAGS[2])} title={t('ob_brainTitle')} sub={t('ob_brainSub')} />
            <LlmProviderForm ref={brainRef} onProviderChange={setProvider} />
          </div>
        )}

        {page === 3 && (
          <div className="space-y-5">
            <PageHead index={3} tag={t(PAGE_TAGS[3])} title={t('ob_setupTitle')} sub={provider !== 'local' ? t('ob_setupSubCloud') : t('ob_setupSub')} />

            <div className="flex items-center gap-3">
              <span className="cp-label shrink-0">
                {t('ob_synced')} {readyCount}/{order.length}
              </span>
              <div className="flex-1 flex gap-1">
                {order.map((step) => (
                  <span key={step} className={`cp-seg flex-1 ${isReady(step, status) ? 'ok' : running === step ? 'busy' : ''}`} />
                ))}
              </div>
            </div>

            <div className="space-y-2">
              {order.map((step, i) => {
                const ready = isReady(step, status)
                const isRunning = running === step
                const hasFailed = failed.has(step)
                const [title, desc] = STEP_TEXT[step]
                return (
                  <div key={step} className={`cp-frame overflow-hidden ${isRunning ? 'is-warn' : ''}`}>
                    <div className="flex items-center gap-3 px-4 py-2.5">
                      <span className="cp-mono text-[11px] text-[var(--cp-red-dim)] w-5">{pad(i + 1)}</span>
                      <span className={ready ? 'text-[var(--cp-cyan)]' : isRunning ? 'text-[var(--cp-yellow)]' : 'text-[var(--cp-red-dim)]'}>{STEP_ICONS[step]}</span>
                      <div className="flex-1 min-w-0">
                        <div className={`text-[15px] font-bold uppercase tracking-[0.08em] ${ready ? 'text-[var(--cp-text)]' : 'text-[var(--cp-red)]'}`}>{t(title)}</div>
                        <div className="cp-mono text-[11px] text-[var(--cp-muted)] truncate">{t(desc)}</div>
                      </div>
                      {ready ? (
                        <span className="cp-mono flex items-center gap-1.5 text-[12px] uppercase tracking-widest text-[var(--cp-cyan)]">
                          <span className="w-1.5 h-1.5 bg-[var(--cp-cyan)]" /> {t('ob_ready')}
                        </span>
                      ) : isRunning ? (
                        <span className="cp-mono flex items-center gap-1.5 text-[12px] uppercase tracking-widest text-[var(--cp-yellow)]">
                          <span className="cp-blink w-1.5 h-1.5 bg-[var(--cp-yellow)]" /> {t('ob_working')}
                        </span>
                      ) : (
                        <button
                          onClick={() => runStep(step)}
                          disabled={!!running}
                          className={`cp-frame cp-btn-ghost flex items-center gap-1.5 px-3 py-1 text-[12px] ${hasFailed ? 'is-active' : ''}`}
                          style={{ ['--c' as string]: '6px' }}
                        >
                          {hasFailed ? <X size={12} /> : <Download size={12} />} {hasFailed ? t('ob_retry') : t('ob_install')}
                        </button>
                      )}
                    </div>
                    {isRunning && <div className="cp-busy-bar" />}
                  </div>
                )
              })}
            </div>

            {!allReady && (
              <button onClick={installAll} disabled={!!running} className="cp-btn w-full py-3 text-[15px]">
                {running ? `${t('ob_working')}...` : t('ob_installAll')}
              </button>
            )}

            {log.length > 0 && (
              <div className="cp-frame" style={{ ['--fill' as string]: '#070405' }}>
                <div ref={logRef} className="cp-scroll cp-mono h-32 overflow-y-auto p-3 text-[10.5px] leading-snug text-[var(--cp-red-dim)] select-text">
                  {log.map((l, i) => (
                    <div key={i} className={l.startsWith('──') ? 'text-[var(--cp-yellow)] mt-1 uppercase tracking-wider' : ''}>
                      {l}
                    </div>
                  ))}
                  {running && <span className="cp-blink">_</span>}
                </div>
              </div>
            )}
          </div>
        )}

        {page === 4 && (
          <div className="space-y-6">
            <PageHead index={4} tag={t(PAGE_TAGS[4])} title={t('ob_doneTitle', { name: displayName })} sub={t('ob_doneSub')} />
            {!allReady && <div className="cp-frame is-warn px-4 py-3 text-[14px] leading-snug text-[var(--cp-yellow)]">{t('ob_missing')}</div>}
          </div>
        )}
      </div>

      <div className="cp-rule mx-6 shrink-0" />
      <div className="h-[68px] shrink-0 px-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button onClick={() => setPage(Math.max(0, page - 1))} className={`cp-btn-ghost flex items-center gap-1 text-[13px] ${page === 0 ? 'invisible' : ''}`}>
            <ChevronLeft size={15} /> {t('back')}
          </button>
          <span className="cp-label flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 bg-[var(--cp-cyan)]" /> {t('ob_status')}
          </span>
        </div>
        {page === 0 && (
          <button
            onClick={async () => {
              await chooseLanguage(langChoice)
              setPage(1)
            }}
            className="cp-btn flex items-center gap-1 px-6 py-2.5 text-[14px]"
          >
            {t('next')} <ChevronRight size={16} />
          </button>
        )}
        {page === 1 && (
          <button onClick={saveName} disabled={!name.trim()} className="cp-btn flex items-center gap-1 px-6 py-2.5 text-[14px]">
            {t('next')} <ChevronRight size={16} />
          </button>
        )}
        {page === 2 && (
          <button onClick={saveBrain} className="cp-btn flex items-center gap-1 px-6 py-2.5 text-[14px]">
            {t('next')} <ChevronRight size={16} />
          </button>
        )}
        {page === 3 &&
          (allReady ? (
            <button onClick={() => setPage(4)} disabled={!!running} className="cp-btn flex items-center gap-1 px-6 py-2.5 text-[14px]">
              {t('next')} <ChevronRight size={16} />
            </button>
          ) : (
            <button onClick={() => setPage(4)} disabled={!!running} className="cp-frame cp-btn-ghost flex items-center gap-1 px-5 py-2.5 text-[14px]">
              {t('ob_skip')} <ChevronRight size={16} />
            </button>
          ))}
        {page === 4 && (
          <button onClick={finish} className="cp-btn px-8 py-2.5 text-[15px]">
            {t('ob_finish')}
          </button>
        )}
      </div>
    </div>
  )
}
