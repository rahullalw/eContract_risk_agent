import 'dotenv/config'
import { Router, type Request, type Response } from 'express'
import multer from 'multer'
import { randomUUID } from 'crypto'

import { runInputGuardrail }   from '../guardrails/inputGuardrail.js'
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
import { logSpan }             from '../observability/telemetry.js'

const upload = multer({
  storage:    multer.memoryStorage(),
  limits:     { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype === 'application/pdf'),
})

export const analyzeRouter = Router()

analyzeRouter.post('/analyze', upload.single('contract'), async (req: Request, res: Response): Promise<void> => {
  const start = Date.now()

  if (!req.file) {
    res.status(400).json({ error: 'No PDF uploaded. Use field name "contract".' })
    return
  }

  const guard = runInputGuardrail(req.file.originalname, req.file.mimetype, req.file.size)
  if (!guard.ok) {
    res.status(422).json({ error: 'Input validation failed', details: guard.errors })
    return
  }

  try {
    const { docId, filePath } = await saveContractLocally(req.file.buffer, req.file.originalname)
    const ocr = await ocrLocal(req.file.buffer)

    if (ocr.confidence < 0.7) {
      res.status(422).json({
        error:      'OCR quality too low',
        confidence: ocr.confidence,
        warnings:   ocr.warnings,
      })
      return
    }

    await chunkAndEmbed(ocr, docId)

    const raw    = await runOrchestrator(ocr, docId)
    const report = enforceOutputSchema(raw, ocr, docId)

    contentPolicyFilter(report.summary)

    const cove = await runCoVeVerification(report, ocr.text)
    if (!cove.verified) {
      console.warn('[CoVe] Unverified citations:', cove.issues)
    }

    await logSpan({
      tool:       'full_pipeline',
      durationMs: Date.now() - start,
      meta: {
        docId,
        filePath,
        pages:      ocr.pages,
        clauses:    report.clauses.length,
        risks:      report.risks.length,
        agentSteps: report.agentSteps,
      },
    })

    res.status(200).json({
      ...report,
      _meta: { coveVerified: cove.verified, coveIssues: cove.issues, durationMs: Date.now() - start },
    })
  } catch (err) {
    if (err instanceof LoopGuardrailError) {
      res.status(500).json({ error: 'Agent loop exceeded safety limits', detail: err.message })
      return
    }
    if (err instanceof OutputGuardrailError) {
      res.status(500).json({ error: 'Output validation failed', issues: err.issues })
      return
    }
    console.error('[analyzeRoute]', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
