// Speech -> text through any OpenAI-compatible /audio/transcriptions endpoint.
async function transcribe(cfg, audio, mime = 'audio/webm', fetcher = fetch) {
  const ext = /mp4|m4a|aac/.test(mime) ? 'm4a' : /ogg/.test(mime) ? 'ogg' : /wav/.test(mime) ? 'wav' : /mpeg|mp3/.test(mime) ? 'mp3' : 'webm';
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mime }), `speech.${ext}`);
  form.append('model', cfg.stt.model);
  if (cfg.stt.language) form.append('language', cfg.stt.language);
  const res = await fetcher(`${cfg.stt.base}/audio/transcriptions`, { method: 'POST', body: form, headers: cfg.stt.key ? { Authorization: `Bearer ${cfg.stt.key}` } : {} });
  if (!res.ok) throw new Error(`transcription error ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const j = await res.json();
  return String(j.text || '').trim();
}
module.exports = { transcribe };
