import { geminiClient, CHAT_MODEL }     from '../local/geminiClient.js'
import { AnalysisReportSchema }          from '../types/index.js'
import type { AnalysisReport, OcrResult } from '../types/index.js'

const DISCLAIMER = 'This report is AI-generated. It is not legal advice. Verify all findings with a qualified lawyer.'

export class OutputGuardrailError extends Error {
  constructor(public issues: string[]) {
    super(`[OutputGuardrail] ${issues.join(' | ')}`)
    this.name = 'OutputGuardrailError'
  }
}

export function enforceOutputSchema(
  raw:       { clauses: unknown[]; risks: unknown[]; summary: string; agentSteps: number },
  ocrResult: OcrResult,
  docId:     string,
): AnalysisReport {
  const candidate = {
    docId,
    analysedAt:    new Date().toISOString(),
    pages:         ocrResult.pages,
    ocrConfidence: ocrResult.confidence,
    clauses:       raw.clauses,
    risks:         raw.risks,
    summary:       raw.summary,
    agentSteps:    raw.agentSteps,
    disclaimer:    DISCLAIMER,
  }

  const parsed = AnalysisReportSchema.safeParse(candidate)
  if (!parsed.success) {
    throw new OutputGuardrailError(
      parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`)
    )
  }
  return parsed.data
}

const BLOCKED_PATTERNS = [
  /you\s+should\s+sign\s+this/i,
  /i\s+recommend\s+you\s+accept/i,
  /this\s+contract\s+is\s+(safe|fine|ok)/i,
]

export function contentPolicyFilter(summary: string): void {
  for (const p of BLOCKED_PATTERNS) {
    if (p.test(summary)) {
      throw new OutputGuardrailError(['Summary contains prohibited advisory language'])
    }
  }
}

export async function runCoVeVerification(
  report:  AnalysisReport,
  ocrText: string,
): Promise<{ verified: boolean; issues: string[] }> {
  if (report.risks.length === 0) return { verified: true, issues: [] }

  const prompt = `You are a contract report verifier.
Check each risk flag: does the cited sectionId actually appear in the contract text?
Return ONLY valid JSON: { "verified": boolean, "issues": string[] }

RISK FLAGS:
${JSON.stringify(report.risks.map(r => ({ clauseId: r.clauseId, sectionId: r.sectionId, pageNumber: r.pageNumber })))}

CONTRACT TEXT (first 6000 chars):
${ocrText.slice(0, 6000)}`

  try {
    const resp = await geminiClient.chat.completions.create({
      model:           CHAT_MODEL,
      response_format: { type: 'json_object' },
      messages:        [{ role: 'user', content: prompt }],
      temperature:     0,
      max_tokens:      512,
    })
    return JSON.parse(resp.choices[0].message.content ?? '{"verified":true,"issues":[]}')
  } catch {
    return { verified: false, issues: ['CoVe verification failed'] }
  }
}
