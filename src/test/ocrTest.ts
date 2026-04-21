import { readFile, access } from 'fs/promises'
import { ocrLocal } from '../local/ocrLocal.js'

async function runTest() {
  const testFile = './sample-nda.pdf'
  
  try {
    await access(testFile)
  } catch {
    console.error(`Error: Test file "${testFile}" not found.`)
    console.log('Please place a PDF file named "sample-nda.pdf" in the root directory to run this test.')
    process.exit(1)
  }

  const buf = await readFile(testFile)
  const result = await ocrLocal(buf)

  console.log('OCR Test Result:', JSON.stringify({
    pages:      result.pages,
    confidence: result.confidence,
    preview:    result.text.slice(0, 200).replace(/\n/g, ' '),
    warnings:   result.warnings,
  }, null, 2))
}

runTest().catch(console.error)
