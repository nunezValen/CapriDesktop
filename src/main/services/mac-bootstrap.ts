// Run before services read configuration or voice environment paths.
import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import { legacyUserDataDir } from './legacy-data'

if (process.platform === 'darwin') {
  app.setName('Capri Desktop')
  // Finder/login launches have a short PATH; make installed CLI dependencies discoverable.
  const paths=[...(process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin').split(path.delimiter),
    '/opt/homebrew/bin','/opt/homebrew/opt/python@3.11/libexec/bin',
    '/Library/Frameworks/Python.framework/Versions/3.11/bin','/usr/local/bin',
    '/Applications/Ollama.app/Contents/Resources']
  process.env.PATH=[...new Set(paths.filter(dir=>dir && fs.existsSync(dir)))].join(path.delimiter)

  const override = app.commandLine.getSwitchValue('user-data-dir')
  const legacy = override ? null : legacyUserDataDir(app.getPath('appData'), app.isPackaged, fs.existsSync)
  app.setPath('userData', override ? path.resolve(override) : legacy || path.join(app.getPath('appData'), 'Capri Desktop'))
}
