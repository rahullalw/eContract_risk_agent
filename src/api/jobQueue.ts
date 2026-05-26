import { randomUUID } from 'crypto'
import type { Response } from 'express'

// ── Configuration ────────────────────────────────────────────────────────────
const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS ?? 3)
const JOB_TTL_MS = 30 * 60 * 1000  // 30 minutes
const GC_INTERVAL_MS = 5 * 60 * 1000 // Run GC every 5 minutes

// ── Types ────────────────────────────────────────────────────────────────────
export type JobStep = 'queued' | 'ocr' | 'embedding' | 'analysis' | 'verifying' | 'completed' | 'failed'

export interface JobState {
  jobId: string
  status: 'pending' | 'queued' | 'processing' | 'completed' | 'failed'
  step: JobStep
  progress: number
  message: string
  result?: any
  createdAt: number
  completedAt?: number
  queuePosition?: number
}

interface JobListener {
  res: Response
}

// ── In-Memory State ──────────────────────────────────────────────────────────
const jobs: Record<string, JobState> = {}
const listeners: Record<string, Set<JobListener>> = {}

// ── Concurrency Semaphore ────────────────────────────────────────────────────
let activeJobCount = 0
const waitingQueue: Array<{ jobId: string; resolve: () => void }> = []

export async function acquireSlot(jobId: string): Promise<void> {
  if (activeJobCount < MAX_CONCURRENT_JOBS) {
    activeJobCount++
    return
  }

  // Queue this job and wait
  const position = waitingQueue.length + 1
  updateJob(jobId, {
    status: 'queued',
    step: 'queued',
    progress: 0,
    message: `You're #${position} in the queue. Analysis will begin shortly.`,
    queuePosition: position,
  })

  return new Promise<void>((resolve) => {
    waitingQueue.push({ jobId, resolve })
  })
}

export function releaseSlot(): void {
  activeJobCount = Math.max(0, activeJobCount - 1)

  if (waitingQueue.length > 0) {
    const next = waitingQueue.shift()!
    activeJobCount++

    // Update remaining queue positions
    waitingQueue.forEach((item, idx) => {
      updateJob(item.jobId, {
        queuePosition: idx + 1,
        message: `You're #${idx + 1} in the queue. Analysis will begin shortly.`,
      })
    })

    next.resolve()
  }
}

export function getQueueStats(): { active: number; queued: number; maxConcurrent: number } {
  return {
    active: activeJobCount,
    queued: waitingQueue.length,
    maxConcurrent: MAX_CONCURRENT_JOBS,
  }
}

// ── Job CRUD ─────────────────────────────────────────────────────────────────
export function createJob(): string {
  const jobId = `job-${randomUUID()}`
  jobs[jobId] = {
    jobId,
    status: 'pending',
    step: 'ocr',
    progress: 0,
    message: 'Queued analysis request...',
    createdAt: Date.now(),
  }
  listeners[jobId] = new Set()
  return jobId
}

export function getJob(jobId: string): JobState | null {
  return jobs[jobId] || null
}

export function updateJob(jobId: string, updates: Partial<JobState>) {
  const job = jobs[jobId]
  if (!job) return

  Object.assign(job, updates)

  // Mark completion timestamp
  if (updates.status === 'completed' || updates.status === 'failed') {
    job.completedAt = Date.now()
  }

  // Broadcast to SSE listeners
  const jobListeners = listeners[jobId]
  if (jobListeners) {
    const payload = JSON.stringify(job)
    const deadListeners: JobListener[] = []
    for (const listener of jobListeners) {
      try {
        listener.res.write(`data: ${payload}\n\n`)
      } catch {
        deadListeners.push(listener)
      }
    }
    // Clean up dead connections
    for (const dead of deadListeners) {
      jobListeners.delete(dead)
    }
  }
}

export function addJobListener(jobId: string, res: Response): JobListener | null {
  if (!jobs[jobId]) return null

  const listener: JobListener = { res }
  listeners[jobId].add(listener)

  // Send initial state immediately
  res.write(`data: ${JSON.stringify(jobs[jobId])}\n\n`)

  return listener
}

export function removeJobListener(jobId: string, listener: JobListener) {
  const jobListeners = listeners[jobId]
  if (jobListeners) {
    jobListeners.delete(listener)
  }
}

// ── Job TTL Garbage Collection ───────────────────────────────────────────────
function cleanupExpiredJobs() {
  const now = Date.now()
  let cleaned = 0

  for (const jobId of Object.keys(jobs)) {
    const job = jobs[jobId]

    // Only clean up completed or failed jobs past TTL
    if (
      (job.status === 'completed' || job.status === 'failed') &&
      job.completedAt &&
      now - job.completedAt > JOB_TTL_MS
    ) {
      // Close any lingering SSE connections
      const jobListeners = listeners[jobId]
      if (jobListeners) {
        for (const listener of jobListeners) {
          try { listener.res.end() } catch { /* ignore */ }
        }
      }

      delete jobs[jobId]
      delete listeners[jobId]
      cleaned++
    }
  }

  if (cleaned > 0) {
    console.log(`[JobQueue GC] Cleaned up ${cleaned} expired job(s)`)
  }
}

// Start periodic GC
setInterval(cleanupExpiredJobs, GC_INTERVAL_MS)

// ── List all jobs (for history) ──────────────────────────────────────────────
export function listJobs(): JobState[] {
  return Object.values(jobs).sort((a, b) => b.createdAt - a.createdAt)
}
