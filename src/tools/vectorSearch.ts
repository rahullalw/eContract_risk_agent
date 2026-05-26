import { geminiClient, EMBEDDING_MODEL, withRetry } from '../local/geminiClient.js'
import { queryPrecedents }                          from '../local/vectorClient.js'

export async function vectorSearch(
  query:      string,
  topK        = 3,
  sectionTag?: string,
): Promise<Array<{ text: string; sectionTag: string; score: number }>> {
  // Generate embedding for the query
  const embResp = await withRetry(() =>
    geminiClient.embeddings.create({ model: EMBEDDING_MODEL, input: query })
  )
  
  // Search standard precedents database
  const results = await queryPrecedents(embResp.data[0].embedding, topK, sectionTag)

  return results
}
