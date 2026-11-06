export interface SpotifyCandidate { uri?: string; title: string; artist?: string; key?: string }
const words = (text: string): string[] => text.normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []
function similarity(a: string, b: string): number {
  if (a === b) return 1
  if (Math.min(a.length,b.length) < 3) return 0
  let row = Array.from({length:b.length+1},(_,i)=>i)
  for (let i=1;i<=a.length;i++) {
    const next=[i]
    for (let j=1;j<=b.length;j++) next[j]=Math.min(next[j-1]+1,row[j]+1,row[j-1]+(a[i-1]===b[j-1]?0:1))
    row=next
  }
  return 1-row[b.length]/Math.max(a.length,b.length)
}
/** Rank real search results; tolerate misspellings without inventing a track URI. */
export function closestSpotifyTrack(query: string, candidates: SpotifyCandidate[]): SpotifyCandidate | null {
  const filler = new Set(['play','please','song','track','music','by','on','spotify','the','a','me','can','you'])
  const tokens=words(query).filter(w=>!filler.has(w))
  if (!tokens.length) return null
  let best: SpotifyCandidate | null=null
  let bestScore=0.44
  for (const candidate of candidates) {
    if (!(candidate.uri && /^spotify:track:[a-zA-Z0-9]{22}$/.test(candidate.uri)) && !(candidate.key && candidate.title)) continue
    const target=words(`${candidate.title} ${candidate.artist || ''}`)
    if (!target.length) continue
    const scores=tokens.map(token=>Math.max(...target.map(word=>similarity(token,word))))
    let score=scores.reduce((sum,s)=>sum+(s>=0.6?s:0),0)/tokens.length
    if (scores.every(s=>s>=0.8)) score+=0.12
    const variants=['karaoke','tribute','cover','live','remix','instrumental','sped','slowed']
    for (const variant of variants) if (target.includes(variant) && !tokens.includes(variant)) score-=0.12
    // Spotify's result order breaks ties; do not penalize additional artist names or album/version text.
    if (score>bestScore) { best=candidate;bestScore=score }
  }
  return best
}

/** Broaden a search if Spotify itself cannot recover the user's spelling. Rank against the original request throughout. */
export function spotifySearchQueries(query: string): string[] {
  const artist=query.match(/\bby\s+(.+)$/i)?.[1]?.trim()
  const filler=new Set(['play','please','song','track','music','by','on','spotify','the','a','me','can','you','who','what','is','for','to','of'])
  const keywords=words(query).filter(w=>!filler.has(w))
  return [...new Set([query.trim(), ...(artist ? [artist] : [keywords.slice(0,2).join(' '),keywords[0] || ''])])].filter(Boolean).slice(0,3)
}

export function verifySpotifySelection(expected: SpotifyCandidate, current: {uri?:string;title:string}): boolean {
  if (!current.uri || !/^spotify:track:[a-zA-Z0-9]{22}$/.test(current.uri)) return false
  if (expected.uri) return current.uri === expected.uri
  const title=words(expected.title).join(' ')
  const artist=words((expected.artist || '').split(',')[0]).join(' ')
  const actual=words(current.title).join(' ')
  return title.length>0 && actual.includes(title) && (!artist || actual.includes(artist))
}
