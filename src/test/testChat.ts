import { geminiClient, CHAT_MODEL } from '../local/geminiClient.js'
import { TOOL_DEFINITIONS } from '../agent/toolRegistry.js'

async function run() {
  try {
    const res = await geminiClient.chat.completions.create({
      model: CHAT_MODEL,
      messages: [{ role: 'user', content: 'Say hello' }],
      tools: TOOL_DEFINITIONS,
      tool_choice: 'auto',
    })
    const msg = res.choices[0].message
    console.log('Chat probe complete')
    console.log(`Role: ${msg.role}`)
    console.log(`Content: ${msg.content ?? '(no text content)'}`)
    console.log(`Tool calls: ${msg.tool_calls?.length ?? 0}`)
  } catch (error: any) {
    if (error.status === 400) {
      console.log('Chat probe failed with 400')
      console.log(`Message: ${error.message}`)
      console.log(`Error type: ${error.error?.type ?? 'unknown'}`)
      return
    }
    throw error
  }
}

run()
