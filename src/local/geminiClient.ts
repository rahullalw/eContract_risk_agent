import 'dotenv/config'
import OpenAI from 'openai'

export const geminiClient = new OpenAI({
  apiKey:  process.env.GEMINI_API_KEY!,
  baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
})

// gemma-3-27b-it — most capable Gemma model, confirmed working via OpenAI-compat endpoint
export const CHAT_MODEL      = process.env.GEMINI_MODEL           ?? 'gemma-3-27b-it'
export const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL ?? 'gemini-embedding-001'
