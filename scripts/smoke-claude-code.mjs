import { build } from 'esbuild'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'
import assert from 'node:assert/strict'

const dir = mkdtempSync(join(tmpdir(), 'capri-smoke-'))
const bundle = join(dir, 'gateway.mjs')
try {
  await build({
    entryPoints: ['src/main/services/llm-gateway.ts'], bundle: true, platform: 'node', format: 'esm', outfile: bundle,
    plugins: [{ name: 'standalone', setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: `export const app = { getPath: () => ${JSON.stringify(dir)}, getAppPath: () => ${JSON.stringify(resolve('.'))}, isPackaged: false }; export const safeStorage = {};` }))
      b.onResolve({ filter: /user-profile$/ }, () => ({ path: 'profile', namespace: 'profile' }))
      b.onLoad({ filter: /.*/, namespace: 'profile' }, () => ({ contents: 'export const personalize = (text) => text;' }))
    } }]
  })
  writeFileSync(join(dir, 'capri_llm.json'), JSON.stringify({ provider: 'claude-code', claudeModel: 'haiku' }))
  const { llmFetch } = await import(pathToFileURL(bundle).href)
  const request = async (label, route, body) => {
    const response = await llmFetch(`http://127.0.0.1:11434${route}`, { method: 'POST', body: JSON.stringify({ model: 'smoke', ...body }) })
    const raw = await response.text()
    console.log(`${label}: ${raw.trim()}`)
    assert(response.ok, raw)
    assert(!/ADHD/i.test(raw), 'SessionStart rules leaked into response')
    return JSON.parse(raw)
  }
  const a = await request('a generate', '/api/generate', { prompt: 'Reply exactly: CAPRI_OK', stream: true })
  assert.match(a.response, /CAPRI_OK/)
  const b = await request('b multi-turn system', '/api/chat', { messages: [
    { role: 'system', content: 'Answer in English. Prefix your answer with SYSTEM_OK.' },
    { role: 'user', content: 'Remember the code word: pineapple.' },
    { role: 'assistant', content: 'I will remember it.' },
    { role: 'user', content: 'What is the code word?' }
  ] })
  assert.match(b.message.content, /SYSTEM_OK.*pineapple/is)
  const crc = (data) => {
    let n = 0xffffffff
    for (const byte of data) { n ^= byte; for (let bit = 0; bit < 8; bit++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0) }
    return (n ^ 0xffffffff) >>> 0
  }
  const chunk = (name, data) => {
    const type = Buffer.from(name), size = Buffer.alloc(4), sum = Buffer.alloc(4)
    size.writeUInt32BE(data.length); sum.writeUInt32BE(crc(Buffer.concat([type, data])))
    return Buffer.concat([size, type, data, sum])
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(64, 0); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 2
  const pixels = Buffer.alloc(64 * (1 + 64 * 3))
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) pixels[y * 193 + 1 + x * 3] = 255
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]).toString('base64')
  const c = await request('c PNG image', '/api/chat', { messages: [{ role: 'user', content: 'What is the dominant color of this image? One word in English.', images: [png] }] })
  assert.match(c.message.content, /red/i)
  const image = await request('c OpenAI image', '/chat/completions', { messages: [{ role: 'user', content: [{ type: 'text', text: 'Name the dominant color. One word in English.' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }] }] })
  assert.match(image.choices[0].message.content, /red/i)
  const d = await request('d tool call', '/chat/completions', { messages: [{ role: 'user', content: 'Call get_weather for Paris now.' }], tools: [{ type: 'function', function: { name: 'get_weather', description: 'Get current weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }] })
  const call = d.choices[0].message.tool_calls[0]
  assert.equal(call.function.name, 'get_weather'); assert.equal(JSON.parse(call.function.arguments).city, 'Paris')
  const e = await request('e JSON', '/api/generate', { prompt: 'Return an object with ok set to true and count set to 3.', format: 'json' })
  assert.deepEqual(JSON.parse(e.response), { ok: true, count: 3 })
  console.log('PASS: text, multi-turn/system, both image formats, agent-compatible tool call, JSON; no ADHD rule leakage.')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
