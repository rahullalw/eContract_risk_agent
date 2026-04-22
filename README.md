# eContract Risk Agent

A local-first AI agent that analyses contract PDFs and returns a structured risk report. Built with Node.js, TypeScript, Gemini, ChromaDB, and Express.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ / TypeScript 5.8 |
| LLM | Gemini 2.5 Flash (via OpenAI-compatible endpoint) |
| Embeddings | `gemini-embedding-001` (3072-d) |
| Vector Store | ChromaDB (local Docker) |
| OCR | `pdf-parse` (text-layer PDFs) |
| API | Express 5 |
| Validation | Zod |
| Logging | Pino |

---

## Prerequisites

- **Node.js** 20+
- **Docker** (for ChromaDB)
- **Gemini API key** → [Get one here](https://aistudio.google.com/app/apikey)

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in your key:

```env
GEMINI_API_KEY=your-key-here
```

### 3. Start ChromaDB

```bash
docker run -d --name chroma -p 8000:8000 chromadb/chroma
```

Verify it's running:

```bash
curl http://localhost:8000/api/v1/heartbeat
```

### 4. Start the server

```bash
npm run dev
```

Server starts at `http://localhost:3000`.

---

## API

### `GET /health`

```bash
curl http://localhost:3000/health
```

```json
{ "status": "ok", "timestamp": "2026-04-22T04:59:30.615Z" }
```

---

### `POST /api/analyze`

Accepts a PDF upload and returns a structured risk report.

**Request** — `multipart/form-data`, field name: `contract`

```bash
# bash / Git Bash
curl -X POST http://localhost:3000/api/analyze \
  -F "contract=@sample-nda.pdf"
```

```powershell
# PowerShell
$form = @{ contract = Get-Item .\sample-nda.pdf }
Invoke-RestMethod -Method POST -Uri http://localhost:3000/api/analyze -Form $form | ConvertTo-Json -Depth 5
```

**Response `200`**

```json
{
  "docId": "3fa8b2c1-...",
  "analysedAt": "2026-04-22T05:00:00.000Z",
  "pages": 4,
  "ocrConfidence": 1,
  "clauses": [
    {
      "clauseId": "liability-1",
      "type": "liability",
      "rawText": "...",
      "sectionId": "§ 12",
      "pageNumber": 3,
      "summary": "Unlimited liability clause with no cap."
    }
  ],
  "risks": [
    {
      "clauseId": "liability-1",
      "sectionId": "§ 12",
      "pageNumber": 3,
      "level": "critical",
      "description": "No liability cap exposes the party to unlimited financial risk.",
      "recommendation": "Negotiate a liability cap at 12 months fees."
    }
  ],
  "summary": "This NDA presents CRITICAL risk due to an unlimited liability clause...",
  "agentSteps": 4,
  "disclaimer": "This report is AI-generated. It is not legal advice. Verify all findings with a qualified lawyer.",
  "_meta": {
    "coveVerified": true,
    "coveIssues": [],
    "durationMs": 8432
  }
}
```

**Error responses**

| Scenario | Status | Body |
|---|---|---|
| No file / wrong field | `400` | `{ "error": "No PDF uploaded..." }` |
| Non-PDF / PII in filename / too large | `422` | `{ "error": "Input validation failed", "details": [...] }` |
| Scanned PDF with no text layer | `422` | `{ "error": "OCR quality too low", "confidence": 0 }` |
| Agent loop hit safety limit | `500` | `{ "error": "Agent loop exceeded safety limits" }` |
| Output schema violation | `500` | `{ "error": "Output validation failed", "issues": [...] }` |

---

## NPM Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled production build |
| `npm run typecheck` | Type-check without emitting |
| `npm run test:ocr` | Phase 2 — OCR smoke test |
| `npm run test:p3` | Phase 3 — Embedding + Chroma round-trip test |
| `npm run test:p4` | Phase 4 — Guardrails unit tests + agent pipeline |

---

## Project Structure

```
src/
├── api/
│   ├── server.ts           — Express server entry point
│   └── analyzeRoute.ts     — POST /api/analyze handler
├── agent/
│   ├── orchestrator.ts     — ReAct agent loop
│   ├── toolRegistry.ts     — OpenAI function-calling schemas
│   └── prompts.ts          — System prompt
├── guardrails/
│   ├── inputGuardrail.ts   — File validation, PII/injection scan
│   ├── loopGuardrail.ts    — Iteration cap, token budget, circular call detection
│   └── outputGuardrail.ts  — Zod schema enforcement, content policy, CoVe
├── local/
│   ├── geminiClient.ts     — Gemini via OpenAI-compatible SDK
│   ├── chromaClient.ts     — ChromaDB upsert / query
│   ├── localStorage.ts     — Local file save/read
│   └── ocrLocal.ts         — pdf-parse text extraction
├── tools/
│   ├── chunkAndEmbed.ts    — Split OCR text → embed → upsert Chroma
│   ├── vectorSearch.ts     — Semantic search tool
│   ├── clauseClassify.ts   — LLM clause extraction tool
│   └── riskScore.ts        — LLM risk scoring tool
├── observability/
│   └── telemetry.ts        — Pino structured logger
├── test/
│   ├── ocrTest.ts          — Phase 2 smoke test
│   ├── phase3Test.ts       — Phase 3 smoke test
│   └── phase4Test.ts       — Phase 4 smoke test
└── types/
    └── index.ts            — Single source of truth for all Zod schemas and interfaces
```

---

## Pipeline Overview

```
POST /api/analyze
  │
  ├─ 1. Input Guardrail    — file type, size, PII, injection patterns
  ├─ 2. Save to disk       — ./uploads/<docId>/<filename>
  ├─ 3. OCR               — pdf-parse extracts text layer
  ├─ 4. Chunk + Embed     — split → gemini-embedding-001 → ChromaDB
  ├─ 5. ReAct Agent Loop  — Gemini 2.5 Flash
  │       clause_classify → vector_search → risk_score
  ├─ 6. Output Schema     — Zod enforces report structure
  ├─ 7. Content Policy    — blocks advisory/prescriptive language
  └─ 8. CoVe Verify       — confirms cited sections exist in contract text
```

---

## Disclaimer

All reports generated by this system are AI-generated and **not legal advice**. Always verify findings with a qualified lawyer.
