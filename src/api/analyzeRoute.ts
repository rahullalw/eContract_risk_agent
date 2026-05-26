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

// Import queue, caching, and concurrency systems
import { createJob, updateJob, acquireSlot, releaseSlot, getQueueStats } from './jobQueue.js'
import { getFileHash, getCachedReport, cacheReport } from '../local/reportCache.js'

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype === 'application/pdf'),
})

export const analyzeRouter = Router()

// ── Queue stats endpoint ─────────────────────────────────────────────────────
analyzeRouter.get('/queue-stats', (_req: Request, res: Response) => {
  res.json(getQueueStats())
})

// ── Main analysis endpoint ───────────────────────────────────────────────────
analyzeRouter.post('/analyze', upload.single('contract'), async (req: Request, res: Response): Promise<void> => {
  if (!req.file) {
    res.status(400).json({ error: 'No PDF uploaded. Use field name "contract".' })
    return
  }

  logStep('File received', {
    file:   req.file.originalname,
    sizeMb: req.file.size / (1024 * 1024),
  })

  // 1. Input Guardrails Check
  const guard = runInputGuardrail(req.file.originalname, req.file.mimetype, req.file.size)
  if (!guard.ok) {
    res.status(422).json({ error: 'Input validation failed', details: guard.errors })
    return
  }

  const fileBuffer = req.file.buffer
  const filename = req.file.originalname

  // 2. Check Content-Hash Cache
  const fileHash = getFileHash(fileBuffer)
  const cachedReport = getCachedReport(fileHash)
  if (cachedReport) {
    logStep('Cache Hit: Returning cached report instantly', { filename, fileHash })
    res.status(200).json({
      ...cachedReport,
      _meta: {
        ...(cachedReport as any)._meta,
        cached: true,
        fileHash,
      },
    })
    return
  }

  // 3. Create Async Job
  const jobId = createJob()
  const queueStats = getQueueStats()

  // 4. Return 202 Accepted instantly to prevent timeouts
  res.status(202).json({
    jobId,
    status: 'pending',
    streamUrl: `/api/jobs/${jobId}/stream`,
    message: queueStats.active >= queueStats.maxConcurrent
      ? `Analysis queued. You are #${queueStats.queued + 1} in the queue.`
      : 'Contract analysis started successfully in the background.',
  })

  // 5. Run pipeline asynchronously in background thread
  setImmediate(async () => {
    const start = Date.now()
    logStep('Background job waiting for slot', { jobId, fileHash })

    try {
      // Wait for a concurrency slot (queues if busy)
      await acquireSlot(jobId)
      logStep('Background job acquired slot', { jobId })

      // Step: OCR
      updateJob(jobId, { status: 'processing', step: 'ocr', progress: 10, message: 'Ingesting and saving contract copy...' })
      const { docId } = await saveContractLocally(fileBuffer, filename)

      updateJob(jobId, { step: 'ocr', progress: 20, message: 'Running OCR text extraction...' })
      const ocr = await ocrLocal(fileBuffer)

      if (ocr.confidence < 0.7) {
        logStep('OCR quality too low', { docId, confidence: ocr.confidence }, 'warn')
        updateJob(jobId, {
          status: 'failed',
          step: 'failed',
          message: `OCR quality too low (${Math.round(ocr.confidence * 100)}%). Warnings: ${ocr.warnings.join('; ')}`,
        })
        return
      }

      // Step: Embedding
      updateJob(jobId, { step: 'embedding', progress: 35, message: 'Creating semantic chunk mappings...' })
      const chunks = await chunkAndEmbed(ocr, docId)

      // Step: Analysis
      updateJob(jobId, { step: 'analysis', progress: 55, message: 'Extracting contract clauses...' })
      // Granular sub-steps will be broadcast via SSE
      const raw = await runOrchestrator(ocr, docId)

      updateJob(jobId, { step: 'analysis', progress: 75, message: 'Scoring risk flags against legal precedents...' })

      // Step: Verifying
      updateJob(jobId, { step: 'verifying', progress: 85, message: 'Enforcing legal safety filters...' })
      const report = enforceOutputSchema(raw, ocr, docId)
      contentPolicyFilter(report.summary)

      updateJob(jobId, { step: 'verifying', progress: 90, message: 'Running Chain-of-Verification (CoVe) citations check...' })
      const cove = await runCoVeVerification(report, ocr.text)

      const finalReport = {
        ...report,
        _meta: {
          coveVerified: cove.verified,
          coveIssues: cove.issues,
          durationMs: Date.now() - start,
          fileHash,
          cached: false,
        },
      }

      // Cache the report
      cacheReport(fileHash, finalReport as any)

      // Update job to completed
      updateJob(jobId, {
        status: 'completed',
        step: 'completed',
        progress: 100,
        message: 'Contract risk analysis successfully complete!',
        result: finalReport,
      })

      logStep('Background job completed successfully', { jobId, docId, durationMs: Date.now() - start })
    } catch (err: any) {
      logStep('Background job failed', { jobId, error: err instanceof Error ? err.message : String(err) }, 'error')

      let errorMsg = 'An unexpected internal error occurred during analysis.'
      if (err instanceof LoopGuardrailError) {
        errorMsg = `Agent loop exceeded safety limits: ${err.message}`
      } else if (err instanceof OutputGuardrailError) {
        errorMsg = `Output validation failed: ${err.issues.join(' | ')}`
      } else if (err instanceof Error) {
        errorMsg = err.message
      }

      updateJob(jobId, {
        status: 'failed',
        step: 'failed',
        message: errorMsg,
      })
    } finally {
      releaseSlot()
    }
  })
})
