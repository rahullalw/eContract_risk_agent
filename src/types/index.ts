import { z } from 'zod'


export const AnalyzeRequestSchema = z.object({
  filename:  z.string().min(1).max(255),
  mimeType:  z.literal('application/pdf'),
  sizeBytes: z.number().max(20 * 1024 * 1024), // 20 MB hard cap
})
export type AnalyzeRequest = z.infer<typeof AnalyzeRequestSchema>


export interface OcrResult {
  text:       string
  pages:      number
  confidence: number    // 0–1, average across pages (1.0 for text-layer PDFs)
  tables:     OcrTable[]
  warnings:   string[]
}

export interface OcrTable {
  pageNumber: number
  rows:       string[][]
}


export interface TextChunk {
  chunkId:    string
  docId:      string
  text:       string
  sectionTag: string    // e.g. "TERMINATION", "PAYMENT", "GENERAL"
  embedding?: number[]  // 768-dimensional (Gemini text-embedding-004)
}


export const ClauseTypeSchema = z.enum([
  'termination', 'liability', 'indemnification',
  'ip_ownership', 'confidentiality', 'payment',
  'dispute_resolution', 'force_majeure', 'governing_law', 'other',
])
export type ClauseType = z.infer<typeof ClauseTypeSchema>

export const RiskLevelSchema = z.enum(['critical', 'high', 'medium', 'low'])
export type RiskLevel = z.infer<typeof RiskLevelSchema>

export const ClauseSchema = z.object({
  clauseId:   z.string(),
  type:        ClauseTypeSchema,
  rawText:     z.string(),
  sectionId:   z.string(),   // e.g. "§ 12.3" — must come from contract text
  pageNumber:  z.number(),
  summary:     z.string().max(300),
})
export type Clause = z.infer<typeof ClauseSchema>

export const RiskFlagSchema = z.object({
  clauseId:       z.string(),
  sectionId:      z.string(),   // MUST match a clause's sectionId
  pageNumber:     z.number(),
  level:          RiskLevelSchema,
  description:    z.string().max(400),
  precedent:      z.string().nullable().optional(),
  recommendation: z.string().max(300),
})
export type RiskFlag = z.infer<typeof RiskFlagSchema>


export const AnalysisReportSchema = z.object({
  docId:         z.string(),
  analysedAt:    z.string().datetime(),
  pages:         z.number(),
  ocrConfidence: z.number(),
  clauses:       z.array(ClauseSchema),
  risks:         z.array(RiskFlagSchema),
  summary:       z.string().max(800),
  agentSteps:    z.number(),
  disclaimer: z.literal(
    'This report is AI-generated. It is not legal advice. Verify all findings with a qualified lawyer.'
  ),
})
export type AnalysisReport = z.infer<typeof AnalysisReportSchema>


export interface AgentMessage {
  role:          'system' | 'user' | 'assistant' | 'tool'
  content:       string
  tool_call_id?: string
  name?:         string
}

export interface ToolCall {
  id:   string
  name: string
  args: Record<string, unknown>
}

export interface AgentState {
  docId:          string
  messages:       AgentMessage[]
  iterationCount: number
  tokenUsed:      number
  stepHashes:     Set<string>
}
