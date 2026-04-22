import { geminiClient, CHAT_MODEL } from '../local/geminiClient.js'
import { getChunksByDocId }          from '../local/chromaClient.js'
import type { Clause }               from '../types/index.js'

export async function clauseClassify(
  docId:        string,
  clauseTypes?: string[],
): Promise<Clause[]> {
  const chunks = await getChunksByDocId(docId)
  if (chunks.length === 0) return []

  const typeList = clauseTypes?.join(', ') ?? 'all clause types'

  const systemPrompt = `You are a contract clause extractor.
Return ONLY valid JSON: { "clauses": [ { "clauseId": string, "type": string, "rawText": string, "sectionId": string, "pageNumber": number, "summary": string } ] }
Rules:
- sectionId MUST be the actual section heading from the text (e.g. "§ 12", "Article 5.2"). Do NOT invent sections.
- clauseId: short slug like "liability-1".
- type: one of termination, liability, indemnification, ip_ownership, confidentiality, payment, dispute_resolution, force_majeure, governing_law, other.
- summary: ≤ 300 characters.`

  const resp = await geminiClient.chat.completions.create({
    model:           CHAT_MODEL,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: `Extract ${typeList} clauses from:\n\n${chunks.join('\n\n---\n\n')}` },
    ],
    temperature: 0,
  })

  try {
    const parsed = JSON.parse(resp.choices[0].message.content ?? '{"clauses":[]}')
    return parsed.clauses ?? []
  } catch {
    return []
  }
}
