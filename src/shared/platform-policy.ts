import { isMacSystemRequest } from './mac-system-commands'
/** Platform policy kept free of Electron so all OS branches can be regression tested. */
export function platformCapabilities(platform: string, desktopAccess: boolean, screenAccess: boolean) {
  const mac = platform === 'darwin'
  return {
    desktopAwareness: desktopAccess,
    screenCapture: screenAccess,
    paint: platform === 'win32',
    clipping: !mac,
    gameIntegrations: !mac,
    commandMacros: !mac,
  }
}
export function updateDelivery(
  platform: string,
  packaged: boolean,
  appImage: boolean,
): 'source' | 'release-page' | 'appimage' | 'windows-installer' {
  if (!packaged) return 'source'
  if (platform === 'darwin' || (platform === 'linux' && !appImage)) return 'release-page'
  return platform === 'linux' ? 'appimage' : 'windows-installer'
}
export function captureCrop(
  display: { x: number; y: number; width: number; height: number },
  crop: { x: number; y: number; width: number; height: number },
  thumbnail: { width: number; height: number },
) {
  if (thumbnail.width < 1 || thumbnail.height < 1) return null
  const sx = thumbnail.width / display.width,
    sy = thumbnail.height / display.height
  const x = Math.max(0, Math.round((crop.x - display.x) * sx))
  const y = Math.max(0, Math.round((crop.y - display.y) * sy))
  const right = Math.min(thumbnail.width, Math.round((crop.x + crop.width - display.x) * sx))
  const bottom = Math.min(thumbnail.height, Math.round((crop.y + crop.height - display.y) * sy))
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null
}

export function recommendedLocalModel(platform: string, memoryBytes: number): string {
  return platform === 'darwin' && memoryBytes <= 12 * 1024 ** 3 ? 'qwen3:1.7b' : 'qwen2.5-coder:7b'
}

/** Ordinary questions are conversation; only explicit action requests receive desktop tools on Mac. */
export function offerDesktopTools(platform: string, _model: string, prompt: string): boolean {
  if (platform !== 'darwin') return true
  const text=prompt.normalize('NFD').replace(/\p{Diacritic}/gu,'').trim()
    .replace(/^(?:(?:hey\s+)?capri[,!:\s]*|please\s+|(?:can|could|would)\s+you(?:\s+please)?\s+|(?:puedes|podes|por favor)\s+)+/i,'')
  return isMacSystemRequest(text) || /^(?:open|launch|start|close|quit|kill|play|pause|resume|skip|search|find|browse|google|look\s+up|create|build|write|edit|read|list|delete|remove|run|execute|install|draw|scan|capture|move|save|abre|abrir|cerra|cerrar|cierra|reproduce|reproducir|pausa|busca|buscar|crea|crear|escribe|escribir|lee|leer|lista|borra|borrar|ejecuta|instala|dibuja|escanea|guarda)\b/i.test(text)
}

export function scannerVisionMode(platform: string, cloud: boolean, localEnabled: boolean): 'cloud' | 'local' | 'disabled' {
  if (platform === 'darwin' && cloud) return 'cloud'
  return platform === 'darwin' && !localEnabled ? 'disabled' : 'local'
}
