import { geminiClient, EMBEDDING_MODEL } from '../local/geminiClient.js'
import { upsertChunks, queryChroma }     from '../local/chromaClient.js'
import { chunkAndEmbed }                 from '../tools/chunkAndEmbed.js'
import { ocrLocal }                      from '../local/ocrLocal.js'
import { readFile, access }              from 'fs/promises'
import { randomUUID }                    from 'crypto'

async function testEmbedding() {
  console.log('\n--- Embedding smoke test ---')
  const resp = await geminiClient.embeddings.create({
    model: EMBEDDING_MODEL,
    input: 'This contract includes an unlimited liability clause.',
  })
  const len = resp.data[0].embedding.length
  console.log(`Embedding length: ${len}`)
  if (len !== 3072) {
    console.error(`FAIL: expected 3072, got ${len}`)
    process.exit(1)
  }
  console.log('PASS: embedding length is 3072')
}

async function testChromaRoundTrip() {
  console.log('\n--- Chroma round-trip test ---')
  const testChunkId = `test-chunk-${randomUUID()}`
  const sampleText  = 'Liability shall be unlimited under this agreement.'

  const embResp = await geminiClient.embeddings.create({ model: EMBEDDING_MODEL, input: sampleText })
  const embedding = embResp.data[0].embedding

  await upsertChunks([{
    chunkId:    testChunkId,
    docId:      'test-doc',
    text:       sampleText,
    sectionTag: 'LIABILITY',
    embedding,
  }])
  console.log('Upserted 1 chunk to Chroma')

  const queryEmb = await geminiClient.embeddings.create({ model: EMBEDDING_MODEL, input: 'unlimited liability' })
  const results  = await queryChroma(queryEmb.data[0].embedding, 1)

  if (!results.length || results[0].score < 0.5) {
    console.error('FAIL: no result or score too low')
    process.exit(1)
  }
  console.log(`Query matched section ${results[0].sectionTag} with score ${results[0].score.toFixed(3)}`)
  console.log('PASS: retrieved expected chunk')
}

async function testChunkAndEmbedPipeline() {
  console.log('\n--- chunkAndEmbed pipeline test ---')
  const testFile = './sample-nda.pdf'
  try {
    await access(testFile)
  } catch {
    console.log('SKIP: sample-nda.pdf not found, skipping pipeline test')
    return
  }

  const buf    = await readFile(testFile)
  const ocr    = await ocrLocal(buf)
  const docId  = randomUUID()

  console.log(`OCR pages: ${ocr.pages}`)
  console.log(`OCR confidence: ${Math.round(ocr.confidence * 100)}%`)
  const chunks = await chunkAndEmbed(ocr, docId)
  console.log(`PASS: embedded ${chunks.length} chunk(s) into Chroma`)
}

async function main() {
  console.log('=== Phase 3 Smoke Tests ===')
  try {
    await testEmbedding()
    await testChromaRoundTrip()
    await testChunkAndEmbedPipeline()
    console.log('\nAll Phase 3 tests passed')
  } catch (err) {
    console.error('\nTest failed:', err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

main()
