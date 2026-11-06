import { homedir } from 'os'
import { isMac, isWindows } from '../services/platform'
import { llmFetch } from '../services/llm-gateway'
import { llmBody } from '../services/user-profile'
/**
 * Coding agent for "build me X" requests: plan, write files, verify, fix, repeat.
 * Files use a plain-text block protocol instead of JSON tool calls, which small local
 * models handle much better for long file contents:
 *
 *   <<<FILE index.html>>>
 *   ...content...
 *   <<<END FILE>>>
 */

import * as fs from 'fs'
import * as path from 'path'
import { exec } from '../services/hidden-process'
import { queueResult } from '../services/pending-result'

export type CodingLang = 'es' | 'en'

export interface CodingAgentHooks {
  /** Short spoken/visible line from Capri */
  say: (text: string) => void
  /** Progress events for the UI (tool.started / tool.finished) */
  toolStarted: (name: string, input: Record<string, unknown>) => void
  toolFinished: (name: string, output: string, success: boolean) => void
  isCancelled: () => boolean
}

export interface CodingAgentOptions {
  endpoint: string
  requestedModel?: string
  lang: CodingLang
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

const MAX_STEPS = 18
/** Steps in a row without any progress before the agent wraps up with what it has */
const MAX_STALLED_STEPS = 3
/** Files a text-only model can't produce; missing ones are replaced at the end instead of blocking */
const BINARY_EXT = /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svgz|mp3|wav|ogg|mp4|webm|mov|woff2?|ttf|otf|eot|pdf|zip)$/i
const FILE_BLOCK = /<<<FILE\s+([^>\r\n]+?)\s*>>>\r?\n([\s\S]*?)<<<END FILE>>>/g
const RUN_BLOCK = /<<<RUN>>>\s*([\s\S]*?)\s*<<<END RUN>>>/g
const READ_BLOCK = /<<<READ\s+([^>\r\n]+?)\s*>>>/g
const PLAN_BLOCK = /<<<PLAN(?:\s+folder="([^"]+)")?\s*>>>([\s\S]*?)<<<END PLAN>>>/
const DONE_BLOCK = /<<<DONE>>>([\s\S]*?)(?:<<<END DONE>>>|$)/

const DANGEROUS_CMD =
  /\b(?:format|shutdown|restart-computer|stop-computer|diskpart|bcdedit|reg\s+delete|rmdir\s+\/s|rd\s+\/s|del\s+\/[sq]|remove-item[^|;&]*-recurse|rm\s+-rf?\s+[\/~]|cipher\s+\/w|takeown|icacls)\b/i

/** Does this request ask Capri to build/code something (vs. chat or a single text file)? */
export function isCodingRequest(text: string): boolean {
  const t = text.toLowerCase()
  const verb =
    /\b(?:hac[eé]me|hac[eé]|hace|haceme|cre[aá]me|cre[aá]|crear|arm[aá]me|arm[aá]|armar|program[aá](?:me)?|code[aá](?:me)?|desarroll[aá](?:me)?|constru[ií](?:me)?|gener[aá](?:me)?|make|build|create|code|develop|generate|write)\b/
  const thing =
    /\b(?:landing(?:\s*page)?|p[aá]gina\s+web|p[aá]gina|sitio(?:\s+web)?|web\s*(?:site|app|page)?|website|app|aplicaci[oó]n|juego|game|script|programa|proyecto|project|portfolio|portafolio|dashboard|calculadora|calculator|to-?do|formulario|form|bot|api|html|css|javascript|typescript|react|node|python)\b/
  return verb.test(t) && thing.test(t)
}

export class CodingAgent {
  private projectRoot = ''
  private plannedFiles: string[] = []
  private writtenFiles = new Set<string>()

  constructor(private opts: CodingAgentOptions, private hooks: CodingAgentHooks) {}

  private es(): boolean {
    return this.opts.lang === 'es'
  }

  public async run(request: string): Promise<void> {
    const base = this.ollamaBase()
    const model = await this.resolveCoderModel(base)
    if (!model) {
      this.hooks.say(
        this.es()
          ? '[worried] No encuentro ningún modelo local en Ollama para programar, choomba. Bajate uno tipo qwen2.5-coder y volvemos a intentar.'
          : "[worried] I can't find any local Ollama model to code with, choomba. Pull something like qwen2.5-coder and let's try again."
      )
      return
    }

    const desktop = path.join(process.env.USERPROFILE || (isWindows ? 'C:\\Users\\Public' : homedir()), 'Desktop')
    this.hooks.say(
      this.es()
        ? `[excited] ¡Dale, me pongo a codear! [playful] Primero armo el plan y después escribo los archivos, puede tardar un par de minutos.`
        : `[excited] On it, choom! [playful] Planning first, then writing the files. Might take a couple of minutes.`
    )

    const messages: ChatMessage[] = [
      { role: 'system', content: this.systemPrompt(desktop) },
      { role: 'user', content: `REQUEST FROM {name}:\n${request}\n\nStart with the <<<PLAN>>> block, then write the first files.` }
    ]

    let finishedSummary: string | null = null
    let lastStateKey = ''
    let stalled = 0

    for (let step = 1; step <= MAX_STEPS; step++) {
      if (this.hooks.isCancelled()) return

      const reply = await this.chat(base, model, messages)
      if (reply === null) {
        this.hooks.say(
          this.es()
            ? '[worried] Se me cortó la conexión con el modelo local en medio del laburo. Lo que alcancé a escribir quedó guardado.'
            : '[worried] Lost the connection to the local model mid-job. Whatever I already wrote is saved.'
        )
        break
      }

      const feedback: string[] = []

      // Plan (sets the project folder once)
      const plan = reply.match(PLAN_BLOCK)
      if (plan && !this.projectRoot) {
        const folder = sanitizeFolder(plan[1] || this.slugFrom(request))
        this.projectRoot = uniqueDir(path.join(desktop, folder))
        fs.mkdirSync(this.projectRoot, { recursive: true })
        this.plannedFiles = Array.from(plan[2].matchAll(/^\s*[-*]\s*([^\s:]+\.[a-z0-9]+)/gim)).map((m) => normalizeRel(m[1]))
          .filter((f) => !BINARY_EXT.test(f))
        this.hooks.toolStarted('plan', { folder: this.projectRoot, files: this.plannedFiles })
        this.hooks.toolFinished('plan', `Project folder: ${this.projectRoot}\nFiles: ${this.plannedFiles.join(', ')}`, true)
        feedback.push(`Plan accepted. Project folder: ${this.projectRoot}`)
      }
      if (!this.projectRoot) {
        this.projectRoot = uniqueDir(path.join(desktop, sanitizeFolder(this.slugFrom(request))))
        fs.mkdirSync(this.projectRoot, { recursive: true })
      }

      // Files
      for (const m of reply.matchAll(FILE_BLOCK)) {
        feedback.push(this.writeFile(m[1], m[2]))
      }
      // A file that was opened but never closed = output got cut off by the token limit
      const lastOpen = reply.lastIndexOf('<<<FILE')
      if (lastOpen !== -1 && reply.indexOf('<<<END FILE>>>', lastOpen) === -1) {
        const cut = reply.slice(lastOpen).match(/<<<FILE\s+([^>\r\n]+?)\s*>>>/)
        feedback.push(
          `ERROR: the file ${cut ? cut[1] : '(unknown)'} was cut off before <<<END FILE>>> (output too long). Rewrite that file completely, keeping it more compact if needed.`
        )
      }

      // Reads
      for (const m of reply.matchAll(READ_BLOCK)) {
        feedback.push(this.readFile(m[1]))
      }

      // Commands
      for (const m of reply.matchAll(RUN_BLOCK)) {
        feedback.push(await this.runCommand(m[1]))
      }

      // Verification after every step
      const problems = await this.verify()
      const missing = this.plannedFiles.filter((f) => !this.writtenFiles.has(f))
      const done = reply.match(DONE_BLOCK)

      if (done && problems.length === 0 && missing.length === 0) {
        finishedSummary = done[1].trim()
        break
      }

      // Same problems and no new files for several replies in a row: the model is stuck
      // on something it can't fix, so stop burning minutes and deliver what is there
      const stateKey = `${problems.join('|')}#${missing.join('|')}#${this.writtenFiles.size}#${fileCountIn(reply)}`
      stalled = stateKey === lastStateKey ? stalled + 1 : 0
      lastStateKey = stateKey
      if (stalled >= MAX_STALLED_STEPS - 1) {
        console.warn(`[CodingAgent] no progress for ${MAX_STALLED_STEPS} steps, wrapping up. Problems: ${problems.join('; ')}`)
        break
      }

      if (problems.length) feedback.push(`VERIFICATION PROBLEMS (fix them):\n- ${problems.join('\n- ')}`)
      // History only keeps notes for written files, so show the broken ones again or the model can't fix them
      for (const rel of this.writtenFiles) {
        if (problems.some((p) => p.startsWith(`${rel} `) && /syntax error|unbalanced braces|incomplete/.test(p))) {
          feedback.push(this.numberedContent(rel))
        }
      }
      if (missing.length) feedback.push(`Planned files not written yet: ${missing.join(', ')}. Write them now.`)
      if (done && (problems.length || missing.length)) feedback.push('You said DONE but the project is not finished yet.')
      if (!feedback.length) {
        feedback.push(
          'No blocks detected in your reply. Use the <<<FILE path>>> ... <<<END FILE>>> format to write files, or <<<DONE>>> when everything is finished and verified.'
        )
      }

      // Keep context small: replace written file bodies in history with a short note
      messages.push({ role: 'assistant', content: compactReply(reply) })
      messages.push({ role: 'user', content: `RESULTS:\n${feedback.join('\n')}\n\nContinue.` })
    }

    if (this.hooks.isCancelled()) return
    this.finish(finishedSummary)
  }

  private systemPrompt(desktop: string): string {
    const language = this.es() ? 'Spanish (Rioplatense, natural)' : 'English'
    return [
      `You are an expert senior software engineer working autonomously on the user's ${isWindows ? 'Windows' : isMac ? 'macOS' : 'Linux'} PC.`,
      'You build complete, working, good-looking projects end to end. No placeholders, no "TODO", no lorem ipsum unless asked: write real, polished content.',
      `The project will be created in a new folder on the Desktop (${desktop}). All file paths you write are RELATIVE to that project folder.`,
      'Default stack for web pages: plain HTML + CSS + vanilla JavaScript, no build step, no npm, no external CDNs unless clearly useful (Google Fonts is fine).',
      'QUALITY BAR for websites/landings: it must look like a real professional product page, not a tutorial. At least 5 sections (e.g. hero with strong headline + call to action, features/services, showcase/menu/pricing, testimonials, contact/form, footer).',
      'CSS: use CSS variables, a cohesive color palette, gradients/glows, nice typography, hover/transition animations, cards with depth, and a mobile layout with media queries (usually 200+ lines).',
      'JavaScript (script.js, always included for websites): real interactivity such as a mobile nav toggle, smooth scroll, scroll-reveal animations, and form validation with a success message.',
      `All visible text on the page must be in ${language}, the user's language, with real, specific copy about the user's topic.`,
      '',
      "WHO IS WHO: the request is written by the user TO Capri, their AI companion. Capri (Project Capricorn) is a playful, fiercely loyal netrunner AI from Night City (Cyberpunk universe) who lives in the user's PC, loves hacking, gaming and neon lights, and talks like a confident choomba.",
      '- "you", "yourself", "vos", "ti", "sobre vos", "sobre ti", "about you" = Capri. A page "about you" is a page ABOUT CAPRI (her personality, powers, style), not about the user.',
      '- "me", "mí", "yo", "sobre mí", "about me", "my" = the user who wrote the request.',
      '',
      'You communicate ONLY with these blocks:',
      '1) Once, at the start:',
      '<<<PLAN folder="short-kebab-case-folder-name">>>',
      '- index.html: what it contains',
      '- styles.css: what it contains',
      '<<<END PLAN>>>',
      '2) To create or fully rewrite a file (always the COMPLETE file, never a diff):',
      '<<<FILE relative/path.ext>>>',
      'full file content',
      '<<<END FILE>>>',
      '3) To read a file you already wrote: <<<READ relative/path.ext>>>',
      `4) To run a shell command inside the project folder (${isWindows ? 'cmd.exe' : 'sh'}): <<<RUN>>>command<<<END RUN>>>`,
      '5) When every planned file is written and verified:',
      `<<<DONE>>>one short sentence in ${language} describing what you built<<<END DONE>>>`,
      '',
      'You can only create TEXT files. Never plan or reference local images, audio or fonts (.jpg, .png, .mp3, .woff...): for visuals use inline <svg> illustrations, CSS gradients/shapes or emoji.',
      'Never write placeholder text such as "[200 lines written]" or "...": every FILE block must contain the real, complete file. Notes like that in the history only mean the file is already saved on disk.',
      'Rules: write at most 2 files per reply so nothing gets cut off. Do not wrap file content in markdown fences. Keep any prose outside blocks to one short line. After each reply you will receive RESULTS with verification problems; fix them before saying DONE.'
    ].join('\n')
  }

  private writeFile(rawPath: string, rawContent: string): string {
    const rel = normalizeRel(rawPath)
    const target = this.safePath(rel)
    if (!target) return `ERROR: refused to write outside the project folder: ${rawPath}`
    const content = stripFences(rawContent)
    if (BINARY_EXT.test(rel)) {
      return `ERROR: ${rel} was NOT written: you can't create binary files (images, audio, fonts). Use inline <svg>, CSS gradients/shapes or emoji instead, and don't reference local image files.`
    }
    if (isPlaceholder(content)) {
      return `ERROR: ${rel} was NOT written: its content was a placeholder ("${content.trim().slice(0, 40)}"), not the real file. Write the COMPLETE content of ${rel}.`
    }
    this.hooks.toolStarted('write_file', { path: target })
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, content, 'utf-8')
      this.writtenFiles.add(rel)
      const lines = content.split('\n').length
      this.hooks.toolFinished('write_file', `${target} (${lines} lines)`, true)
      return `Wrote ${rel} (${lines} lines).`
    } catch (err: any) {
      this.hooks.toolFinished('write_file', String(err?.message || err), false)
      return `ERROR writing ${rel}: ${err?.message || err}`
    }
  }

  private readFile(rawPath: string): string {
    const rel = normalizeRel(rawPath)
    const target = this.safePath(rel)
    if (!target || !fs.existsSync(target)) return `ERROR: ${rel} does not exist.`
    const content = fs.readFileSync(target, 'utf-8')
    return `CONTENT OF ${rel}:\n${content.length > 12000 ? content.slice(0, 12000) + '\n...(truncated)' : content}`
  }

  private numberedContent(rel: string): string {
    const abs = this.safePath(rel)
    if (!abs || !fs.existsSync(abs)) return ''
    const numbered = fs
      .readFileSync(abs, 'utf-8')
      .split('\n')
      .map((l, i) => `${String(i + 1).padStart(4)}| ${l}`)
      .join('\n')
    const body = numbered.length > 10000 ? numbered.slice(0, 10000) + '\n...(truncated)' : numbered
    return `CURRENT CONTENT OF ${rel} (line numbers are NOT part of the file; rewrite the whole file fixed, without them):\n${body}`
  }

  private runCommand(cmd: string): Promise<string> {
    const command = cmd.trim()
    if (!command) return Promise.resolve('ERROR: empty command.')
    if (DANGEROUS_CMD.test(command)) return Promise.resolve(`ERROR: command refused for safety: ${command}`)
    this.hooks.toolStarted('run_command', { command, cwd: this.projectRoot })
    return new Promise((resolve) => {
      exec(command, { cwd: this.projectRoot, timeout: 180_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        const out = `${stdout || ''}${stderr ? `\n${stderr}` : ''}`.trim().slice(-4000)
        this.hooks.toolFinished('run_command', out || (err ? String(err.message) : 'ok'), !err)
        resolve(`$ ${command}\n${err ? `EXIT CODE ${err.code ?? 1}\n` : ''}${out || '(no output)'}`)
      })
    })
  }

  /** Cheap but effective checks: broken local references in HTML, JS syntax errors. */
  private async verify(): Promise<string[]> {
    const problems: string[] = []
    if (!this.projectRoot) return problems
    for (const rel of this.writtenFiles) {
      const abs = path.join(this.projectRoot, rel)
      if (!fs.existsSync(abs)) continue
      const ext = path.extname(rel).toLowerCase()
      const content = fs.readFileSync(abs, 'utf-8')

      if (ext === '.html' || ext === '.htm') {
        const refs = Array.from(content.matchAll(/\b(?:src|href)\s*=\s*["']([^"'#?]+)[^"']*["']/gi)).map((m) => m[1].trim())
        for (const ref of refs) {
          if (!ref || /^(?:[a-z]+:|\/\/|\{|\$)/i.test(ref)) continue // http:, mailto:, data:, templating
          const refAbs = path.resolve(path.dirname(abs), ref)
          if (!fs.existsSync(refAbs)) {
            if (BINARY_EXT.test(ref)) continue // replaced with an SVG illustration in finish()
            const planned = this.plannedFiles.includes(normalizeRel(path.relative(this.projectRoot, refAbs)))
            if (!planned) problems.push(`${rel} references "${ref}" but that file does not exist`)
          }
        }
        if (!/<\/html>\s*$/i.test(content.trim())) problems.push(`${rel} looks incomplete (no closing </html>)`)
        const hasCss = [...this.plannedFiles, ...this.writtenFiles].some((f) => f.endsWith('.css'))
        if (hasCss && !/<link[^>]+rel\s*=\s*["']stylesheet["']/i.test(content) && !/<style[\s>]/i.test(content)) {
          problems.push(`${rel} does not link its stylesheet (<link rel="stylesheet" href="styles.css">)`)
        }
      }

      // A file that exists but is nearly empty usually means the model skipped writing it
      const realLines = content.split('\n').filter((l) => l.trim()).length
      if (ext === '.css' && (realLines < 40 || !content.includes('{'))) {
        problems.push(
          `${rel} is almost empty (${realLines} lines). Write the full stylesheet: variables, layout, typography, every section, hover effects and media queries.`
        )
      }
      if ((ext === '.js' || ext === '.mjs') && realLines < 8) {
        problems.push(`${rel} is almost empty (${realLines} lines). Write the real interactivity code.`)
      }

      if (ext === '.js' || ext === '.mjs') {
        const err = await nodeCheck(abs)
        if (err) problems.push(`${rel} has a JavaScript syntax error: ${err}`)
      }

      if (ext === '.css') {
        const open = (content.match(/\{/g) || []).length
        const close = (content.match(/\}/g) || []).length
        if (open !== close) problems.push(`${rel} has unbalanced braces ({ ${open} vs } ${close})`)
      }
    }
    return problems
  }

  /** Points every reference to a missing image (HTML src, CSS url()) at a generated neon SVG */
  private patchMissingImages(): void {
    for (const rel of this.writtenFiles) {
      const ext = path.extname(rel).toLowerCase()
      if (!['.html', '.htm', '.css'].includes(ext)) continue
      const abs = path.join(this.projectRoot, rel)
      if (!fs.existsSync(abs)) continue
      const content = fs.readFileSync(abs, 'utf-8')
      const missing = (ref: string) =>
        BINARY_EXT.test(ref) && !/^(?:[a-z]+:|\/\/)/i.test(ref) && !fs.existsSync(path.resolve(path.dirname(abs), ref.split(/[?#]/)[0]))
      const patched = content
        .replace(/(\bsrc\s*=\s*)(["'])([^"']+)\2/gi, (m, attr: string, q: string, ref: string) =>
          missing(ref) ? `${attr}${q}${placeholderSvg(ref)}${q}` : m
        )
        .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, _q: string, ref: string) => (missing(ref) ? `url("${placeholderSvg(ref)}")` : m))
      if (patched !== content) {
        fs.writeFileSync(abs, patched, 'utf-8')
        console.log(`[CodingAgent] replaced missing images in ${rel} with SVG illustrations`)
      }
    }
  }

  private finish(summary: string | null): void {
    if (this.projectRoot) this.patchMissingImages()
    const files = Array.from(this.writtenFiles)
    if (files.length === 0) {
      this.hooks.say(
        this.es()
          ? '[sad] No llegué a escribir ningún archivo, choomba. Probá pedírmelo con un poco más de detalle.'
          : "[sad] I didn't manage to write any files, choomba. Try asking with a bit more detail."
      )
      return
    }

    const entry = ['index.html', 'index.htm'].find((f) => this.writtenFiles.has(f)) || files.find((f) => /\.html?$/i.test(f))
    // Opened by the agent manager only after Capri has told the user, so the browser
    // doesn't cover the window she's about to comment on
    queueResult(entry ? path.join(this.projectRoot, entry) : this.projectRoot)

    const folderName = path.basename(this.projectRoot)
    const what = summary ? ` ${summary}` : ''
    this.hooks.say(
      this.es()
        ? `[proud] ¡Listo, choomba! Te dejé el proyecto "${folderName}" en el escritorio con ${files.length} archivo${files.length === 1 ? '' : 's'}.${what} ${entry ? '[excited] Ahora te lo abro en el navegador.' : ''}`.trim()
        : `[proud] Done, choomba! Project "${folderName}" is on your desktop. Files: ${files.length}.${what} ${entry ? '[excited] Opening it in your browser now.' : ''}`.trim()
    )
  }

  private safePath(rel: string): string | null {
    if (!rel || path.isAbsolute(rel)) return null
    const abs = path.resolve(this.projectRoot, rel)
    const root = path.resolve(this.projectRoot) + path.sep
    return abs.startsWith(root) ? abs : null
  }

  private slugFrom(request: string): string {
    const words = request
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3 && !/^(hace|haceme|crea|creame|arma|armame|make|build|create|para|with|using|usando|escritorio|desktop|quiero|necesito|please|porfa)$/.test(w))
      .slice(0, 3)
    return words.join('-') || 'capri-project'
  }

  private ollamaBase(): string {
    return (this.opts.endpoint || 'http://localhost:11434/v1').replace(/\/+$/, '').replace(/\/v1$/, '')
  }

  /** Coding needs the strongest coder model available, not the chatty persona model. */
  private async resolveCoderModel(base: string): Promise<string | null> {
    try {
      const res = await llmFetch(`${base}/api/tags`)
      if (!res.ok) return null
      const data = (await res.json()) as { models?: { name: string }[] }
      const names = (data.models || []).map((m) => m.name).filter((n) => !/llava|vision|-vl\b/i.test(n))
      if (names.length === 0) return null

      const req = (this.opts.requestedModel || '').trim()
      if (req && !/^capri/i.test(req)) {
        const exact = names.find((n) => n === req || n.startsWith(req + ':'))
        if (exact) return exact
      }
      const size = (n: string) => Number((n.match(/(\d+(?:\.\d+)?)b\b/i) || [])[1] || 0)
      const coders = names.filter((n) => /coder|code|deepseek|starcoder|codellama/i.test(n)).sort((a, b) => size(b) - size(a))
      return coders[0] || names.find((n) => !/^capri/i.test(n)) || names[0]
    } catch {
      return null
    }
  }

  /** Streams from Ollama (no 5-minute header timeout on long generations) and returns the full text. */
  private async chat(base: string, model: string, messages: ChatMessage[]): Promise<string | null> {
    const ctrl = new AbortController()
    const cancelPoll = setInterval(() => {
      if (this.hooks.isCancelled()) ctrl.abort()
    }, 500)
    try {
      const res = await llmFetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: llmBody({
          model,
          messages,
          stream: true,
          keep_alive: '20m',
          options: { num_ctx: 16384, num_predict: 6144, temperature: 0.35, top_p: 0.9 }
        })
      })
      if (!res.ok || !res.body) return null

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let text = ''
      let announced = 0
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const j = JSON.parse(line)
            if (j.message?.content) text += j.message.content
          } catch {}
        }
        // Live progress: announce each file as soon as the model starts writing it
        const headers = Array.from(text.matchAll(/<<<FILE\s+([^>\r\n]+?)\s*>>>/g))
        while (announced < headers.length) {
          this.hooks.toolStarted('writing', { path: headers[announced][1] })
          announced++
        }
      }
      console.log(`[CodingAgent] ${model} replied with ${text.length} chars`)
      return text
    } catch (err: any) {
      if (!this.hooks.isCancelled()) console.warn('[CodingAgent] LLM request failed:', err?.message || err)
      return null
    } finally {
      clearInterval(cancelPoll)
    }
  }
}

function normalizeRel(p: string): string {
  return p.trim().replace(/^["'`]+|["'`]+$/g, '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

function sanitizeFolder(name: string): string {
  const clean = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return clean || 'capri-project'
}

function uniqueDir(dir: string): string {
  if (!fs.existsSync(dir)) return dir
  for (let i = 2; i < 100; i++) {
    const candidate = `${dir}-${i}`
    if (!fs.existsSync(candidate)) return candidate
  }
  return `${dir}-${Date.now()}`
}

function stripFences(content: string): string {
  let c = content.replace(/^\s*\r?\n/, '')
  const fence = c.match(/^\s*```[a-zA-Z0-9]*\s*\r?\n([\s\S]*?)\r?\n```\s*$/)
  if (fence) c = fence[1]
  return c.replace(/\s+$/, '') + '\n'
}

/** Drops written file bodies from history. The note stays OUTSIDE the FILE syntax so the model can't copy it as content. */
function compactReply(reply: string): string {
  return reply.replace(
    FILE_BLOCK,
    (_m, p: string, body: string) => `(saved ${p.trim()} to disk, ${body.split('\n').length} lines; content omitted from history)`
  )
}

function fileCountIn(reply: string): number {
  return (reply.match(/<<<FILE\s/g) || []).length
}

/** Neon gradient SVG (as a data URI) standing in for an image the model couldn't create */
function placeholderSvg(ref: string): string {
  const label = path
    .basename(ref, path.extname(ref))
    .replace(/[-_]+/g, ' ')
    .replace(/[^a-z0-9 ]/gi, '')
    .trim()
    .slice(0, 28)
  let h = 0
  for (const ch of ref) h = (h * 31 + ch.charCodeAt(0)) % 360
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="hsl(${h},90%,55%)"/><stop offset="1" stop-color="hsl(${(h + 70) % 360},85%,35%)"/>` +
    `</linearGradient></defs><rect width="800" height="500" fill="#0b0b14"/>` +
    `<rect x="12" y="12" width="776" height="476" rx="24" fill="url(#g)" opacity="0.85"/>` +
    `<g stroke="#ffffff" stroke-opacity="0.12">${Array.from({ length: 9 }, (_, i) => `<line x1="0" y1="${i * 60}" x2="800" y2="${i * 60 + 120}"/>`).join('')}</g>` +
    `<text x="400" y="265" font-family="Segoe UI, sans-serif" font-size="40" font-weight="700" fill="#fff" text-anchor="middle">${label}</text>` +
    `</svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

/** Content the model wrote instead of a real file: copied history notes, ellipses, nothing */
function isPlaceholder(content: string): boolean {
  const t = content.trim()
  if (!t) return true
  if (t.length > 200) return false
  return /^[[(]?\s*(?:\d+\s+lines?\s+written|saved\s.+\sto\sdisk.*|content\s+omitted.*|\.{3}|…|same\s+as\s+before|unchanged)\s*[\])]?$/i.test(t)
}

function nodeCheck(file: string): Promise<string | null> {
  return new Promise((resolve) => {
    exec(`node --check "${file}"`, { timeout: 15_000, windowsHide: true }, (err, _out, stderr) => {
      if (!err) return resolve(null)
      // If node itself is missing, don't block the agent
      if (/not recognized|no se reconoce|ENOENT/i.test(String(stderr || err.message))) return resolve(null)
      const msg = String(stderr || err.message)
        .split(/\r?\n/)
        .filter((l) => /SyntaxError|line|\^/.test(l) || /:\d+$/.test(l))
        .slice(0, 4)
        .join(' | ')
      resolve(msg || 'syntax error')
    })
  })
}
