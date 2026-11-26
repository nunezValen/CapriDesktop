import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { huggingFaceHome, speechModelsDir } from '../src/main/services/app-paths'
import { setStorageRoot } from '../src/main/services/storage-location'
import { planMove, qwenModels } from '../src/main/services/storage-move'

test('Mac Qwen cache is inventoried and moves with speech models, including a selected requirements root', { skip: process.platform !== 'darwin' }, async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-qwen-cache-'))
  const previous = { data: process.env.CAPRI_QWEN_TEST_DATA, hf: process.env.HF_HOME, ollama: process.env.OLLAMA_MODELS }
  process.env.CAPRI_QWEN_TEST_DATA = data
  process.env.HF_HOME = path.join(data, 'unrelated-hf-cache')
  process.env.OLLAMA_MODELS = path.join(data, 'no-ollama-models')
  try {
    const original = speechModelsDir()
    assert.equal(huggingFaceHome(), original)
    const name = 'models--Qwen--Qwen3-TTS-12Hz-0.6B-CustomVoice'
    const model = path.join(huggingFaceHome(), 'hub', name)
    fs.mkdirSync(model, { recursive: true })
    fs.writeFileSync(path.join(model, 'test-weight'), 'qwen')
    assert.deepEqual(qwenModels(huggingFaceHome()), [name])
    const destination = path.join(data, 'other-disk', 'CapriData')
    const plan = await planMove(destination, null)
    assert.ok(plan.items.some(item => item.from === original && item.to === path.join(destination, 'whisper') && item.bytes >= 4))
    setStorageRoot(destination)
    assert.equal(huggingFaceHome(), path.join(destination, 'whisper'))
    assert.equal(huggingFaceHome(), speechModelsDir())
    setStorageRoot(null)
    assert.equal(huggingFaceHome(), original)
    assert.equal(fs.readFileSync(path.join(model, 'test-weight'), 'utf8'), 'qwen', 'planning must not move existing files')
  } finally {
    setStorageRoot(null)
    for (const [key, value] of Object.entries({ CAPRI_QWEN_TEST_DATA: previous.data, HF_HOME: previous.hf, OLLAMA_MODELS: previous.ollama })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(data, { recursive: true, force: true })
  }
})
