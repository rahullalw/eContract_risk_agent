import pino from 'pino'

const logger = pino({
  level:     process.env.LOG_LEVEL ?? 'info',
  transport: process.env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
})

export interface SpanMeta {
  tool:       string
  durationMs: number
  meta?:      Record<string, unknown>
}

export async function logSpan(s: SpanMeta): Promise<void> {
  const level = s.meta?.['error'] ? 'warn' : 'info'
  logger[level](
    { tool: s.tool, durationMs: s.durationMs, ...s.meta },
    `tool:${s.tool} completed in ${s.durationMs}ms`,
  )
}
