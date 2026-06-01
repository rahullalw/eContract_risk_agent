import 'dotenv/config'
import { Router, type Request, type Response } from 'express'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

import { ocrLocal }            from '../local/ocrLocal.js'
import { saveContractLocally } from '../local/localStorage.js'
import { chunkAndEmbed }       from '../tools/chunkAndEmbed.js'
import { runOrchestrator }     from '../agent/orchestrator.js'
import {
  enforceOutputSchema,
  contentPolicyFilter,
  runCoVeVerification,
  OutputGuardrailError,
} from '../guardrails/outputGuardrail.js'
import { LoopGuardrailError }  from '../guardrails/loopGuardrail.js'
import { logStep }             from '../observability/telemetry.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_PDF_PATH  = path.resolve(__dirname, '../../sample-nda.pdf')
const SAMPLE_JSON_PATH = path.resolve(__dirname, '../../public/sample-nda-result.json')

export const sampleRouter = Router()

sampleRouter.get('/sample-analysis', async (req: Request, res: Response): Promise<void> => {
  const start = Date.now()
  logStep('Sample NDA request received', { exists: fs.existsSync(SAMPLE_JSON_PATH) })

  try {
    // 1. Check if cache file exists
    if (fs.existsSync(SAMPLE_JSON_PATH)) {
      logStep('Cache Hit: Returning cached sample NDA analysis report')
      const cached = JSON.parse(fs.readFileSync(SAMPLE_JSON_PATH, 'utf8'))
      res.json({
        ...cached,
        _meta: {
          ...cached._meta,
          cached: true,
        },
      })
      return
    }

    logStep('Cache Miss: Running real AI pipeline on sample-nda.pdf')

    // 2. Read sample-nda.pdf buffer
    if (!fs.existsSync(SAMPLE_PDF_PATH)) {
      res.status(404).json({ error: `Sample NDA PDF file not found at ${SAMPLE_PDF_PATH}` })
      return
    }
    const fileBuffer = fs.readFileSync(SAMPLE_PDF_PATH)
    const filename = 'sample-nda.pdf'

    // Step: OCR
    logStep('Sample NDA Pipeline: Running OCR')
    const { docId } = await saveContractLocally(fileBuffer, filename)
    const ocr = await ocrLocal(fileBuffer)

    if (ocr.confidence < 0.7) {
      logStep('OCR quality too low for sample NDA', { docId, confidence: ocr.confidence }, 'warn')
      res.status(422).json({
        error: `OCR quality too low (${Math.round(ocr.confidence * 100)}%). Warnings: ${ocr.warnings.join('; ')}`,
      })
      return
    }

    // Step: Embedding
    logStep('Sample NDA Pipeline: Running Chunk and Embed')
    await chunkAndEmbed(ocr, docId)

    // Step: Analysis (run orchestrator)
    logStep('Sample NDA Pipeline: Running Orchestrator Agent')
    const raw = await runOrchestrator(ocr, docId)

    // Step: Verifying (output schema & content policy & CoVe)
    logStep('Sample NDA Pipeline: Enforcing Legal Safety Filters')
    const report = enforceOutputSchema(raw, ocr, docId)
    contentPolicyFilter(report.summary)

    logStep('Sample NDA Pipeline: Chain-of-Verification check')
    const cove = await runCoVeVerification(report, ocr.text)

    const finalReport = {
      ...report,
      _meta: {
        coveVerified: cove.verified,
        coveIssues: cove.issues,
        durationMs: Date.now() - start,
        cached: false,
        generatedAt: new Date().toISOString(),
      },
    }

    // 3. Persist to disk for all future requests
    fs.mkdirSync(path.dirname(SAMPLE_JSON_PATH), { recursive: true })
    fs.writeFileSync(SAMPLE_JSON_PATH, JSON.stringify(finalReport, null, 2), 'utf8')
    logStep('Sample NDA Pipeline: Success. Generated and saved sample-nda-result.json')

    res.json({
      ...finalReport,
      _meta: {
        ...finalReport._meta,
        cached: false,
      },
    })
  } catch (err: any) {
    logStep('Sample NDA analysis failed', { error: err instanceof Error ? err.message : String(err) }, 'error')

    let errorMsg = 'An unexpected internal error occurred during sample NDA analysis.'
    if (err instanceof LoopGuardrailError) {
      errorMsg = `Agent loop exceeded safety limits: ${err.message}`
    } else if (err instanceof OutputGuardrailError) {
      errorMsg = `Output validation failed: ${err.issues.join(' | ')}`
    } else if (err instanceof Error) {
      errorMsg = err.message
    }

    res.status(500).json({ error: errorMsg })
  }
})
