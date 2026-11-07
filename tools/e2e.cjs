// End-to-end check in a real browser with a fake microphone and fake upstream services.
// node tools/e2e.cjs  (needs playwright + chromium + ffmpeg; not part of npm test)
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { config } = require('../server/config');
const { createServer } = require('../server/index');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'earshot-e2e-'));
const wav = path.join(dir, 'mic.wav'), mp3 = path.join(dir, 'voice.mp3');
// "She" talks for 1.4 s (a voiced, wobbling tone), then is silent for 9 s; the file loops.
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*(180+40*sin(2*PI*3*t))*t)*between(t,0.3,1.7)':s=48000:d=10.5", wav]);
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=300:d=0.7', '-ar', '44100', mp3]);
const voice = fs.readFileSync(mp3);
const calls = { stt: 0, chat: 0, tts: 0 }; const asked = [];
const fake = async (url, opts = {}) => {
  if (url.endsWith('/audio/transcriptions')) { calls.stt++; return Response.json({ text: 'hello there' }); }
  if (url.endsWith('/chat/completions')) {
    calls.chat++; const req = JSON.parse(opts.body); asked.push(req.messages.at(-1).content);
    const chunks = process.env.SCENARIO === 'wait' && calls.chat === 1 ? ['[[wa', 'it]]'] : process.env.SCENARIO === 'long' ? Array(12).fill('This is a long reply that keeps going. ') : ['[warmly] Hi there. ', 'How was ', 'your day?'];
    const body = new ReadableStream({ async start(c) { for (const t of chunks) { await new Promise(r => setTimeout(r, 120)); c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`)); } c.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); c.close(); } });
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  }
  if (/text-to-speech/.test(url)) { calls.tts++; return new Response(voice, { headers: { 'Content-Type': 'audio/mpeg' } }); }
  return new Response('?', { status: 404 });
};

(async () => {
  const cfg = config({ LLM_API_KEY: 'x', ELEVENLABS_API_KEY: 'x', ELEVENLABS_VOICE_ID: 'v', PORT: '0' });
  cfg.root = path.join(__dirname, '..'); // fillers cache into the repo's .cache (ignored by git)
  const srv = createServer(cfg, { fetcher: fake }).listen(0);
  const url = `http://localhost:${srv.address().port}/`;
  const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 1 });
  const logs = []; p.on('console', m => logs.push(m.text())); p.on('pageerror', e => logs.push('PAGEERROR ' + e.message));
  await p.goto(url); await p.evaluate(() => localStorage.setItem('earshot:debug', '1'));
  await p.click('#call');
  const phases = new Set();
  const t0 = Date.now();
  let tapped = false;
  while (Date.now() - t0 < 16000) {
    const ph = await p.evaluate(() => document.body.dataset.phase); phases.add(ph);
    if (process.env.SCENARIO === 'long' && ph === 'speak' && !tapped && Date.now() - t0 > 4000) { tapped = true; await p.click('#wave'); phases.add('after-tap:' + await p.evaluate(() => document.body.dataset.phase)); }
    await p.waitForTimeout(100);
  }
  const lines = await p.$$eval('#lines p', ps => ps.map(x => x.className + ': ' + x.textContent));
  const timing = await p.textContent('#timing');
  await p.screenshot({ path: path.join(dir, 'call.png') });
  await p.click('#hangup');
  const ended = await p.evaluate(() => !document.body.classList.contains('in-call'));
  await b.close(); srv.close();
  console.log(JSON.stringify({ asked: asked.map(a => a.slice(0, 80)), phases: [...phases], lines, timing, calls, ended, screenshot: path.join(dir, 'call.png') }, null, 1));
  console.log(logs.filter(l => /\[call\]|PAGEERROR/.test(l)).join('\n'));
  if (process.env.SCENARIO === 'wait') { const ok = calls.chat >= 2 && /may be only part/.test(asked[0]) && asked[1] === 'hello there' && lines.some(l => /me: Hi there/.test(l)) && !lines.some(l => /wait/.test(l)); console.log(ok ? 'E2E OK' : 'E2E FAILED'); process.exit(ok ? 0 : 1); }
  if (process.env.SCENARIO === 'long') { const ok = phases.has('after-tap:listen') && calls.tts < 20; console.log(ok ? 'E2E OK' : 'E2E FAILED'); process.exit(ok ? 0 : 1); }
  const ok = phases.has('think') && phases.has('speak') && lines.some(l => /her: hello there/.test(l)) && lines.some(l => /me: Hi there\. How was your day\?/.test(l)) && ended && !logs.some(l => /PAGEERROR/.test(l));
  console.log(ok ? 'E2E OK' : 'E2E FAILED'); process.exit(ok ? 0 : 1);
})();
