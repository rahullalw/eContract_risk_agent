import 'dotenv/config'
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeRouter } from './analyzeRoute.js'
import { jobsRouter } from './jobsRoute.js'

const app  = express()
const PORT = Number(process.env.PORT ?? 3000)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const publicDir = path.resolve(__dirname, '../../public')

app.use(express.json())
app.use(express.static(publicDir))

app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  next()
})

app.get('/health', (_req, res) => {
  const mem = process.memoryUsage()
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    memory: {
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      rssMB: Math.round(mem.rss / 1024 / 1024),
    },
  })
})

app.use('/api', analyzeRouter)
app.use('/api', jobsRouter)

app.listen(PORT, () => {
  const mem = process.memoryUsage()
  console.log('')
  console.log('╔══════════════════════════════════════════════════════╗')
  console.log('║        eContract Risk Agent — MVP Server            ║')
  console.log('╚══════════════════════════════════════════════════════╝')
  console.log(`  → http://localhost:${PORT}`)
  console.log('')
  console.log('  Endpoints:')
  console.log('    POST /api/analyze                 Upload & analyze contract')
  console.log('    GET  /api/jobs/:id/stream          SSE progress stream')
  console.log('    GET  /api/jobs/:id                 Job status (poll)')
  console.log('    GET  /api/queue-stats              Concurrency queue info')
  console.log('    GET  /api/history                  Past analyses & reports')
  console.log('    GET  /api/reports/:filename        Download saved report')
  console.log('    GET  /health                       Health check + memory')
  console.log('')
  console.log(`  Memory: ${Math.round(mem.heapUsed / 1024 / 1024)} MB heap used / ${Math.round(mem.rss / 1024 / 1024)} MB RSS`)
  console.log('')
})
