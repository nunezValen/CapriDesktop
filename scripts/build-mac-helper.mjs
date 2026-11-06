import { mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
if (process.platform !== 'darwin') throw new Error('Build the Mac helper on macOS')
mkdirSync('scripts/macos/bin', { recursive: true })
execFileSync(
  'xcrun',
  [
    'swiftc',
    '-O',
    '-target',
    'arm64-apple-macos13.0',
    'scripts/macos/desktop.swift',
    '-o',
    'scripts/macos/bin/capri-desktop',
  ],
  { stdio: 'inherit' },
)
