// Text -> speech. ElevenLabs (expressive, understands [laughs]-style tags) or any OpenAI-compatible /audio/speech.
// Most ElevenLabs plans only allow a couple of generations at once; extra sentences wait in line instead of failing.

// Remove what must not be read aloud. Bracket tags stay for ElevenLabs v3, are dropped for other voices.
function speakable(s, keepTags = true) {
  let t = String(s || '')
    .replace(/\[\[[^\]]*\]\]/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_`#>~|]/g, '')
    .replace(/（[^）]*）/g, '');
  if (!keepTags) t = t.replace(/\[[a-z][a-z ,'-]{0,40}\]/gi, '');
  return t.replace(/\s+/g, ' ').trim();
}

function slots(limit) {
  let active = 0; const waiting = [];
  return function take(signal) {
    return new Promise((ok, no) => {
      let released = false;
      const release = () => { if (released) return; released = true; active--; const n = waiting.shift(); if (n) n(); };
      const go = () => { signal?.removeEventListener?.('abort', onAbort); active++; ok(release); };
      const onAbort = () => { const i = waiting.indexOf(go); if (i >= 0) waiting.splice(i, 1); no(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
      if (active < limit) { active++; return ok(release); }
      if (signal?.aborted) return onAbort();
      signal?.addEventListener?.('abort', onAbort, { once: true });
      waiting.push(go);
    });
  };
}

function createTts(cfg, fetcher = fetch) {
  const take = slots(cfg.tts.concurrency);
  const expressive = () => cfg.tts.provider === 'elevenlabs' && /eleven_v[34]/.test(cfg.tts.eleven.model);

  async function request(text, signal) {
    if (cfg.tts.provider === 'openai') {
      const o = cfg.tts.openai;
      return fetcher(`${o.base}/audio/speech`, { method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${o.key}` },
        body: JSON.stringify({ model: o.model, voice: o.voice, input: text, response_format: 'mp3' }) });
    }
    const e = cfg.tts.eleven;
    if (!e.key || !e.voice) throw Object.assign(new Error('ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID are required'), { status: 400 });
    const headers = { 'Content-Type': 'application/json', Accept: 'audio/mpeg', 'xi-api-key': e.key };
    if (e.model === 'eleven_v4') // v4 is served through the dialogue endpoint
      return fetcher(`${e.base}/v1/text-to-dialogue/stream?output_format=mp3_44100_64`, { method: 'POST', signal, headers,
        body: JSON.stringify({ model_id: e.model, inputs: [{ text, voice_id: e.voice }] }) });
    const settings = /eleven_v3/.test(e.model) ? { stability: 0.5 } : { stability: 0.35, similarity_boost: 0.8, style: 0.6, use_speaker_boost: true };
    return fetcher(`${e.base}/v1/text-to-speech/${encodeURIComponent(e.voice)}/stream?output_format=mp3_44100_64`, { method: 'POST', signal, headers,
      body: JSON.stringify({ text, model_id: e.model, voice_settings: settings }) });
  }

  // Returns an MP3 Buffer.
  async function synth(raw, signal) {
    const text = speakable(raw, expressive());
    if (!text.replace(/\[[^\]]*\]/g, '').replace(/[\s\p{P}]/gu, '')) throw Object.assign(new Error('nothing to say'), { status: 400 });
    const release = await take(signal);
    try {
      for (let attempt = 0; ; attempt++) {
        const res = await request(text.slice(0, 1000), signal);
        if (res.ok) return Buffer.from(await res.arrayBuffer());
        const body = await res.text().catch(() => '');
        // A busy plan answers 429 concurrent_limit_exceeded: wait a moment and try again.
        if (res.status === 429 && attempt < 3) { await new Promise(r => setTimeout(r, 800)); continue; }
        throw Object.assign(new Error(`voice error ${res.status}: ${body.slice(0, 200)}`), { status: 502 });
      }
    } finally { release(); }
  }
  return { synth, expressive };
}

module.exports = { createTts, speakable, slots };
