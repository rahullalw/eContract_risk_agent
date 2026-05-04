export interface SpanMeta {
  tool:       string
  durationMs: number
  meta?:      Record<string, unknown>
}

type LogLevel = 'info' | 'warn' | 'error'

const LEVEL_LABEL: Record<LogLevel, string> = {
  info:  'INFO',
  warn:  'WARN',
  error: 'ERROR',
}

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '')
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return 'unknown time'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatValue(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2)
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'string') {
    const compact = value.replace(/\s+/g, ' ').trim()
    return compact.length > 90 ? `${compact.slice(0, 87)}...` : compact
  }
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`
  if (typeof value === 'object') return 'details available'
  return String(value)
}

function formatMeta(meta?: Record<string, unknown>): string {
  if (!meta) return ''

  const parts = Object.entries(meta)
    .map(([key, value]) => {
      const formatted = formatValue(value)
      return formatted ? `${key}=${formatted}` : null
    })
    .filter(Boolean)

  return parts.length ? ` (${parts.join(', ')})` : ''
}

export function logStep(message: string, meta?: Record<string, unknown>, level: LogLevel = 'info'): void {
  const line = `[${timestamp()}] ${LEVEL_LABEL[level]} ${message}${formatMeta(meta)}`

  if (level === 'error') {
    console.error(line)
  } else if (level === 'warn') {
    console.warn(line)
  } else {
    console.log(line)
  }
}

export async function logSpan(s: SpanMeta): Promise<void> {
  const hasError = Boolean(s.meta?.['error'])
  logStep(
    `${s.tool} finished in ${formatDuration(s.durationMs)}`,
    s.meta,
    hasError ? 'warn' : 'info',
  )
}
