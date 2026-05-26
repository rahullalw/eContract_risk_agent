import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { geminiClient, EMBEDDING_MODEL, withRetry } from './geminiClient.js'
import type { TextChunk } from '../types/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PRECEDENTS_PATH = path.resolve(__dirname, '../resources/precedents.json')

// Interface for local vector storage
interface StoredChunk {
  chunkId: string
  docId: string
  text: string
  sectionTag: string
  embedding: number[]
}

interface Precedent {
  clauseId: string
  type: string
  text: string
  summary: string
  embedding?: number[]
}

// In-memory store
const registry: Record<string, { chunks: StoredChunk[]; timestamp: number }> = {}
let cachedPrecedents: Precedent[] | null = null

// TTL: 1 hour in ms
const TTL_MS = 60 * 60 * 1000

// Clean up expired items
function runGc() {
  const now = Date.now()
  for (const docId of Object.keys(registry)) {
    if (now - registry[docId].timestamp > TTL_MS) {
      delete registry[docId]
    }
  }
}

export async function upsertChunks(chunks: TextChunk[]): Promise<void> {
  runGc()
  if (chunks.length === 0) return
  
  const docId = chunks[0].docId
  const storedChunks: StoredChunk[] = chunks.map(c => ({
    chunkId: c.chunkId,
    docId: c.docId,
    text: c.text,
    sectionTag: c.sectionTag,
    embedding: c.embedding || [],
  }))

  registry[docId] = {
    chunks: storedChunks,
    timestamp: Date.now(),
  }
}

// Pure TypeScript Cosine Similarity (Dot Product / Magnitude)
export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length || vecA.length === 0) return 0
  let dotProduct = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i]
    normA += vecA[i] * vecA[i]
    normB += vecB[i] * vecB[i]
  }
  return normA === 0 || normB === 0 ? 0 : dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
}

export async function queryLocalVector(
  embedding: number[],
  topK = 3,
  sectionTag?: string,
): Promise<Array<{ text: string; sectionTag: string; score: number }>> {
  runGc()
  
  // Flatten all chunks across all non-expired documents
  const allChunks: StoredChunk[] = []
  for (const docId of Object.keys(registry)) {
    allChunks.push(...registry[docId].chunks)
  }

  // Filter and score
  const scored = allChunks
    .filter(c => !sectionTag || c.sectionTag === sectionTag)
    .map(c => {
      const score = cosineSimilarity(embedding, c.embedding)
      return {
        text: c.text,
        sectionTag: c.sectionTag,
        score,
      }
    })

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score)

  return scored.slice(0, topK)
}

async function getPrecedentsWithEmbeddings(): Promise<Precedent[]> {
  if (cachedPrecedents) return cachedPrecedents

  let rawPrecedents: Precedent[] = []
  try {
    if (fs.existsSync(PRECEDENTS_PATH)) {
      const data = fs.readFileSync(PRECEDENTS_PATH, 'utf8')
      rawPrecedents = JSON.parse(data)
    } else {
      console.warn(`Precedents file not found at ${PRECEDENTS_PATH}, using fallback empty array.`)
    }
  } catch (err) {
    console.error('Failed to load precedents.json', err)
  }

  // Embed any that don't have embeddings
  for (const prec of rawPrecedents) {
    if (!prec.embedding) {
      try {
        const embResp = await withRetry(() =>
          geminiClient.embeddings.create({
            model: EMBEDDING_MODEL,
            input: prec.text,
          })
        )
        prec.embedding = embResp.data[0].embedding
      } catch (err) {
        console.error(`Failed to embed precedent ${prec.clauseId}`, err)
      }
    }
  }

  cachedPrecedents = rawPrecedents
  return cachedPrecedents
}

export async function queryPrecedents(
  embedding: number[],
  topK = 3,
  sectionTag?: string,
): Promise<Array<{ text: string; sectionTag: string; score: number }>> {
  const precs = await getPrecedentsWithEmbeddings()
  
  const scored = precs
    .filter(p => !sectionTag || p.type.toUpperCase() === sectionTag.toUpperCase())
    .map(p => {
      const score = cosineSimilarity(embedding, p.embedding || [])
      return {
        text: p.text,
        sectionTag: p.type.toUpperCase(),
        score,
      }
    })

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, topK)
}

export async function getChunksByDocId(docId: string): Promise<string[]> {
  runGc()
  const doc = registry[docId]
  if (!doc) return []
  return doc.chunks.map(c => c.text)
}
