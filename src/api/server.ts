import 'dotenv/config'
import express from 'express'
import { analyzeRouter } from './analyzeRoute.js'

const app  = express()
const PORT = Number(process.env.PORT ?? 3000)

app.use(express.json())

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
