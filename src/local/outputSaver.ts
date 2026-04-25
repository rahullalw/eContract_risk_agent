import fs   from 'fs/promises'
import path from 'path'

const OUTPUT_DIR = process.env.OUTPUT_DIR ?? './output'

/**
 * Saves any JSON-serialisable payload to:
 *   output/<label>_<docId>_<timestamp>.json
 *
 * Creates OUTPUT_DIR if it doesn't exist.
 * Safe to call from both the API route and the test suite.
 */
export async function saveOutput(
  payload: unknown,
  docId:   string,
  label    = 'report',
): Promise<string> {
  await fs.mkdir(OUTPUT_DIR, { recursive: true })

  const ts       = new Date().toISOString().replace(/[:.]/g, '-')
  const filename = `${label}_${docId.slice(0, 8)}_${ts}.json`
  const filePath = path.resolve(OUTPUT_DIR, filename)

  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8')
  return filePath
}
