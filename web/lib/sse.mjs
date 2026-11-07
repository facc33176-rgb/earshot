// Read a server-sent-event stream from fetch().
export async function* streamEvents(body) {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let m;
      while ((m = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, m.index); buffer = buffer.slice(m.index + m[0].length);
        let event = 'message'; const lines = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /, ''));
        }
        if (!lines.length) continue;
        yield { event, data: JSON.parse(lines.join('\n')) };
        if (event === 'done' || event === 'error') return;
      }
      if (done) throw new Error('the reply stream ended early');
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
