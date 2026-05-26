import { geminiClient, CHAT_MODEL, EMBEDDING_MODEL, withRetry } from '../local/geminiClient.js'
import { clauseClassify }                               from '../tools/clauseClassify.js'
import { riskScore }                                    from '../tools/riskScore.js'
import { queryPrecedents }                              from '../local/vectorClient.js'
import { logStep }                                      from '../observability/telemetry.js'
import type { OcrResult }                               from '../types/index.js'

export async function runOrchestrator(
  ocrResult: OcrResult,
  docId:     string,
): Promise<{ clauses: any[]; risks: any[]; summary: string; agentSteps: number }> {
  logStep('Agent Linear Pipeline started', { docId })

  // 1. Clause Classification & Extraction (LLM call 1)
  logStep('Phase 1/3: Extracting and classifying clauses...', { docId })
  const clauses = await clauseClassify(docId)
  logStep('Phase 1/3 Complete: Clauses extracted', { docId, count: clauses.length })

  if (clauses.length === 0) {
    return {
      clauses: [],
      risks: [],
      summary: 'No clauses could be extracted from the document.',
      agentSteps: 1,
    }
  }

  // 2. Local Precedents Lookup (Zero LLM overhead, pure math!)
  logStep('Phase 2/3: Searching standard precedents database...', { docId })
  const precedentsToUse: string[] = []
  
  try {
    // Generate embeddings for all extracted clauses concurrently to match precedents
    const embeddingResponses = await Promise.all(
      clauses.map(clause =>
        withRetry(() =>
          geminiClient.embeddings.create({
            model: EMBEDDING_MODEL,
            input: clause.rawText,
          })
        )
      )
    )

    for (let i = 0; i < clauses.length; i++) {
      const clause = clauses[i]
      const vector = embeddingResponses[i].data[0].embedding
      
      // Query local precedents using cosine similarity
      const matches = await queryPrecedents(vector, 1, clause.type)
      if (matches.length > 0 && matches[0].score > 0.65) {
        precedentsToUse.push(matches[0].text)
      }
    }
  } catch (err) {
    console.error('[Orchestrator] Precedent lookup failed, falling back to empty precedents list', err)
  }

  const uniquePrecedents = Array.from(new Set(precedentsToUse))
  logStep('Phase 2/3 Complete: Precedents matched', { docId, count: uniquePrecedents.length })

  // 3. Risk Scoring (LLM call 2)
  logStep('Phase 3/3: Running risk scoring...', { docId })
  const risks = await riskScore(
    clauses.map(c => ({
      clauseId: c.clauseId,
      sectionId: c.sectionId,
      pageNumber: c.pageNumber,
      type: c.type,
      rawText: c.rawText,
    })),
    'IN',
    uniquePrecedents,
  )
  logStep('Phase 3/3 Complete: Risks flagged', { docId, count: risks.length })

  // 4. Summary Synthesis (LLM call 3 - very fast, low tokens)
  logStep('Synthesizing final executive summary...', { docId })
  const summaryPrompt = `You are a contract summary expert. Generate a concise contract risk executive summary (maximum 800 characters) based on the extracted clauses and identified risk flags.
Do not add any preamble. Keep it extremely brief and high-impact.

Clauses:
${JSON.stringify(clauses.map(c => ({ type: c.type, summary: c.summary })))}

Risk Flags:
${JSON.stringify(risks.map(r => ({ level: r.level, description: r.description })))}`

  let summary = ''
  try {
    const summaryResp = await withRetry(() =>
      geminiClient.chat.completions.create({
        model: CHAT_MODEL,
        messages: [{ role: 'user', content: summaryPrompt }],
        temperature: 0.3,
        max_tokens: 250,
      })
    )
    summary = summaryResp.choices[0].message.content?.trim() || 'Summary unavailable.'
  } catch (err) {
    console.error('[Orchestrator] Summary generation failed, using fallback summary', err)
    summary = `Contract analysis completed. Identified ${clauses.length} clauses and flagged ${risks.length} potential risks.`
  }

  logStep('Agent Linear Pipeline finished successfully', { docId })

  return {
    clauses,
    risks,
    summary: summary.slice(0, 800),
    agentSteps: 2, // Signifies 2 main reasoning cycles (classify & score)
  }
}
