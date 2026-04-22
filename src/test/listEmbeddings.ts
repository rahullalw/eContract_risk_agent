import { geminiClient } from '../local/geminiClient.js';
async function run() {
  const models = await geminiClient.models.list();
  const embedModels = models.data.filter(m => m.id.includes('embed'));
  console.log('Embedding models:');
  embedModels.forEach(m => console.log(m.id));
}
run().catch(console.error);
