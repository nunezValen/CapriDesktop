/** Mac game mode keeps the framed eyes, independently of transient AI/voice/script state. */
export function gameCompanionState<T extends string>(platform: string, gaming: boolean, state: T): T | 'ojos' {
  return gaming && /^(?:darwin|mac)/i.test(platform) ? 'ojos' : state
}
