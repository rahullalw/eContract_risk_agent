import { Router, type Request, type Response } from 'express'
import { getJob, addJobListener, removeJobListener } from './jobQueue.js'

export const jobsRouter = Router()

/** Safely extract a single string param from Express 5's params */
function param(req: Request, name: string): string {
  const val = req.params[name]
  return Array.isArray(val) ? val[0] : val
}

// ── SSE Progress Stream ──────────────────────────────────────────────────────
jobsRouter.get('/jobs/:jobId/stream', (req: Request, res: Response): void => {
  const jobId = param(req, 'jobId')

  const job = getJob(jobId)
  if (!job) {
    res.status(404).json({ error: `Job ${jobId} not found` })
    return
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no') // Disable nginx buffering
  res.flushHeaders()

  const listener = addJobListener(jobId, res)

  // Handle client disconnect
  req.on('close', () => {
    if (listener) {
      removeJobListener(jobId, listener)
    }
    res.end()
  })
})

// ── Job Status (poll fallback) ───────────────────────────────────────────────
jobsRouter.get('/jobs/:jobId', (req: Request, res: Response): void => {
  const jobId = param(req, 'jobId')
  const job = getJob(jobId)
  if (!job) {
    res.status(404).json({ error: `Job ${jobId} not found` })
    return
  }
  res.json(job)
})

// ── History (stub — reports are stored client-side in IndexedDB) ─────────────
// Kept for backward compatibility; always returns empty to avoid exposing
// one user's reports to another. Browser-side IndexedDB is the source of truth.
jobsRouter.get('/history', (_req: Request, res: Response): void => {
  res.json({ activeJobs: [], savedReports: [] })
})
