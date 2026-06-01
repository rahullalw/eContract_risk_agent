import { geminiClient, CHAT_MODEL, withRetry } from '../local/geminiClient.js'
import type { RiskFlag, Clause }    from '../types/index.js'

export async function riskScore(
  clauses:     Pick<Clause, 'clauseId' | 'sectionId' | 'pageNumber' | 'type' | 'rawText'>[],
  jurisdiction = 'IN',
  precedents:  string[] = [],
): Promise<RiskFlag[]> {
  if (clauses.length === 0) return []

  const systemPrompt = `You are a contract risk analyst.
Return ONLY valid JSON: { "risks": [ { "clauseId": string, "sectionId": string, "pageNumber": number, "level": string, "description": string, "precedent": string, "recommendation": string } ] }
Rules:
- level: one of critical, high, medium, low.
- sectionId and pageNumber MUST match the input exactly.
- precedent: REQUIRED. Always provide a short (1-2 sentence) industry-standard benchmark clause or phrasing that represents best-practice protection for this clause type. Never return null.
- description ≤ 400 chars. recommendation ≤ 300 chars.
- Jurisdiction: ${jurisdiction}.`

  const resp = await withRetry(() =>
    geminiClient.chat.completions.create({
      model:           CHAT_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role:    'user',
          content: `Clauses:\n${JSON.stringify(clauses, null, 2)}\n\nPrecedents:\n${
            precedents.length ? precedents.join('\n---\n') : '(none)'
          }`,
        },
      ],
      temperature: 0,
    })
  )

  try {
    const parsed = JSON.parse(resp.choices[0].message.content ?? '{"risks":[]}')
    return parsed.risks ?? []
  } catch {
    return []
  }
}
