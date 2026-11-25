// Tool calls a model wrote into its reply text instead of calling the tool. Small models do it for
// real requests ("Claro, lo abro: {...}") but also when they only show an example (issue #57).

// Template paths a model shows in an explanation; a command with one of these was never meant to run
export const PLACEHOLDER_COMMAND_PATTERNS: RegExp[] = [
  /[\\/]path[\\/]to(?:[\\/]|\b)/i,
  /<[a-z_][\w\s-]*>/i,
  /\byour[_-]?(?:user(?:name)?|path|folder|directory|file(?:name)?)\b/i
]

export function hasPlaceholderCommand(command: string): boolean {
  return PLACEHOLDER_COMMAND_PATTERNS.some((p) => p.test(command))
}

// More words than this around a single tool call make the reply an explanation, not a lead-in
export const EXPLANATION_MIN_WORDS = 20

const TOOL_NAME_KEY = /"name"\s*:\s*"[A-Za-z_]+"/g

// Every JSON object, fenced block or <tool_call> tag that carries a tool name
export function stripToolCallJson(text: string): string {
  let out = text
    .replace(/<tools?>[\s\S]*?<\/tools?>/gi, ' ')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, ' ')
    .replace(/```[\w-]*\s*\{[\s\S]*?```/g, (block) => (/"name"\s*:/.test(block) ? ' ' : block))
  let start = out.indexOf('{')
  while (start !== -1) {
    let depth = 0
    let end = -1
    for (let i = start; i < out.length; i++) {
      if (out[i] === '{') depth++
      else if (out[i] === '}' && --depth === 0) {
        end = i
        break
      }
    }
    if (end === -1) break
    const object = out.slice(start, end + 1)
    if (/"name"\s*:/.test(object)) {
      out = out.slice(0, start) + ' ' + out.slice(end + 1)
      start = out.indexOf('{', start)
    } else {
      start = out.indexOf('{', end + 1)
    }
  }
  return out
}

// Two tool calls in one reply, or one wrapped in a real explanation: an example, not a request
export function isExampleToolReply(content: string): boolean {
  const text = content.replace(/<think>[\s\S]*?<\/think>/gi, '')
  if ((text.match(TOOL_NAME_KEY) || []).length > 1) return true
  const prose = stripToolCallJson(text)
    .replace(/\[[a-zA-Z0-9_\s-]+\]/g, ' ')
    .replace(/`+/g, ' ')
  const words = prose.match(/[\p{L}\p{N}]+/gu) || []
  return words.length > EXPLANATION_MIN_WORDS
}

// "How do I...", "help me with the find command", "¿cómo hago...?": the user wants to learn, not to have it run
const ASKS_HOW_TO =
  /\b(?:how\s+(?:do|can|would|should)\s+(?:i|you|we)|how\s+to|help\s+me\s+(?:with|understand)|explain|teach\s+me|show\s+me\s+how|what(?:'s|\s+is)\s+the\s+command)\b|(?:^|[^\p{L}])(?:c[oó]mo\s+(?:hago|puedo|se|funciona)|expl[ií]ca(?:me)?|me\s+explic[aá]s|ens[eé][ñn]a(?:me)?|ay[uú]da(?:me)?\s+con|qu[eé]\s+comando)(?![\p{L}])/iu
const ASKS_TO_RUN =
  /\b(?:run|execute)\s+(?:it|this|that)\b|\b(?:do|run)\s+it\s+for\s+me\b|(?:^|[^\p{L}])(?:ejec[uú]ta(?:lo)?|c[oó]rre(?:lo)?|hazlo|hacelo)(?![\p{L}])/iu

export function asksHowToNotToRun(prompt: string): boolean {
  return ASKS_HOW_TO.test(prompt) && !ASKS_TO_RUN.test(prompt)
}

// PowerShell writes in the console code page (cp866 on Russian Windows); Node reads UTF-8
export function shellCommandFor(command: string, platform: string): string {
  return platform === 'win32' ? `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;${command}` : command
}
