// Control tags the model may append to a reply. They are never spoken.
//   [[hangup]]  say this line, then end the call
//   [[stay]]    don't hang up just because it went quiet
// Replies stream in small pieces, so a tag can arrive split ("[[hang" + "up]]"); hold suspicious tails until complete.
const TAGS = { hangup: /\[\[\s*hangup\s*\]\]/gi, stay: /\[\[\s*stay\s*\]\]/gi };
const ANY = /\[\[\s*(?:hangup|stay)\s*\]\]/gi;

function filter() {
  let held = '';
  const flags = {};
  const tail = s => { const i = s.lastIndexOf('[['); if (i >= 0 && !s.slice(i).includes(']]')) return i; return s.endsWith('[') ? s.length - 1 : -1; };
  const take = s => {
    for (const [k, re] of Object.entries(TAGS)) { re.lastIndex = 0; if (re.test(s)) flags[k] = true; re.lastIndex = 0; }
    return s.replace(ANY, '');
  };
  return {
    push(text) {
      let s = held + String(text || ''); held = '';
      const i = tail(s);
      // [[wait]] at the very start is handled by the client; only hold tags we own.
      if (i >= 0 && s.length - i <= 64 && !/^\[\[\s*wait/i.test(s.slice(i))) { held = s.slice(i); s = s.slice(0, i); }
      return take(s);
    },
    flush() { const s = take(held); held = ''; return s; },
    flags: () => ({ ...flags }),
  };
}

function strip(text) {
  const f = filter();
  const out = f.push(text) + f.flush();
  return { text: out.trim(), ...f.flags() };
}

module.exports = { filter, strip };
