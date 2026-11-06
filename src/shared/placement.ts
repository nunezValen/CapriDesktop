export type ScreenAnchor = 'bottom' | 'bottom-left' | 'bottom-right' | 'top' | 'top-left' | 'top-right' | 'left' | 'right' | 'center'
export type PlacementCommand = ScreenAnchor | 'here' | 'roam'
export function parsePlacementCommand(text: string): PlacementCommand | null {
  const s = text.toLowerCase().replace(/[.!?,]/g, '').replace(/^(?:capri\s+|please\s+|can you\s+|could you\s+)+/, '').trim()
  if (/^(?:stay|sit|remain|stop|freeze)(?:\s+right)?\s+here(?:\s+please)?$|^stay put$|^dont move$|^do not move$/.test(s)) return 'here'
  if (/^(?:roam|wander|walk|move around)(?:\s+(?:again|freely))?$|^resume roaming$/.test(s)) return 'roam'
  if (!/^(?:sit|move|go|stay|stand|position yourself)\b/.test(s)) return null
  if (/\b(?:window|tabs?|browser)\b/.test(s)) return null
  const vertical = /\b(?:bottom|floor)\b/.test(s) ? 'bottom' : /\btop\b/.test(s) ? 'top' : ''
  const horizontal = /\bleft\b/.test(s) ? 'left' : /\bright\b/.test(s) ? 'right' : ''
  if (vertical && horizontal) return `${vertical}-${horizontal}` as ScreenAnchor
  if (vertical) return vertical
  if (horizontal) return horizontal
  return /\b(?:center|centre|middle)\b/.test(s) ? 'center' : null
}
export function anchorBounds(area: {x:number;y:number;width:number;height:number}, size: {width:number;height:number}, anchor: ScreenAnchor) {
  const margin=12
  const minX=area.x, minY=area.y
  const maxX=Math.max(minX,area.x+area.width-size.width), maxY=Math.max(minY,area.y+area.height-size.height)
  const x=anchor.includes('left')?minX+margin:anchor.includes('right')?maxX-margin:(minX+maxX)/2
  const y=anchor.includes('top')?minY+margin:anchor.includes('bottom')?maxY-margin:(minY+maxY)/2
  return {x:Math.round(Math.max(minX,Math.min(maxX,x))),y:Math.round(Math.max(minY,Math.min(maxY,y))),...size}
}
