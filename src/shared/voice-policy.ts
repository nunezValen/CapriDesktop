/** Mac wake listening requires a fresh wake name for every request. */
export function wakeListeningPrompt(isMac: boolean, heard: string, check: {addressed: boolean; text: string; reason: string}, inFollowUp: boolean): string | null {
  if (isMac) return check.addressed && check.reason === 'wake_word' ? check.text : null
  if (check.addressed) return check.text
  return inFollowUp && heard.split(/\s+/).length >= 2 ? heard : null
}
