import { geminiClient, EMBEDDING_MODEL } from '../local/geminiClient.js'
import { upsertChunks }                  from '../local/chromaClient.js'
import type { TextChunk, OcrResult }     from '../types/index.js'

function detectSectionTag(text: string): string {
  const u = text.toUpperCase()
  if (u.includes('TERMINAT'))   return 'TERMINATION'
  if (u.includes('LIABILIT'))   return 'LIABILITY'
  if (u.includes('INDEMNIF'))   return 'INDEMNIFICATION'
  if (u.includes('INTELLECTUAL')) return 'IP_OWNERSHIP'
  if (u.includes('CONFIDENTIAL')) return 'CONFIDENTIALITY'
  if (u.includes('PAYMENT') || u.includes('INVOIC')) return 'PAYMENT'
  if (u.includes('DISPUTE') || u.includes('ARBITRAT')) return 'DISPUTE'
  if (u.includes('FORCE MAJEURE')) return 'FORCE_MAJEURE'
  return 'GENERAL'
}

function splitIntoChunks(text: string, maxTokens = 400): string[] {
  const maxChars   = maxTokens * 4
  const paragraphs = text.split(/\n{2,}/)
  const chunks: string[] = []
  let current = ''

  for (const para of paragraphs) {
    if ((current + para).length > maxChars && current) {
      chunks.push(current.trim())
      current = para
    } else {
      current += '\n\n' + para
    }
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks.filter(c => c.length > 20)
}

export async function chunkAndEmbed(ocrResult: OcrResult, docId: string): Promise<TextChunk[]> {
  const rawChunks = splitIntoChunks(ocrResult.text)
  const chunks: TextChunk[] = []

  for (let i = 0; i < rawChunks.length; i++) {
    const text = rawChunks[i]
    const embResp = await geminiClient.embeddings.create({ model: EMBEDDING_MODEL, input: text })
    chunks.push({
      chunkId:    `${docId}-chunk-${i}`,
      docId,
      text,
      sectionTag: detectSectionTag(text),
      embedding:  embResp.data[0].embedding,
    })
  }

  await upsertChunks(chunks)
  return chunks
}
