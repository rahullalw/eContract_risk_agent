import { geminiClient, CHAT_MODEL }                    from '../local/geminiClient.js'
import { SYSTEM_PROMPT }                                from './prompts.js'
import { TOOL_DEFINITIONS }                             from './toolRegistry.js'
import { clauseClassify }                               from '../tools/clauseClassify.js'
import { vectorSearch }                                 from '../tools/vectorSearch.js'
import { riskScore }                                    from '../tools/riskScore.js'
import { checkLoopGuardrail, LoopGuardrailError, CircularToolCallError }       from '../guardrails/loopGuardrail.js'
import { logSpan, logStep }                             from '../observability/telemetry.js'
import type { AgentState, ToolCall, OcrResult }         from '../types/index.js'

async function dispatchTool(call: ToolCall, state: AgentState): Promise<unknown> {
  const a = call.args as Record<string, unknown>
  switch (call.name) {
    case 'clause_classify':
      return clauseClassify(state.docId, a['clauseTypes'] as string[] | undefined)
    case 'vector_search':
      return vectorSearch(
        a['query'] as string,
        (a['topK'] as number | undefined) ?? 3,
        a['sectionTag'] as string | undefined,
      )
    case 'risk_score':
      return riskScore(
        a['clauses'] as Parameters<typeof riskScore>[0],
        (a['jurisdiction'] as string | undefined) ?? 'IN',
        (a['precedents'] as string[] | undefined) ?? []
      )
    default:
      throw new Error(`Unknown tool: ${call.name}`)
  }
}

function safeParseJson(content: string): { clauses: unknown[]; risks: unknown[]; summary: string } | null {
  const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    return null
  }
}

function summarizeToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => {
      if (Array.isArray(value)) return [key, `${value.length} item${value.length === 1 ? '' : 's'}`]
      if (typeof value === 'string') return [key, value]
      if (typeof value === 'object' && value !== null) return [key, 'provided']
      return [key, value]
    }),
  )
}

function summarizeToolResult(result: unknown): Record<string, unknown> {
  if (Array.isArray(result)) return { results: result.length }
  if (typeof result === 'object' && result !== null) {
    const record = result as Record<string, unknown>
    if (Array.isArray(record['clauses'])) return { clauses: record['clauses'].length }
    if (Array.isArray(record['risks'])) return { risks: record['risks'].length }
    if (record['error']) return { error: record['error'] }
  }
  return {}
}

export async function runOrchestrator(
  ocrResult: OcrResult,
  docId:     string,
): Promise<{ clauses: unknown[]; risks: unknown[]; summary: string; agentSteps: number }> {
  const state: AgentState = {
    docId,
    iterationCount: 0,
    tokenUsed:      0,
    stepHashes:     new Set(),
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          `Analyse this contract. Document ID: ${docId}`,
          `Pages: ${ocrResult.pages} | OCR confidence: ${(ocrResult.confidence * 100).toFixed(1)}%`,
          ocrResult.warnings.length ? `OCR warnings: ${ocrResult.warnings.join('; ')}` : '',
          `Contract text preview (first 1500 chars):\n${ocrResult.text.slice(0, 1500)}`,
          '\nProceed step by step using the available tools.',
        ].filter(Boolean).join('\n'),
      },
    ],
  }

  logStep('Agent initialized', {
    docId,
    pages:      ocrResult.pages,
    confidence: `${Math.round(ocrResult.confidence * 100)}%`,
  })

  while (true) {
    state.iterationCount++
    logStep('Agent reasoning step started', { docId, step: state.iterationCount })

    const completion = await geminiClient.chat.completions.create({
      model:       CHAT_MODEL,
      messages:    state.messages as Parameters<typeof geminiClient.chat.completions.create>[0]['messages'],
      tools:       TOOL_DEFINITIONS,
      tool_choice: 'auto',
      temperature: 0,
    })

    if (completion.usage) {
      state.tokenUsed += completion.usage.total_tokens ?? 0
    }
    logStep('Agent model response received', {
      docId,
      step:   state.iterationCount,
      tokens: state.tokenUsed,
    })

    const msg = completion.choices[0].message
    state.messages.push(msg as any)

    // ── Final answer ─────────────────────────────────────────────────────────
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      const parsed = safeParseJson(msg.content ?? '')

      if (!parsed) {
        logStep('Agent final response was not valid JSON; asking once for clean report', {
          docId,
          step: state.iterationCount,
        }, 'warn')
        state.messages.push({ role: 'user', content: 'Output ONLY the JSON report now.' })
        state.iterationCount++
        const retry = await geminiClient.chat.completions.create({
          model:       CHAT_MODEL,
          messages:    state.messages as Parameters<typeof geminiClient.chat.completions.create>[0]['messages'],
          temperature: 0,
        })
        const retryParsed = safeParseJson(retry.choices[0].message.content ?? '{}')
        logStep('Agent retry response parsed', {
          docId,
          step:    state.iterationCount,
          clauses: retryParsed?.clauses.length ?? 0,
          risks:   retryParsed?.risks.length ?? 0,
        })
        return {
          clauses:    retryParsed?.clauses    ?? [],
          risks:      retryParsed?.risks      ?? [],
          summary:    retryParsed?.summary    ?? 'Analysis incomplete.',
          agentSteps: state.iterationCount,
        }
      }

      logStep('Agent final report parsed', {
        docId,
        step:    state.iterationCount,
        clauses: parsed.clauses.length,
        risks:   parsed.risks.length,
      })
      return { ...parsed, agentSteps: state.iterationCount }
    }

    // ── Tool calls ───────────────────────────────────────────────────────────
    for (const tc of msg.tool_calls.filter(t => t.type === 'function')) {
      // After the filter, TypeScript still doesn't narrow automatically — cast to access .function
      const fn   = (tc as Extract<typeof tc, { type: 'function' }>).function
      let args: Record<string, unknown>
      try { args = JSON.parse(fn.arguments) } catch { args = {} }
      logStep('Agent requested tool', {
        docId,
        step: state.iterationCount,
        tool: fn.name,
        ...summarizeToolArgs(args),
      })

      const start = Date.now()
      let result: unknown
      let toolError: string | null = null

      try {
        checkLoopGuardrail(state, fn.name, fn.arguments)
        result = await dispatchTool({ id: tc.id, name: fn.name, args }, state)
      } catch (err) {
        if (err instanceof LoopGuardrailError) throw err
        toolError = err instanceof Error ? err.message : String(err)
        result    = { error: toolError }
      }

      await logSpan({
        tool:       fn.name,
        durationMs: Date.now() - start,
        meta:       {
          docId,
          iteration: state.iterationCount,
          ...summarizeToolResult(result),
          error: toolError ?? undefined,
        },
      })

      state.messages.push({
        role:         'tool',
        content:      JSON.stringify(result),
        tool_call_id: tc.id,
        name:         fn.name,
      })
    }

  }
}
