/**
 * discoverModels.ts
 * Lists all models available on the Gemini OpenAI-compatible endpoint,
 * then sends a test chat message to each candidate to verify it works.
 */
import 'dotenv/config'
import OpenAI from 'openai'

const client = new OpenAI({
  apiKey:  process.env.GEMINI_API_KEY!,
  baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
})

const TEST_PROMPT = 'Reply with exactly: hello'

async function testChat(modelId: string): Promise<'OK' | string> {
  try {
    const res = await client.chat.completions.create({
      model:       modelId,
      messages:    [{ role: 'user', content: TEST_PROMPT }],
      max_tokens:  16,
      temperature: 0,
    })
    const text = res.choices[0]?.message?.content?.trim() ?? '(empty)'
    return `OK — "${text}"`
  } catch (err: any) {
    // Grab a short reason (status + first line of message)
    const msg: string = err?.message ?? String(err)
    return `FAIL — ${msg.split('\n')[0].slice(0, 120)}`
  }
}

async function main() {
  console.log('Fetching model list from Gemini OpenAI-compatible endpoint…\n')

  let models: OpenAI.Models.Model[] = []
  try {
    const page = await client.models.list()
    for await (const m of page) models.push(m)
  } catch (err: any) {
    console.error('Could not list models:', err?.message ?? err)
    process.exit(1)
  }

  // Sort: gemma first, then gemini, then others
  models.sort((a, b) => {
    const rank = (id: string) => id.startsWith('gemma') ? 0 : id.startsWith('gemini') ? 1 : 2
    return rank(a.id) - rank(b.id) || a.id.localeCompare(b.id)
  })

  console.log(`Found ${models.length} model(s):\n`)
  console.log('  ' + models.map(m => m.id).join('\n  '))

  // Only probe chat-capable candidates (skip embedding / vision-only hints)
  const candidates = models.filter(m =>
    !m.id.includes('embedding') &&
    !m.id.includes('aqa') &&
    !m.id.includes('tts')
  )

  console.log(`\n─── Chat probe (${candidates.length} candidates) ───────────────────────────\n`)

  const results: { id: string; result: string }[] = []

  for (const m of candidates) {
    process.stdout.write(`  ${m.id.padEnd(40)} … `)
    const result = await testChat(m.id)
    console.log(result)
    results.push({ id: m.id, result })
  }

  const working = results.filter(r => r.result.startsWith('OK'))
  const gemma   = working.filter(r => r.id.includes('gemma'))

  console.log('\n─── Summary ────────────────────────────────────────────────────────────\n')
  console.log(`Working models (${working.length}):`)
  working.forEach(r => console.log(`  ✓ ${r.id}`))

  if (gemma.length) {
    console.log(`\n✅ Gemma model(s) available — recommended GEMINI_MODEL:`)
    gemma.forEach(r => console.log(`     ${r.id}`))
  } else {
    const best = working.find(r => r.id.includes('flash-lite')) 
              ?? working.find(r => r.id.includes('flash'))
              ?? working[0]
    console.log(`\n⚪ No Gemma models found. Best available non-Gemma chat model:`)
    if (best) console.log(`     ${best.id}`)
  }
}

main().catch(err => { console.error(err); process.exit(1) })
