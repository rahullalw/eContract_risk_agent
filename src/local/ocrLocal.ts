import pdfParse from 'pdf-parse'
import type { OcrResult } from '../types/index.js'

const CONFIDENCE_THRESHOLD = Number(
  process.env.OCR_CONFIDENCE_THRESHOLD ?? 0.70
)

/**
 * Extracts text from a PDF buffer using pdf-parse (local, no cloud).
 * Confidence is always 1.0 for digital/text-layer PDFs.
 * For scanned PDFs, integrate tesseract.js and compute real confidence.
 */
export async function ocrLocal(buffer: Buffer): Promise<OcrResult> {
  let data: any

  try {
    data = await pdfParse(buffer)
  } catch (err) {
    throw new Error(
      `PDF parse failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  const text  = data.text ?? ''
  const pages = data.numpages ?? 1

  if (!text.trim()) {
    // Scanned PDF — no text layer found
    return {
      text:       '',
      pages,
      confidence: 0,
      tables:     [],
      warnings:   ['No text layer found — document may be scanned. OCR skipped.'],
    }
  }

  // Rough quality signal: avg word length (very short = garbled text)
  const words    = text.split(/\s+/).filter(Boolean)
  const avgLen   = words.reduce((s: number, w: string) => s + w.length, 0) / (words.length || 1)
  const confidence = avgLen < 2 ? 0.5 : 1.0   // heuristic only

  const warnings: string[] = []
  if (confidence < CONFIDENCE_THRESHOLD) {
    warnings.push(`Low text quality detected (avg word length ${avgLen.toFixed(1)})`)
  }

  return {
    text,
    pages,
    confidence,
    tables:   [],   // DEMO: table extraction skipped (pdf-parse doesn't extract tables)
    warnings,
  }
}
