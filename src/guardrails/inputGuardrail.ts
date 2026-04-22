import { AnalyzeRequestSchema } from '../types/index.js'

const PII_PATTERNS = [
  /\b\d{10,12}\b/,
  /\b[6-9]\d{9}\b/,
  /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i,
]

const INJECTION_PATTERNS = [
  /ignore\s+(previous|above|all)\s+instructions/i,
  /system\s*prompt/i,
  /you\s+are\s+(now|a|an)/i,
  /\[INST\]|\[\/INST\]/,
  /<\|im_start\|>|<\|im_end\|>/,
]

export interface InputGuardrailResult {
  ok:     boolean
  errors: string[]
}

export function runInputGuardrail(
  filename:  string,
  mimeType:  string,
  sizeBytes: number,
): InputGuardrailResult {
  const errors: string[] = []

  const parsed = AnalyzeRequestSchema.safeParse({ filename, mimeType, sizeBytes })
  if (!parsed.success) {
    errors.push(...parsed.error.issues.map(i => i.message))
  }

  if (!filename.toLowerCase().endsWith('.pdf')) {
    errors.push('Only PDF files are accepted')
  }

  if (PII_PATTERNS.find(p => p.test(filename))) {
    errors.push('Filename appears to contain PII — rename before upload')
  }

  if (INJECTION_PATTERNS.find(p => p.test(filename))) {
    errors.push('Filename contains a potentially malicious instruction pattern')
  }

  return { ok: errors.length === 0, errors }
}

const CONTENT_PII_PATTERNS: [RegExp, string][] = [
  [/\b[A-Z]{5}\d{4}[A-Z]\b/g,    '[PAN_REDACTED]'],
  [/\b\d{4}\s?\d{4}\s?\d{4}\b/g, '[AADHAAR_REDACTED]'],
  [/\b[6-9]\d{9}\b/g,             '[PHONE_REDACTED]'],
]

export function redactPiiFromText(text: string): string {
  let clean = text
  for (const [pattern, replacement] of CONTENT_PII_PATTERNS) {
    clean = clean.replace(pattern, replacement)
  }
  return clean
}
