import { geminiClient, CHAT_MODEL } from '../local/geminiClient.js';
import { TOOL_DEFINITIONS } from '../agent/toolRegistry.js';
async function run() {
  try {
    const res = await geminiClient.chat.completions.create({
      model: CHAT_MODEL,
      messages: [{role: 'user', content: 'Say hello'}],
      tools: TOOL_DEFINITIONS,
      tool_choice: 'auto'
    });
    console.log(res.choices[0].message);
  } catch (error: any) {
    if (error.status === 400) {
      console.log('400 Error headers:', error.headers);
      console.log('400 Error error detail:', JSON.stringify(error.error, null, 2));
      console.log('400 Full error:', error.message);
    }
  }
}
run();
