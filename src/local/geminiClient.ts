import 'dotenv/config'
import OpenAI from 'openai'

export const geminiClient = new OpenAI({
  apiKey:  process.env.GEMINI_API_KEY!,
  baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
})

// gemma-3-27b-it — most capable Gemma model, confirmed working via OpenAI-compat endpoint
export const CHAT_MODEL      = process.env.GEMINI_MODEL           ?? 'gemma-3-27b-it'
export const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL ?? 'gemini-embedding-001'

// Rate-limit retry-with-backoff wrapper
export async function withRetry<T>(fn: () => Promise<T>, maxRetries = 4): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err: any) {
      // Catch Gemini API rate-limiting errors (429 / RESOURCE_EXHAUSTED)
      const status = err?.status
      const msg = err?.message || ''
      if (status === 429 || msg.includes('429') || msg.toLowerCase().includes('quota') || msg.toLowerCase().includes('rate limit')) {
        const delay = Math.pow(2, attempt) * 1500 + Math.random() * 500
        console.warn(`[Gemini Rate Limit] 429 received. Retrying attempt ${attempt + 1}/${maxRetries} in ${delay.toFixed(0)}ms...`)
        await new Promise((r) => setTimeout(r, delay))
        continue
      }
      throw err
    }
  }
  throw new Error('Max rate-limit retries exceeded. The server is under heavy load.')
}

