import { geminiClient } from '../local/geminiClient.js';

async function run() {
  try {
    const res2 = await geminiClient.embeddings.create({
      model: 'text-embedding-004',
      input: 'test',
    });
    console.log('text-embedding-004:', res2.data[0].embedding.length);
  } catch(e: any) {
    console.error('text-embedding-004 failed:', e.message);
  }

  try {
    const res1 = await geminiClient.embeddings.create({
      model: 'gemini-embedding-001',
      input: 'test',
    });
    console.log('gemini-embedding-001:', res1.data[0].embedding.length);
  } catch(e: any) {
    console.error('gemini-embedding-001 failed:', e.message);
  }

  try {
    const res2 = await geminiClient.embeddings.create({
      model: 'gemini-embedding-2-preview',
      input: 'test',
    });
    console.log('gemini-embedding-2-preview:', res2.data[0].embedding.length);
  } catch(e: any) {
    console.error('gemini-embedding-2-preview failed:', e.message);
  }
}
run();
