import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'

function load(file, dependencies = {}) {
  const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  const exports = {}
  runInNewContext(outputText, { exports, require: (name) => dependencies[name] || {}, console })
  return exports
}

const gb = load('shared/gpu-budget.ts')
const qwen = load('shared/qwen-tts.ts')
const GB = 1024 ** 3
const nvidia = (total) => ({ kind: 'nvidia', name: 'RTX', totalBytes: total * GB, unified: false })

test('Whisper small weighs more than base, both under 1.5 GB', () => {
  assert.ok(gb.whisperBytes('small') > gb.whisperBytes('base'))
  assert.ok(gb.whisperBytes('small') < 1.5 * GB)
})

test('Qwen3-TTS 1.7B weighs more than 0.6B', () => {
  assert.ok(gb.qwenTtsBytes('1.7B') > gb.qwenTtsBytes('0.6B'))
})

test('LLM size is the weights plus a cache that grows with the context', () => {
  const shape = { weightsBytes: 4 * GB, layers: 28, kvHeads: 4, headDim: 128, context: 4096 }
  const short = gb.llmBytes(shape)
  assert.ok(short > 4 * GB)
  assert.ok(gb.llmBytes({ ...shape, context: 8192 }) > short)
})

test('parameter count is read from the model name', () => {
  assert.equal(gb.paramsFromName('qwen3:1.7b'), 1.7)
  assert.equal(gb.paramsFromName('qwen2.5-coder:7b'), 7)
  assert.equal(gb.paramsFromName('capri'), null)
  assert.equal(gb.paramsFromName('llama3.2:latest'), null)
})

test('model_info becomes a shape, and a missing field gives none', () => {
  const info = { 'x.block_count': 32, 'x.attention.head_count': 32, 'x.attention.head_count_kv': 8, 'x.embedding_length': 4096 }
  assert.deepEqual({ ...gb.shapeFromModelInfo(info, GB, 4096) }, { weightsBytes: GB, layers: 32, kvHeads: 8, headDim: 128, context: 4096 })
  assert.equal(gb.shapeFromModelInfo({ 'x.block_count': 32 }, GB, 4096), null)
})

test('num_ctx is read from the Modelfile parameters', () => {
  assert.equal(gb.contextFromParameters('temperature 0.7\nnum_ctx 8192'), 8192)
  assert.equal(gb.contextFromParameters(undefined), null)
})

test('the budget says whether everything fits, with the system reserve counted', () => {
  const part = (bytes) => ({ id: 'tts', label: 'x', bytes, onGpu: true, note: 'qwen' })
  assert.equal(gb.budgetTotals(nvidia(8), [part(2 * GB)]).fits, true)
  assert.equal(gb.budgetTotals(nvidia(8), [part(7.5 * GB)]).fits, false)
  assert.equal(gb.budgetTotals({ kind: 'nvidia', name: 'x', totalBytes: null, unified: false }, [part(GB)]).fits, null)
})

test('components that run elsewhere take no memory', () => {
  const cloud = { id: 'tts', label: 'x', bytes: 9 * GB, onGpu: false, note: 'cloud' }
  assert.equal(gb.budgetTotals(nvidia(4), [cloud]).usedBytes, 0)
})

test('only Qwen3-TTS needs the GPU, and Whisper needs CUDA', () => {
  assert.equal(gb.ttsRunsOnGpu('qwen3-tts', nvidia(8)), true)
  assert.equal(gb.ttsRunsOnGpu('edge-tts', nvidia(8)), false)
  assert.equal(gb.ttsRunsOnGpu('qwen3-tts', { kind: 'amd-intel', name: '', totalBytes: null, unified: false }), false)
  assert.equal(gb.sttRunsOnGpu({ kind: 'apple', name: '', totalBytes: null, unified: true }), false)
})

test('voice design always uses the 1.7B model', () => {
  assert.equal(qwen.effectiveQwenSize({ mode: 'design', model_size: '0.6B' }), '1.7B')
  assert.equal(qwen.effectiveQwenSize({ mode: 'clone', model_size: '0.6B' }), '0.6B')
  assert.equal(qwen.qwenModelFolder({ mode: 'clone', model_size: '1.7B' }), 'Qwen3-TTS-12Hz-1.7B-Base')
  assert.equal(qwen.qwenModelFolder({ mode: 'design', model_size: '0.6B' }), 'Qwen3-TTS-12Hz-1.7B-VoiceDesign')
  assert.equal(qwen.qwenModelFolder({ mode: 'custom', model_size: '0.6B' }), 'Qwen3-TTS-12Hz-0.6B-CustomVoice')
})

test('a saved config with unknown values is repaired', () => {
  const fixed = qwen.normalizeQwenConfig({ mode: 'weird', model_size: '9B' })
  assert.equal(fixed.mode, 'custom')
  assert.equal(fixed.model_size, '0.6B')
  assert.equal(fixed.speaker, 'Vivian')
})
