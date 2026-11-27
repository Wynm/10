import express from 'express';
import { createServer } from 'node:http';
import PubNub from 'pubnub';
import { Ollama } from 'ollama';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const server = createServer(app);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.json({ limit: '1mb' }));

const runtime = { pubnub: null, pubnubConfig: null };
function getPubNub() {
  const { publishKey, subscribeKey, userId } = runtime.pubnubConfig || {};
  if (!publishKey || !subscribeKey) throw new Error('أضف مفاتيح PubNub أولًا من الإعدادات.');
  if (!runtime.pubnub) {
    runtime.pubnub = new PubNub({ publishKey, subscribeKey, userId: userId || 'agent-workbench' });
  }
  return runtime.pubnub;
}
function blocksSettings() {
  const { baseUrl, token } = runtime.blocksConfig || {};
  if (!baseUrl) throw new Error('أضف عنوان واجهة Blocks.ai في الإعدادات.');
  return { baseUrl: baseUrl.replace(/\/$/, ''), token };
}

app.get('/api/status', (_req, res) => res.json({ ollamaUrl: process.env.OLLAMA_HOST || 'http://localhost:11434', pubnub: Boolean(runtime.pubnubConfig?.publishKey && runtime.pubnubConfig?.subscribeKey), blocks: Boolean(runtime.blocksConfig?.baseUrl) }));
app.get('/api/models', async (_req, res) => {
  try { const client = new Ollama({ host: process.env.OLLAMA_HOST || 'http://localhost:11434' }); const data = await client.list(); res.json({ models: data.models.map(m => m.name) }); }
  catch (e) { res.status(503).json({ error: `تعذر الوصول إلى Ollama. تأكد من تشغيله وإتاحة العنوان ${process.env.OLLAMA_HOST || 'http://localhost:11434'}.` }); }
});
app.post('/api/config', (req, res) => {
  const { pubnub, blocks } = req.body || {};
  runtime.pubnub = null;
  runtime.pubnubConfig = pubnub || null;
  runtime.blocksConfig = blocks || null;
  res.json({ ok: true, note: 'تُحفظ الإعدادات في ذاكرة الخادم الحالية فقط، ولا تُكتب إلى ملفات.' });
});
app.post('/api/chat', async (req, res) => {
  const { model, prompt, system = 'أنت وكيل مساعد ضمن فريق متعدد الوكلاء. أجب بوضوح واختصار.', agent = 'وكيل' } = req.body || {};
  if (!model || !prompt) return res.status(400).json({ error: 'اختر نموذجًا واكتب مهمة.' });
  try {
    const client = new Ollama({ host: process.env.OLLAMA_HOST || 'http://localhost:11434' });
    const result = await client.chat({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], stream: false });
    const message = { id: crypto.randomUUID(), agent, model, text: result.message.content, at: new Date().toISOString() };
    if (runtime.pubnubConfig?.publishKey && runtime.pubnubConfig?.subscribeKey) {
      try { await getPubNub().publish({ channel: 'agent-lab', message }); } catch (e) { console.error('PubNub publish failed:', e.message); }
    }
    res.json(message);
  } catch (e) { res.status(502).json({ error: e.message || 'تعذر إكمال الطلب إلى النموذج.' }); }
});
app.post('/api/blocks', async (req, res) => {
  try {
    const { baseUrl, token } = blocksSettings();
    const { path: apiPath = '/api/agents/run', payload = {} } = req.body || {};
    if (!apiPath.startsWith('/') || apiPath.startsWith('//')) return res.status(400).json({ error: 'مسار API غير صالح.' });
    const response = await fetch(`${baseUrl}${apiPath}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(payload), signal: AbortSignal.timeout(30000) });
    const text = await response.text();
    res.status(response.status).type(response.headers.get('content-type') || 'text/plain').send(text);
  } catch (e) { res.status(502).json({ error: `تعذر الاتصال بـ Blocks.ai: ${e.message}` }); }
});

const port = Number(process.env.PORT || 3000);
if (process.env.NODE_ENV === 'production') app.use(express.static(path.resolve(__dirname, '../dist')));
app.get('/{*splat}', (req, res, next) => process.env.NODE_ENV === 'production' ? res.sendFile(path.resolve(__dirname, '../dist/index.html')) : next());
server.listen(port, '0.0.0.0', () => console.log(`Agent Workbench on 0.0.0.0:${port}`));
