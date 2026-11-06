/** Vision always uses the local Ollama endpoint, independently of cloud text settings. */
export async function localVisionModels(): Promise<string[]> {
  const response = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(3000) })
  if (!response.ok) throw new Error(`Local Ollama model list failed (${response.status}).`)
  const data = await response.json() as {models?: {name:string}[]}
  return (data.models || []).map(model=>model.name)
}
export async function describeLocalImage(model: string, base64: string, prompt: string, releaseAfterUse: boolean): Promise<string> {
  const response = await fetch('http://127.0.0.1:11434/api/generate', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({model, images:[base64], prompt, stream:false, keep_alive:releaseAfterUse ? 0 : '15m', options:{temperature:0.2,num_predict:220,num_ctx:2048}}),
    signal: AbortSignal.timeout(90000),
  })
  if (!response.ok) throw new Error(`Local vision model failed (${response.status}). Check that the installed model supports images.`)
  const data = await response.json() as {response?:string}
  const description = data.response?.trim()
  if (!description) throw new Error('The local vision model returned an empty response.')
  return description
}

export function isScreenQuestion(text: string): boolean {
  return /(?:what(?:'s| is).*?(?:on|in).*?(?:my|the) screen|(?:check|look at|see|read|scan|describe) (?:my |the )?screen|what (?:can|do) you see(?: on my screen)?(?: right now)?[?.!]*$|what am i looking at)/i.test(text.trim())
}
