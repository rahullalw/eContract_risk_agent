import fs   from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'

const UPLOAD_DIR = process.env.LOCAL_UPLOAD_DIR ?? './uploads'

export interface StoredFile {
  filePath: string
  docId:    string
}

/**
 * Persists the PDF buffer to LOCAL_UPLOAD_DIR/<uuid>/<filename>.
 * Returns the absolute file path and a unique docId.
 */
export async function saveContractLocally(
  buffer:   Buffer,
  filename: string,
): Promise<StoredFile> {
  const docId    = randomUUID()
  const dir      = path.resolve(UPLOAD_DIR, docId)
  const filePath = path.join(dir, filename)

  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(filePath, buffer)

  return { filePath, docId }
}

/**
 * Reads a previously saved contract buffer from disk.
 */
export async function readContractBuffer(filePath: string): Promise<Buffer> {
  return fs.readFile(filePath)
}
