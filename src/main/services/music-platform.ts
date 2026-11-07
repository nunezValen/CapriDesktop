import { consciousnessService, type MusicPlatform } from './consciousness-service'

export type PlaybackPlatform = MusicPlatform | 'youtube'

export function resolveMusicPlatform(request: string): PlaybackPlatform {
  if (/youtube[ _]+music|music\.youtube\.com/i.test(request)) return 'youtube_music'
  if (/spotify/i.test(request)) return 'spotify'
  if (/youtube/i.test(request)) return 'youtube'
  return consciousnessService.getMusicPlatform()
}

export function musicPlatformName(platform: PlaybackPlatform): string {
  return platform === 'youtube_music' ? 'YouTube Music' : platform === 'spotify' ? 'Spotify' : 'YouTube'
}
