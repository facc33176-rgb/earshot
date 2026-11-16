// Text -> speech. ElevenLabs (expressive, understands [laughs]-style tags), MiniMax (understands (laughs)-style tags on speech-2.8)
// or any OpenAI-compatible /audio/speech.
// Most ElevenLabs plans only allow a couple of generations at once; extra sentences wait in line instead of failing.

// The interjections MiniMax speech-2.8 documents, plus its <#0.5#> pause marks. Anything else in round brackets is not read.
const MINIMAX_TAGS = ['laughs', 'chuckle', 'coughs', 'clear-throat', 'groans', 'breath', 'pant', 'inhale', 'exhale', 'gasps', 'sniffs', 'sighs', 'snorts', 'burps', 'lip-smacking', 'humming', 'hissing', 'emm', 'sneezes'];
const MINIMAX_TAG_RE = new RegExp(`\\((?:${MINIMAX_TAGS.join('|')})\\)`, 'g');

// Remove what must not be read aloud. style: 'eleven' keeps [laughs] tags, 'minimax' keeps (laughs) tags, anything else drops both.
// (true/false are still accepted: true = 'eleven'.)
function speakable(s, style = 'eleven') {
  if (style === true) style = 'eleven'; else if (style === false) style = '';
  const keep = [];
  let t = String(s || '');
  if (style === 'minimax') t = t.replace(MINIMAX_TAG_RE, m => `\u0000${keep.push(m) - 1}\u0000`)
    .replace(/<#(\d{1,2}(?:\.\d{1,2})?)#>/g, (m, n) => Number(n) >= 0.01 && Number(n) <= 2 ? `\u0000${keep.push(m) - 1}\u0000` : '');
  t = t
    .replace(/<#[^#]*#>/g, '')
    .replace(/\[\[[^\]]*\]\]/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_`#>~|]/g, '')
    .replace(/（[^）]*）/g, '');
  if (style !== 'eleven') t = t.replace(/\[[a-z][a-z ,'-]{0,40}\]/gi, '');
  if (style === 'minimax') t = t.replace(/\([a-z][a-z ,'-]{0,30}\)/gi, '');
  t = t.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[Number(i)] || '');
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
  // Which kind of voice tags this voice understands: 'eleven', 'minimax' or '' (none).
  const tagStyle = () => cfg.tts.provider === 'elevenlabs' && /eleven_v[34]/.test(cfg.tts.eleven.model) ? 'eleven'
    : cfg.tts.provider === 'minimax' && /^speech-2\.8-/.test(cfg.tts.minimax.model) ? 'minimax' : '';
  const expressive = () => !!tagStyle();

  // MiniMax answers JSON with the audio as hex, so it gets its own path (and returns a Buffer, not a Response).
  async function minimax(text, signal) {
    const m = cfg.tts.minimax;
    if (!m.key || !m.voice) throw Object.assign(new Error('MINIMAX_API_KEY and MINIMAX_VOICE_ID are required'), { status: 400 });
    const voice = { voice_id: m.voice, speed: m.speed, vol: 1, pitch: 0, ...(m.emotion ? { emotion: m.emotion } : {}) };
    const res = await fetcher(`${m.base}/v1/t2a_v2`, { method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${m.key}` },
      body: JSON.stringify({ model: m.model, text, stream: false, output_format: 'hex', language_boost: 'auto',
        voice_setting: voice, audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 } }) });
    const body = await res.text().catch(() => '');
    let d = {}; try { d = JSON.parse(body); } catch (_) {}
    const code = d.base_resp?.status_code;
    if (!res.ok || (code !== undefined && code !== 0)) {
      // 1002 = rate limited, 1039 = token limit: worth one short retry, like ElevenLabs' 429.
      const busy = res.status === 429 || code === 1002 || code === 1039;
      throw Object.assign(new Error(`voice error ${res.ok ? 'minimax ' + code : res.status}: ${(d.base_resp?.status_msg || body).slice(0, 200)}`), { status: 502, busy });
    }
    const hex = d.data?.audio;
    if (typeof hex !== 'string' || !hex.length || hex.length % 2 || !/^[0-9a-f]+$/i.test(hex)) throw Object.assign(new Error('voice error: MiniMax returned no audio'), { status: 502 });
    return Buffer.from(hex, 'hex');
  }

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
    const text = speakable(raw, tagStyle());
    if (!text.replace(/\[[^\]]*\]/g, '').replace(MINIMAX_TAG_RE, '').replace(/<#[^#]*#>/g, '').replace(/[\s\p{P}]/gu, '')) throw Object.assign(new Error('nothing to say'), { status: 400 });
    const release = await take(signal);
    try {
      for (let attempt = 0; ; attempt++) {
        if (cfg.tts.provider === 'minimax') {
          try { return await minimax(text.slice(0, 1000), signal); }
          catch (e) { if (e.busy && attempt < 3) { await new Promise(r => setTimeout(r, 800)); continue; } throw e; }
        }
        const res = await request(text.slice(0, 1000), signal);
        if (res.ok) return Buffer.from(await res.arrayBuffer());
        const body = await res.text().catch(() => '');
        // A busy plan answers 429 concurrent_limit_exceeded: wait a moment and try again.
        if (res.status === 429 && attempt < 3) { await new Promise(r => setTimeout(r, 800)); continue; }
        throw Object.assign(new Error(`voice error ${res.status}: ${body.slice(0, 200)}`), { status: 502 });
      }
    } finally { release(); }
  }
  return { synth, expressive, tagStyle };
}

module.exports = { createTts, speakable, slots, MINIMAX_TAGS };
