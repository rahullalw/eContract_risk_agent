import { ChromaClient } from 'chromadb'
import type { TextChunk } from '../types/index.js'

const chroma     = new ChromaClient({ path: process.env.CHROMA_URL ?? 'http://localhost:8000' })
const COLLECTION = process.env.CHROMA_COLLECTION ?? 'contracts'

async function getCollection() {
  return chroma.getOrCreateCollection({ name: COLLECTION })
}

export async function upsertChunks(chunks: TextChunk[]): Promise<void> {
  if (chunks.length === 0) return
  const col = await getCollection()
  await col.upsert({
    ids:        chunks.map(c => c.chunkId),
    documents:  chunks.map(c => c.text),
    embeddings: chunks.map(c => c.embedding!),
    metadatas:  chunks.map(c => ({ docId: c.docId, sectionTag: c.sectionTag })),
  })
}

export async function queryChroma(
  embedding: number[],
  topK = 3,
  sectionTag?: string,
): Promise<Array<{ text: string; sectionTag: string; score: number }>> {
  const col = await getCollection()
  const queryParams: any = {
    queryEmbeddings: [embedding],
    nResults:        topK,
  }
  
  if (sectionTag) {
    queryParams.where = { sectionTag }
  }

  const res = await col.query(queryParams)

  const docs      = res.documents[0]   ?? []
  const metas     = res.metadatas[0]   ?? []
  const distances = res.distances?.[0] ?? []

  return docs.map((doc, i) => ({
    text:       doc ?? '',
    sectionTag: (metas[i] as Record<string, string>)?.sectionTag ?? 'GENERAL',
    score:      1 - (distances[i] ?? 0),
  }))
}

export async function getChunksByDocId(docId: string): Promise<string[]> {
  const col = await getCollection()
  const res = await col.get({ where: { docId } })
  return res.documents.filter((d): d is string => d !== null)
}
