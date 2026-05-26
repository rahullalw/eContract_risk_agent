import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import type { AnalysisReport } from '../types/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = path.resolve(__dirname, '../../.cache')
const CACHE_PATH = path.resolve(CACHE_DIR, 'report_cache.json')
const MAX_CACHE_ENTRIES = Number(process.env.MAX_CACHE_ENTRIES ?? 50)

interface CacheEntry {
  report: AnalysisReport
  cachedAt: number
}

interface CacheSchema {
  [hash: string]: CacheEntry
}

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true })
  }
}

function loadCache(): CacheSchema {
  try {
    ensureCacheDir()
    if (fs.existsSync(CACHE_PATH)) {
      const data = fs.readFileSync(CACHE_PATH, 'utf8')
      const parsed = JSON.parse(data)

      // Migration: convert old flat format to new { report, cachedAt } format
      const keys = Object.keys(parsed)
      if (keys.length > 0 && !parsed[keys[0]]?.cachedAt) {
        const migrated: CacheSchema = {}
        for (const key of keys) {
          migrated[key] = { report: parsed[key], cachedAt: Date.now() }
        }
        return migrated
      }

      return parsed
    }
  } catch (err) {
    console.error('[Cache] Failed to load cache file', err)
  }
  return {}
}

function saveCache(cache: CacheSchema) {
  try {
    ensureCacheDir()
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8')
  } catch (err) {
    console.error('[Cache] Failed to write cache file', err)
  }
}

/** Evict oldest entries if cache exceeds MAX_CACHE_ENTRIES */
function evictOldest(cache: CacheSchema): void {
  const keys = Object.keys(cache)
  if (keys.length <= MAX_CACHE_ENTRIES) return

  // Sort by cachedAt ascending (oldest first)
  const sorted = keys.sort((a, b) => (cache[a].cachedAt ?? 0) - (cache[b].cachedAt ?? 0))
  const toRemove = sorted.slice(0, keys.length - MAX_CACHE_ENTRIES)

  for (const key of toRemove) {
    delete cache[key]
  }

  console.log(`[Cache] Evicted ${toRemove.length} oldest entries (cap: ${MAX_CACHE_ENTRIES})`)
}

export function getFileHash(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

export function getCachedReport(hash: string): AnalysisReport | null {
  const cache = loadCache()
  const entry = cache[hash]
  if (entry) {
    console.log(`[Cache Hit] Instant report returned for content hash ${hash.slice(0, 8)}`)
    return entry.report
  }
  return null
}

export function cacheReport(hash: string, report: AnalysisReport): void {
  const cache = loadCache()
  cache[hash] = { report, cachedAt: Date.now() }
  evictOldest(cache)
  saveCache(cache)
  console.log(`[Cache Set] Cached report for content hash ${hash.slice(0, 8)} (${Object.keys(cache).length}/${MAX_CACHE_ENTRIES} entries)`)
}

export function getCacheStats(): { entries: number; maxEntries: number } {
  const cache = loadCache()
  return { entries: Object.keys(cache).length, maxEntries: MAX_CACHE_ENTRIES }
}
