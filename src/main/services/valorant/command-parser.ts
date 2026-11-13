import { championDatabase } from '../lol/champion-database'
import { findValorantAgent, normalizeAgentName, type ValorantAgent } from './agent-names'
import type { ValorantQueue } from './matchmaking-service'

export interface ValorantCommand {
  /** The request belongs to Valorant, so the League interceptor must stay out of it */
  isValorant: boolean
  wantsCancel: boolean
  agentQuery: string | null
  agent: ValorantAgent | null
  /** "find a match": start the search */
  wantsSearch: boolean
  /** "cancel the search": leave the queue */
  wantsLeaveQueue: boolean
  /** The mode, when it was said: "competitive", "unrated", "swiftplay"... */
  queue: ValorantQueue | null
  /** A search with no game named and no agent: which game is open decides */
  searchWithoutGame: boolean
}

/** Same words as League's search, so "busca partida" means the game that is open */
const SEARCH = /(?:busc[aá](?:r|me)?\s+(?:una\s+)?(?:partida|juego|match|game)|entr(?:a|ar)\s+a\s+(?:la\s+)?cola|inici(?:a|ar)\s+(?:la\s+)?b[uú]squeda|pon[eé]?me\s+en\s+cola|ponme\s+en\s+cola|find\s+(?:me\s+)?(?:a\s+)?(?:\w+\s+)?(?:valorant\s+)?(?:match|game)|queue\s+(?:me\s+)?up|start\s+(?:the\s+)?(?:matchmaking|queue|search)|\bbusca\s+partida\b|\bbuscar\s+partida\b|\by\s+busca\b|\band\s+(?:search|find)\b)/i
const LEAVE = /(?:cancel[\wáé]*|deten[\wé]*|stop|par[aá][\wá]*|sal[\wí]*\s+de)\s+(?:la\s+|el\s+|the\s+)?(?:valorant\s+)?(?:b[uú]squeda|matchmaking|queue|cola|search)|leave\s+(?:the\s+)?queue|dej[aá]\s+de\s+buscar|stop\s+searching/i

const QUEUES: [ValorantQueue, RegExp][] = [
  ['hurm', /team\s*deathmatch|\btdm\b|duelo\s+por\s+equipos|todos\s+contra\s+todos\s+por\s+equipos/i],
  ['deathmatch', /death\s*match|todos\s+contra\s+todos|\bffa\b/i],
  ['spikerush', /spike\s*rush|fiebre\s+de\s+(?:la\s+)?spike/i],
  ['swiftplay', /swift\s*play|\bswift\b|partida\s+r[aá]pida|r[aá]pida/i],
  ['competitive', /(?<!\bno +)competiti\w*|ranked|rankeada|clasificatoria|\brank\b/i],
  ['unrated', /unrated|sin\s+rango|no +competitiv\w*|normal(?:es)?\b|casual/i]
]

const VALORANT_MENTION = /\b(?:valorant|valo|valorantito|agentes?|agents?)\b/i
const GAME_MENTION = /\b(?:valorant|valo|valorantito)\b/i
const CANCEL_VERB = /\b(?:cancel\w*|anul\w*|det[eé]n\w*|stop|abort\w*)\b/i
const SELECT_TARGET = /\b(?:pick\w*|lock\w*|bloque\w*|agentes?|agents?|selecci[oó]n|select)\b/i

const PICK_VERB = [
  'picke[aáeo](?:me)?',
  'pickear',
  'pick',
  'locke[aáeo](?:me)?',
  'lockear',
  'lock\\s*in',
  'lock',
  'bloque[aá](?:me|r)?',
  'eleg[ií](?:me|r)?',
  'elije',
  'elige',
  'seleccion[aá](?:me|r)?',
  'seleccionar',
  'select',
  'choose',
  'agarrame',
  'agarr[aá](?:me|r)?',
  'equip[aá](?:me)?'
].join('|')

const ARTICLE = '(?:a|al|el|la|los|las|un|una|the|to)\\s+'
const NAME_WORD = "[\\p{L}0-9'/.-]+"
const PICK_MATCH = new RegExp(`(?:${PICK_VERB})\\s+(?:${ARTICLE})?(${NAME_WORD}(?:\\s+${NAME_WORD})?)`, 'iu')

const LEADING_ARTICLES: Record<string, true> = {
  a: true,
  al: true,
  el: true,
  la: true,
  los: true,
  las: true,
  un: true,
  una: true,
  the: true,
  to: true
}

const TRAILING_STOPWORDS: Record<string, true> = {
  en: true,
  in: true,
  on: true,
  de: true,
  del: true,
  para: true,
  for: true,
  con: true,
  now: true,
  ahora: true,
  ya: true,
  porfa: true,
  please: true,
  choomba: true,
  mismo: true,
  valorant: true,
  valo: true,
  lol: true,
  league: true,
  y: true,
  and: true,
  then: true,
  luego: true,
  despues: true,
  después: true
}

const EMPTY_QUERIES: Record<string, true> = {
  agente: true,
  agent: true,
  agentes: true,
  agents: true,
  algo: true,
  something: true,
  uno: true,
  algun: true
}

const AGENT_DESCRIPTORS: Record<string, true> = {
  agente: true,
  agent: true,
  agentes: true,
  agents: true
}

/** "elegí a Jett en valorant" -> "Jett"; "agarrame a kay o" -> "kay o" */
function cleanAgentQuery(raw: string): string | null {
  const words = raw.trim().split(/\s+/)
  while (words.length && TRAILING_STOPWORDS[words[words.length - 1].toLowerCase()] === true) words.pop()
  while (words.length && LEADING_ARTICLES[words[0].toLowerCase()] === true) words.shift()
  // "el agente Jett" and "agent Jett" carry a filler descriptor, not part of the name
  if (words.length > 1 && AGENT_DESCRIPTORS[words[0].toLowerCase()] === true) {
    words.shift()
    while (words.length && LEADING_ARTICLES[words[0].toLowerCase()] === true) words.shift()
  }
  const query = words.join(' ').trim()
  const key = normalizeAgentName(query)
  if (!key || EMPTY_QUERIES[key] === true) return null
  return query
}

export function parseValorantCommand(norm: string): ValorantCommand {
  const text = (norm || '').trim()
  const mentionsValorant = VALORANT_MENTION.test(text)
  const mentionsGame = GAME_MENTION.test(text)
  const wantsLeaveQueue = LEAVE.test(text)
  const wantsCancel = !wantsLeaveQueue && CANCEL_VERB.test(text) && SELECT_TARGET.test(text) && mentionsValorant
  const wantsSearch = !wantsLeaveQueue && SEARCH.test(text)
  const queue = wantsSearch ? (QUEUES.find(([, re]) => re.test(text))?.[0] ?? null) : null

  const match = wantsCancel ? null : text.match(PICK_MATCH)
  const agentQuery = match ? cleanAgentQuery(match[1]) : null
  const agent = agentQuery ? findValorantAgent(agentQuery) : null
  const champion = agentQuery ? championDatabase.findExactChampion(agentQuery) : null

  const pickIsValorant = agentQuery !== null && (mentionsValorant || (agent !== null && !champion))
  // "busca partida y lockea a Jett" is VALORANT because of the agent; "busca partida en valorant" because of the name
  const queueIsValorant = (wantsSearch || wantsLeaveQueue) && (mentionsGame || pickIsValorant)
  const isValorant = wantsCancel || pickIsValorant || queueIsValorant
  // Only a short command: "find me a game to play tonight" is a question, not the Play button
  const searchWithoutGame = !isValorant && (wantsSearch || wantsLeaveQueue) && !agentQuery && text.length <= 60

  return { isValorant, wantsCancel, agentQuery: pickIsValorant ? agentQuery : null, agent: pickIsValorant ? agent : null, wantsSearch: isValorant && wantsSearch, wantsLeaveQueue: isValorant && wantsLeaveQueue, queue, searchWithoutGame }
}
