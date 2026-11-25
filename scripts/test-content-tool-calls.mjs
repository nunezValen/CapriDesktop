// Tool calls a model only showed in an explanation never run, real ones still do (issue #57)
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../src/main/agents/tools/content-tool-calls.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
const lib = {}
runInNewContext(outputText, { exports: lib })
const { isExampleToolReply, hasPlaceholderCommand, asksHowToNotToRun, stripToolCallJson, shellCommandFor } = lib

const FENCE = '```'
const ISSUE_REPLY = `Sure! To execute a command and then navigate into its output's first matching line, you can use the following approach:

${FENCE}json
{"name": "run_command", "arguments": {"command":"find /path/to/search -type d | head -n 1"}}
${FENCE}

This command will search for directories in \`/path/to/search\` and return the first one. Then you can change into it:

${FENCE}json
{"name": "run_command", "arguments": {"command":"cd $(find /path/to/search -type d | head -n 1)"}}
${FENCE}

Please replace \`/path/to/search\` with the actual path you want to search in.`

test('the reply from issue #57 is an explanation: nothing runs and the prose stays', () => {
  assert.equal(isExampleToolReply(ISSUE_REPLY), true)
  assert.equal(asksHowToNotToRun("can you help me with the find command in Linux? I want to use the result from find command to change directory"), true)
  const shown = stripToolCallJson(ISSUE_REPLY)
  assert.doesNotMatch(shown, /run_command|"name"/)
  assert.match(shown, /Sure! To execute a command/)
  assert.match(shown, /Please replace/)
})

test('a single tool call after a short lead-in still runs', () => {
  for (const reply of [
    'Sure, running it: {"name": "run_command", "arguments": {"command": "Get-Date"}}',
    `Claro, lo abro: ${FENCE}json\n{"name": "open_application", "arguments": {"appOrUrl": "spotify"}}\n${FENCE}`,
    'Claro choomba, te pongo esa canción ahora mismo [happy] {"name": "open_application", "arguments": {"appOrUrl": "youtube music", "query": "lofi"}}',
    '<tool_call>{"name": "write_file", "arguments": {"path": "C:\\\\Users\\\\me\\\\Desktop\\\\a.txt", "content": "hola mundo, esto es una nota bastante larga que no debería contar como prosa porque va dentro del JSON de la herramienta"}}</tool_call>'
  ]) {
    assert.equal(isExampleToolReply(reply), false, reply)
  }
})

test('a bare tool call still runs', () => {
  assert.equal(isExampleToolReply('{"name": "run_command", "arguments": {"command": "mkdir C:\\\\Users\\\\me\\\\Desktop\\\\notes"}}'), false)
  assert.equal(isExampleToolReply('{"type": "function", "function": {"name": "web_search", "arguments": {"query": "weather"}}}'), false)
})

test('one tool call wrapped in a long explanation does not run', () => {
  const reply = 'You can list hidden files with the command below. It shows every file, including the ones that start with a dot, and prints their sizes and dates so you can compare them. {"name": "run_command", "arguments": {"command": "ls -la"}}'
  assert.equal(isExampleToolReply(reply), true)
})

test('commands with placeholders are skipped, real ones are not', () => {
  for (const command of [
    'find /path/to/search -type d | head -n 1',
    'Get-ChildItem C:\\path\\to\\folder',
    'cd <dir>',
    'cp file.txt <your_path>',
    'ls /home/your_username/Documents'
  ]) {
    assert.equal(hasPlaceholderCommand(command), true, command)
  }
  for (const command of [
    'Get-ChildItem $env:USERPROFILE\\Desktop',
    'find ~/projects -type d -name src',
    'sort < in.txt > out.txt',
    'Get-Process 2>&1 | Select-Object -First 5',
    'echo "path to success"'
  ]) {
    assert.equal(hasPlaceholderCommand(command), false, command)
  }
})

test('how-to questions in English and Spanish do not run commands, requests to run do', () => {
  for (const prompt of ['how do I find big files?', 'explain the find command', '¿cómo hago para buscar archivos grandes?', 'explícame el comando cd', 'ayúdame con el comando find']) {
    assert.equal(asksHowToNotToRun(prompt), true, prompt)
  }
  for (const prompt of ['create a folder called notes on my desktop', 'abre spotify', 'how do I find big files? run it for me', '¿cómo busco archivos grandes? ejecutalo', 'list the files in my downloads']) {
    assert.equal(asksHowToNotToRun(prompt), false, prompt)
  }
})

test('PowerShell output is read as UTF-8 on Windows only', () => {
  assert.equal(shellCommandFor('head -n 1', 'win32'), '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;head -n 1')
  assert.equal(shellCommandFor('head -n 1', 'linux'), 'head -n 1')
  assert.equal(shellCommandFor('head -n 1', 'darwin'), 'head -n 1')
})
