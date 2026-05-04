import 'dotenv/config'
import { Router, type Request, type Response } from 'express'
import multer from 'multer'

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
import { logStep }             from '../observability/telemetry.js'
import { saveOutput }          from '../local/outputSaver.js'

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype === 'application/pdf'),
})

export const analyzeRouter = Router()

analyzeRouter.post('/analyze', upload.single('contract'), async (req: Request, res: Response): Promise<void> => {
  const start = Date.now()

  if (!req.file) {
    res.status(400).json({ error: 'No PDF uploaded. Use field name "contract".' })
    return
  }

  logStep('File received', {
    file:   req.file.originalname,
    sizeMb: req.file.size / (1024 * 1024),
  })

  const guard = runInputGuardrail(req.file.originalname, req.file.mimetype, req.file.size)
  if (!guard.ok) {
    res.status(422).json({ error: 'Input validation failed', details: guard.errors })
    return
  }

  try {
    const { docId } = await saveContractLocally(req.file.buffer, req.file.originalname)

    logStep('OCR started', { docId })
    const ocr = await ocrLocal(req.file.buffer)
    logStep('OCR finished', {
      docId,
      pages:      ocr.pages,
      confidence: `${Math.round(ocr.confidence * 100)}%`,
      warnings:   ocr.warnings.length,
    })

    if (ocr.confidence < 0.7) {
      logStep('OCR stopped: quality too low', {
        docId,
        confidence: `${Math.round(ocr.confidence * 100)}%`,
        warnings:   ocr.warnings.join('; '),
      }, 'warn')
      res.status(422).json({
        error:      'OCR quality too low',
        confidence: ocr.confidence,
        warnings:   ocr.warnings,
      })
      return
    }

    logStep('Embedding started', { docId })
    const chunks = await chunkAndEmbed(ocr, docId)
    logStep('Embedding finished', { docId, chunks: chunks.length })

    logStep('Agent analysis started', { docId })
    const raw = await runOrchestrator(ocr, docId)
    logStep('Agent analysis finished', {
      docId,
      steps:   raw.agentSteps,
      clauses: raw.clauses.length,
      risks:   raw.risks.length,
    })

    const report = enforceOutputSchema(raw, ocr, docId)

    contentPolicyFilter(report.summary)

    logStep('Citation verification started', { docId })
    const cove = await runCoVeVerification(report, ocr.text)
    if (!cove.verified) {
      logStep('Citation verification found issues', {
        docId,
        issues: cove.issues.length,
        first:  cove.issues[0],
      }, 'warn')
    } else {
      logStep('Citation verification passed', { docId })
    }

    const savedPath = await saveOutput(
      { ...report, _meta: { coveVerified: cove.verified, coveIssues: cove.issues } },
      docId,
      'report',
    )

    logStep('Pipeline finished', {
      docId,
      savedPath,
      pages:      ocr.pages,
      clauses:    report.clauses.length,
      risks:      report.risks.length,
      agentSteps: report.agentSteps,
      durationMs: Date.now() - start,
    })

    res.status(200).json({
      ...report,
      _meta: { coveVerified: cove.verified, coveIssues: cove.issues, durationMs: Date.now() - start },
    })
  } catch (err) {
    if (err instanceof LoopGuardrailError) {
      logStep('Analyze request failed: agent loop guardrail', { detail: err.message }, 'error')
      res.status(500).json({ error: 'Agent loop exceeded safety limits', detail: err.message })
      return
    }
    if (err instanceof OutputGuardrailError) {
      logStep('Analyze request failed: output validation', { issues: err.issues.length }, 'error')
      res.status(500).json({ error: 'Output validation failed', issues: err.issues })
      return
    }
    logStep('Analyze request failed unexpectedly', {
      error: err instanceof Error ? err.message : String(err),
    }, 'error')
    res.status(500).json({ error: 'Internal server error' })
  }
})
