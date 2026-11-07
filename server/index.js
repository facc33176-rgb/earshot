// Earshot server: serves the call page and relays to the model, the voice and the transcriber.
// No database, no accounts. Conversation history lives in the browser for the length of the call.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadEnv, config } = require('./config');
const { systemPrompt, idleNote, MAYBE_UNFINISHED } = require('./prompt');
const { streamChat } = require('./llm');
const hedge = require('./hedge');
const { filter } = require('./tags');
const { createTts } = require('./tts');
const { transcribe } = require('./stt');
const { createFillers } = require('./fillers');

function createServer(cfg, { fetcher = fetch } = {}) {
  const tts = createTts(cfg, fetcher);
  const fillers = createFillers(cfg, tts);
  const WEB = path.join(cfg.root, 'web');
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };

  const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const body = (req, limit = 25 * 1024 * 1024) => new Promise((ok, no) => {
    const parts = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { no(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else parts.push(c); });
    req.on('end', () => ok(Buffer.concat(parts))); req.on('error', no);
  });
  const authed = req => !cfg.accessToken || (req.headers.authorization || '') === `Bearer ${cfg.accessToken}`;

  async function turn(req, res) {
    const p = JSON.parse((await body(req, 2 * 1024 * 1024)).toString() || '{}');
    const history = Array.isArray(p.history) ? p.history.filter(m => m && /^(user|assistant)$/.test(m.role) && typeof m.content === 'string').slice(-40) : [];
    let text = String(p.text || '').slice(0, 4000);
    if (p.idle) text = idleNote(Number(p.idle) || 1, !!p.night);
    else if (p.mayContinue) text += MAYBE_UNFINISHED;
    const messages = [{ role: 'system', content: systemPrompt(cfg, { tags: tts.expressive() }) }, ...history, { role: 'user', content: text }];

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const stop = new AbortController();
    res.on('close', () => stop.abort());
    const f = filter(); let spoken = '';
    send('start', {});
    const run = (lane, signal, onDelta) => streamChat({ base: cfg.llm.base, key: cfg.llm.key, model: lane === 'a' ? cfg.llm.model : cfg.llm.backup, messages, signal, onDelta, fetcher });
    const r = await hedge(run, { delayMs: cfg.llm.hedgeMs, backup: !!cfg.llm.backup, signal: stop.signal,
      onDelta: d => { const out = f.push(d); if (out) { spoken += out; send('delta', { text: out }); } } });
    const tail = f.flush(); if (tail) { spoken += tail; send('delta', { text: tail }); }
    if (stop.signal.aborted) return res.end();
    if (!r.ok && !spoken) send('error', { error: r.error || 'no reply' });
    else send('done', { ...f.flags(), text: spoken, lane: r.lane });
    res.end();
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/info') return json(res, 200, { name: cfg.callerName, lang: cfg.replyLang, needsToken: !!cfg.accessToken, voiceTags: tts.expressive() });
      if (!authed(req)) return json(res, 401, { error: 'wrong or missing access token' });
      if (req.method === 'POST' && url.pathname === '/api/turn') return turn(req, res);
      if (req.method === 'POST' && url.pathname === '/api/tts') {
        const { text } = JSON.parse((await body(req, 64 * 1024)).toString() || '{}');
        const ac = new AbortController(); res.on('close', () => { if (!res.writableEnded) ac.abort(); });
        const buf = await tts.synth(text, ac.signal);
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': buf.length }); return res.end(buf);
      }
      if (req.method === 'POST' && url.pathname === '/api/stt') {
        const audio = await body(req);
        if (audio.length < 1000) return json(res, 200, { text: '' });
        return json(res, 200, { text: await transcribe(cfg, audio, req.headers['content-type'] || 'audio/webm', fetcher) });
      }
      if (req.method === 'GET' && url.pathname === '/api/fillers') return json(res, 200, { items: fillers.items(url.searchParams.get('lang') || cfg.replyLang).map(x => ({ id: x.id })) });
      const fm = /^\/api\/fillers\/([a-f0-9]{16})$/.exec(url.pathname);
      if (req.method === 'GET' && fm) {
        const buf = await fillers.get(fm[1], url.searchParams.get('lang') || cfg.replyLang);
        if (!buf) return json(res, 404, { error: 'unknown' });
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=86400' }); return res.end(buf);
      }
      return json(res, 404, { error: 'not found' });
    }
    // static files
    let file = path.normalize(path.join(WEB, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)));
    if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }

  return http.createServer((req, res) => {
    handle(req, res).catch(e => {
      if (e.name === 'AbortError') { if (!res.headersSent) res.writeHead(499); return res.end(); }
      console.error('[earshot]', e.message);
      if (!res.headersSent) json(res, e.status || 500, { error: e.message }); else res.end();
    });
  });
}

if (require.main === module) {
  loadEnv();
  const cfg = config();
  createServer(cfg).listen(cfg.port, () => {
    console.log(`Earshot is listening on http://localhost:${cfg.port}`);
    if (!cfg.llm.key && /openai\.com/.test(cfg.llm.base)) console.log('  ! LLM_API_KEY is empty. Copy .env.example to .env and fill it in.');
  });
}

module.exports = { createServer };
