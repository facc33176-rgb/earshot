// Cut a streaming reply into speakable sentences, so the first one can be voiced while the rest is still being written.
export function takeSentences(buf) {
  const out = [];
  let start = 0, depth = 0;
  for (let i = 0; i < buf.length; i++) {
    const ch = buf[i];
    if (ch === '（' || ch === '(') { depth++; continue; }
    if ((ch === '）' || ch === ')') && depth) { depth--; continue; }
    if (depth) continue;
    const next = buf[i + 1];
    if (/[。！？!?～…\n]/.test(ch) || (ch === '.' && (next === ' ' || next === '\n'))) {
      // Don't split "Dr." or "U.S." style abbreviations.
      if (ch === '.' && /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e)|\b[A-Z])\.$/i.test(buf.slice(start, i + 1))) continue;
      out.push(buf.slice(start, i + 1)); start = i + 1;
    }
  }
  return { out: out.map(x => x.trim()).filter(x => x.replace(/[\s\p{P}]/gu, '')), rest: buf.slice(start) };
}

// Does this text contain anything that would actually be heard (not just a tag or punctuation)?
export const hasSpeech = text => !!String(text || '').replace(/\[[^\]]*\]/g, '').replace(/[\s\p{P}]/gu, '');

export const joinSpeech = parts => parts.map(s => s.trim()).filter(Boolean).join(' ');

// Split a very long run-on sentence so no request gets cut off by the voice service's length limit.
export function speechParts(text, max = 900) {
  const tokens = String(text || '').match(/\[[^\]]*\]|[\p{L}\p{N}'’-]+|[^\p{L}\p{N}]/gu) || [];
  const out = []; let part = '';
  for (let token of tokens) {
    if (part.length + token.length > max) { if (part.trim()) out.push(part.trim()); part = ''; }
    while (token.length > max) { out.push(token.slice(0, max)); token = token.slice(max); }
    part += token;
  }
  if (part.trim()) out.push(part.trim());
  return out;
}

// Pause between two spoken segments. The network wait already counts toward it, never add a second full pause.
export function segmentPause(text, elapsedMs, hasPrevious) {
  if (!hasPrevious) return 0;
  const target = /[!?！？][”"’']?\s*$/.test(text || '') ? 300 : 200;
  return Math.max(0, target - Math.max(0, elapsedMs));
}
