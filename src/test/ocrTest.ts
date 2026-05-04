import { readFile, access } from 'fs/promises'
import { ocrLocal } from '../local/ocrLocal.js'

async function runTest() {
  const testFile = './sample-nda.pdf'

  try {
    await access(testFile)
  } catch {
    console.error(`Error: Test file "${testFile}" not found.`)
    console.log('Place sample-nda.pdf in the project root to run this test.')
    process.exit(1)
  }

  const buf = await readFile(testFile)
  const result = await ocrLocal(buf)
  const preview = result.text.slice(0, 200).replace(/\s+/g, ' ').trim()

  console.log('OCR test complete')
  console.log(`Pages: ${result.pages}`)
  console.log(`Confidence: ${Math.round(result.confidence * 100)}%`)
  console.log(`Warnings: ${result.warnings.length}`)
  if (preview) console.log(`Preview: ${preview}`)
}

runTest().catch(console.error)
