/** Read at request time; no network, permission prompt or language model needed. */
export function deviceClockContext(now = new Date()): string {
  const zone=Intl.DateTimeFormat().resolvedOptions().timeZone
  return `Device clock: ${now.toISOString()}. Local time: ${now.toLocaleString()}. Time zone: ${zone}. Use this clock for current time/date questions; do not claim live clock access is unavailable.`
}
export function deviceClockAnswer(text: string, now = new Date(), locale = 'en'): string | null {
  const question=text.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[?¿!.,]/g,'').replace(/\s+/g,' ')
    .replace(/^(?:hey\s+)?capri\s*/,'').replace(/^(?:please |can you |could you )/,'').replace(/^(?:tell me |give me )/,'').replace(/ please$/,'')
  const time=/^(?:what(?:'s| is) (?:the )?(?:current |local )?time(?: now| right now)?|what time is it(?: now| right now)?|(?:the )?(?:current |local )?time|que hora es|dime la hora)$/.test(question)
  const date=/^(?:what(?:'s| is) (?:the )?(?:current |todays |today's )?date(?: today)?|what date is it(?: today)?|(?:the )?(?:current |today's )?date|que fecha es(?: hoy)?)$/.test(question)
  const day=/^(?:what day is (?:it|today)|what(?:'s| is) (?:the )?day today|que dia es(?: hoy)?)$/.test(question)
  if(!time && !date && !day) return null
  const language=/\b(?:que|dime)\b/.test(question) ? 'es' : locale
  const zone=Intl.DateTimeFormat().resolvedOptions().timeZone
  if(time) return `${language==='es' ? 'Son las' : "It's"} ${now.toLocaleTimeString(language,{hour:'numeric',minute:'2-digit'})}, choom. (${zone})`
  return `${language==='es' ? 'Hoy es' : 'Today is'} ${now.toLocaleDateString(language,{weekday:'long',year:'numeric',month:'long',day:'numeric'})}, choom.`
}
