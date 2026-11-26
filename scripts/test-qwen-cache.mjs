import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
await build({
  entryPoints: ['tests/qwen-cache.test.ts'], outfile: 'work/qwen-cache-tests.cjs',
  bundle: true, platform: 'node', format: 'cjs',
  plugins: [{ name: 'qwen-cache-mocks', setup(b) {
    b.onResolve({ filter: /^electron$|\/platform$/ }, () => ({ path: path.resolve('tests/qwen-cache-mocks.ts') }))
  } }]
})
execFileSync(process.execPath, ['--test', 'work/qwen-cache-tests.cjs'], { stdio: 'inherit' })
