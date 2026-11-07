// Checks your .env against the real services with three tiny requests. Run: npm run check
const { loadEnv, config } = require('../server/config');
const { streamChat } = require('../server/llm');
const { createTts } = require('../server/tts');
const { transcribe } = require('../server/stt');
loadEnv(); const cfg = config();
const ok = (name, ms, note = '') => console.log(`  ✓ ${name}  ${ms} ms ${note}`);
const bad = (name, e) => { console.log(`  ✗ ${name}  ${e.message}`); process.exitCode = 1; };
(async () => {
  console.log('Checking Earshot settings...\n');
  let t = Date.now(), first = 0;
  try {
    const r = await streamChat({ base: cfg.llm.base, key: cfg.llm.key, model: cfg.llm.model, messages: [{ role: 'user', content: 'Say hi in three words.' }], onDelta: () => { first ||= Date.now() - t; } });
    ok(`model ${cfg.llm.model}`, Date.now() - t, `(first word after ${first} ms): "${r.text.trim()}"`);
  } catch (e) { bad(`model ${cfg.llm.model}`, e); }
  let audio = null;
  t = Date.now();
  try { audio = await createTts(cfg).synth('Hello, can you hear me?'); ok(`voice (${cfg.tts.provider})`, Date.now() - t, `${audio.length} bytes of mp3`); }
  catch (e) { bad(`voice (${cfg.tts.provider})`, e); }
  if (audio) {
    t = Date.now();
    try { const text = await transcribe(cfg, audio, 'audio/mpeg'); ok(`transcriber ${cfg.stt.model}`, Date.now() - t, `heard: "${text}"`); }
    catch (e) { bad(`transcriber ${cfg.stt.model}`, e); }
  } else console.log('  - transcriber skipped (needs the voice to work first)');
  console.log(process.exitCode ? '\nSomething needs fixing above.' : '\nAll good. Run npm start and open the page.');
})();
