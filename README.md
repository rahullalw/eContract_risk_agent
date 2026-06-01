# eContract Risk Agent

A local-first AI agent that analyzes PDF contracts, extracts clauses, maps risks, and suggests professional counter-proposals. Built with an asynchronous pipeline, concurrency queue, caching engine, and a dashboard frontend.

---

## Features

- **Async Pipeline & SSE Progress**: Uploads return `202 Accepted` immediately and run in the background, with real-time Server-Sent Events progress streaming to the client.
- **Concurrency Queue**: Built-in semaphore limits parallel jobs (`MAX_CONCURRENT_JOBS`) and queues excess requests gracefully.
- **Content-Hash Caching**: SHA-256 hashes the PDF text layer — duplicate uploads get an instant cached response with no AI calls.
- **AI Clause Refiner (Copilot)**: Drafts balanced, professional counter-proposals for risky clauses via `POST /api/refine`.
- **Sample NDA Onboarding**: `GET /api/sample-analysis` runs the full pipeline on a bundled NDA and caches the result for instant repeat visits.
- **Local-First Privacy**: ChromaDB and uploaded files stay on your machine. Client history is stored in browser IndexedDB.
- **Triple-Layer Guardrails**: PII/injection scanning (input), iteration cap / token budget / loop detection (loop), Zod schema + content policy + Chain-of-Verification (output).

---

## Tech Stack

| Layer | Technology |
| :--- | :--- |
| Runtime | Node.js 20+ / TypeScript 5.8 |
| Framework | Express 5 |
| LLM | Gemini 2.5 Flash (OpenAI-compatible endpoint) |
| Embeddings | `gemini-embedding-001` (3072-d) |
| Vector DB | ChromaDB (local Docker) |
| OCR | `pdf-parse` (text-layer PDFs) |
| Validation | Zod |
| Logging | Pino |

---

## Setup

### Prerequisites
- Node.js 20+
- Docker (for ChromaDB)
- Gemini API key → [Get one here](https://aistudio.google.com/app/apikey)

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

### 4. Start the server
```bash
npm run dev
```
Server starts at `http://localhost:3000`.

---

## API

| Method | Path | Description |
| :--- | :--- | :--- |
| `GET` | `/health` | Server health + memory usage |
| `POST` | `/api/analyze` | Upload a PDF → returns `jobId` + `streamUrl` |
| `GET` | `/api/jobs/:jobId/stream` | SSE stream of live progress events |
| `POST` | `/api/refine` | Draft an AI counter-proposal for a clause |
| `GET` | `/api/sample-analysis` | Run (or serve cached) analysis of the bundled sample NDA |

### `POST /api/analyze`

```bash
curl -X POST http://localhost:3000/api/analyze -F "contract=@sample-nda.pdf"
```

**202 Response**
```json
{
  "jobId": "job-d3b07384d113",
  "status": "pending",
  "streamUrl": "/api/jobs/job-d3b07384d113/stream"
}
```

Then connect to the `streamUrl` to receive SSE progress events until `status: "completed"` with the full report in `result`.

### `POST /api/refine`

```json
{
  "clauseText": "The Receiving Party shall indemnify... without limitation.",
  "riskDescription": "No liability cap poses unlimited exposure.",
  "userInstructions": "Add a standard cap at 12 months fees."
}
```

**Response**
```json
{ "revisedText": "The Receiving Party's maximum aggregate liability..." }
```

---

## NPM Scripts

| Command | Description |
| :--- | :--- |
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled production build |
| `npm run typecheck` | Type-check without emitting |
| `npm run test:ocr` | OCR smoke test |
| `npm run test:p3` | Embedding + Chroma round-trip test |
| `npm run test:p4` | Guardrails unit tests + agent pipeline |
