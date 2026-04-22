import 'dotenv/config'
import OpenAI from 'openai'

export const geminiClient = new OpenAI({
  apiKey:  process.env.GEMINI_API_KEY!,
  baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
})

export const CHAT_MODEL      = process.env.GEMINI_MODEL           ?? 'gemini-2.5-flash'
export const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL ?? 'gemini-embedding-001'
