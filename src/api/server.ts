import 'dotenv/config'
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeRouter } from './analyzeRoute.js'

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
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

app.use('/api', analyzeRouter)

app.listen(PORT, () => {
  console.log(`✅ Contract OCR Agent → http://localhost:${PORT}`)
  console.log(`   POST /api/analyze`)
  console.log(`   GET  /health`)
})
