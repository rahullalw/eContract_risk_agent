import { geminiClient, EMBEDDING_MODEL } from '../local/geminiClient.js'
import { queryChroma }                    from '../local/chromaClient.js'

export async function vectorSearch(
  query:      string,
  topK        = 3,
  sectionTag?: string,
): Promise<Array<{ text: string; sectionTag: string; score: number }>> {
  const embResp = await geminiClient.embeddings.create({ model: EMBEDDING_MODEL, input: query })
  const results = await queryChroma(embResp.data[0].embedding, topK)

  return sectionTag
    ? results.filter(r => r.sectionTag === sectionTag)
    : results
}
