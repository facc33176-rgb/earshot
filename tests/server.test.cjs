const test = require('node:test');
const assert = require('node:assert/strict');
const { filter, strip } = require('../server/tags');
const hedge = require('../server/hedge');
const { speakable, slots } = require('../server/tts');
const { config } = require('../server/config');
const { createServer } = require('../server/index');

test('control tags are removed even when split across chunks', () => {
  const f = filter();
  let out = f.push('Good night. [[hang') + f.push('up]]');
  out += f.flush();
  assert.equal(out.trim(), 'Good night.');
  assert.equal(f.flags().hangup, true);
  assert.deepEqual(strip('Stay with me [[stay]]'), { text: 'Stay with me', stay: true });
  const w = filter(); assert.equal(w.push('[[wait]]'), '[[wait]]'); // left for the page to judge
});

test('speakable text drops links, markdown and translations, keeps voice tags when allowed', () => {
  assert.equal(speakable('[laughs] See **this** https://x.y （翻译）'), '[laughs] See this');
  assert.equal(speakable('[laughs] Okay.', false), 'Okay.');
});

test('voice slots queue extra requests', async () => {
  const take = slots(2); const order = [];
  const r1 = await take(), r2 = await take();
  const third = take().then(rel => { order.push('third'); rel(); });
  await new Promise(r => setTimeout(r, 10)); assert.deepEqual(order, []);
  r1(); await third; assert.deepEqual(order, ['third']); r2();
});

test('hedge: the slow lane loses to the backup and nothing is said twice', async () => {
  const said = [];
  const run = (lane, signal, onDelta) => new Promise(ok => {
    const t = setTimeout(() => { onDelta(lane); ok({ ok: true, text: lane }); }, lane === 'a' ? 200 : 20);
    signal.addEventListener('abort', () => { clearTimeout(t); ok({ ok: false, error: 'aborted' }); });
  });
  const r = await hedge(run, { delayMs: 30, onDelta: d => said.push(d) });
  assert.equal(r.lane, 'b'); assert.deepEqual(said, ['b']);
});

test('hedge: when the first lane fails before speaking, the backup starts at once', async () => {
  const t0 = Date.now();
  const run = (lane, signal, onDelta) => lane === 'a' ? Promise.resolve({ ok: false, error: 'down' }) : (onDelta('hi'), Promise.resolve({ ok: true, text: 'hi' }));
  const r = await hedge(run, { delayMs: 5000 });
  assert.equal(r.lane, 'b'); assert.ok(Date.now() - t0 < 1000);
});

// A fake upstream for the whole server: model, voice and transcriber.
function fakeFetch(log) {
  return async (url, opts = {}) => {
    log.push(url);
    if (url.endsWith('/chat/completions')) {
      const body = JSON.parse(opts.body); log.push(body);
      const chunks = ['Hi there. ', 'Good to hear you', '! [[hang', 'up]]'];
      const stream = new ReadableStream({ start(c) { for (const t of chunks) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`)); c.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); c.close(); } });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (url.includes('/text-to-speech/')) return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
    if (url.endsWith('/audio/transcriptions')) return Response.json({ text: 'hello you' });
    return new Response('no', { status: 404 });
  };
}

test('server: a turn streams text, strips tags and reports flags', async () => {
  const log = [];
  const cfg = config({ LLM_API_KEY: 'k', ELEVENLABS_API_KEY: 'e', ELEVENLABS_VOICE_ID: 'v', ACCESS_TOKEN: 'secret', PERSONA_FILE: 'nope.md' });
  const srv = createServer(cfg, { fetcher: fakeFetch(log) }).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.equal((await fetch(base + '/api/turn', { method: 'POST', body: '{}' })).status, 401);
    const H = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' };
    const res = await fetch(base + '/api/turn', { method: 'POST', headers: H, body: JSON.stringify({ text: 'hey', mayContinue: true, history: [{ role: 'user', content: 'a' }, { role: 'system', content: 'evil' }] }) });
    const text = await res.text();
    assert.match(text, /event: delta/);
    assert.doesNotMatch(text, /hangup\]\]/);
    assert.match(text, /"hangup":true/);
    const sent = log.find(x => x && x.messages);
    assert.equal(sent.messages.filter(m => m.role === 'system').length, 1, 'client cannot inject system messages');
    assert.match(sent.messages.at(-1).content, /may be only part/);
    const tts = await fetch(base + '/api/tts', { method: 'POST', headers: H, body: JSON.stringify({ text: 'Hi.' }) });
    assert.equal(tts.headers.get('content-type'), 'audio/mpeg');
    const stt = await fetch(base + '/api/stt', { method: 'POST', headers: { Authorization: 'Bearer secret', 'Content-Type': 'audio/webm' }, body: new Uint8Array(2000) });
    assert.deepEqual(await stt.json(), { text: 'hello you' });
    const page = await fetch(base + '/');
    assert.match(await page.text(), /Earshot/);
    assert.equal((await fetch(base + '/../package.json')).status, 404);
  } finally { srv.close(); }
});
