// Streams one reply from an OpenAI-compatible chat endpoint.
async function* sse(body) {
  const reader = body.getReader(), dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    buf += done ? dec.decode() : dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try { yield JSON.parse(data); } catch (_) { /* keep-alive or partial line */ }
    }
    if (done) return;
  }
}

async function streamChat({ base, key, model, messages, signal, onDelta, fetcher = fetch }) {
  const res = await fetcher(`${base}/chat/completions`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model, messages, stream: true, temperature: 0.8 }),
  });
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`model error ${res.status}: ${t.slice(0, 300)}`); }
  let text = '';
  for await (const j of sse(res.body)) {
    const d = j.choices?.[0]?.delta?.content;
    if (d) { text += d; onDelta(d); }
  }
  return { ok: true, text };
}

module.exports = { streamChat, sse };
