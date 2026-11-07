// Tiny sounds in the call's own voice ("Hmm...", a soft laugh), generated once and cached on disk.
// The page plays one when a reply is slow, so the silence never feels dead.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LINES = {
  en: ['[thoughtful] Hmm...', '[chuckles softly] Mm.', 'Mm-hm.', '[inhales] Okay...', '[softly] Hm.'],
  zh: ['[thoughtful] 嗯……', '[chuckles softly] 嗯。', '嗯嗯。', '[inhales] 好……', '[softly] 唔。'],
};

function createFillers(cfg, tts) {
  const dir = path.join(cfg.root, '.cache', 'fillers');
  const voiceKey = JSON.stringify([cfg.tts.provider, cfg.tts.eleven.voice, cfg.tts.eleven.model, cfg.tts.openai.voice, cfg.tts.openai.model]);
  const id = text => crypto.createHash('sha1').update(voiceKey + text).digest('hex').slice(0, 16);
  const items = lang => (LINES[lang] || LINES.en).map(text => ({ id: id(text), text }));
  const inflight = new Map();
  async function get(fid, lang) {
    const item = items(lang).find(x => x.id === fid) || items(lang === 'en' ? 'zh' : 'en').find(x => x.id === fid);
    if (!item) return null;
    const file = path.join(dir, fid + '.mp3');
    if (fs.existsSync(file)) return fs.readFileSync(file);
    if (!inflight.has(fid)) inflight.set(fid, (async () => {
      const buf = await tts.synth(item.text);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file + '.tmp', buf); fs.renameSync(file + '.tmp', file);
      return buf;
    })().finally(() => inflight.delete(fid)));
    return inflight.get(fid);
  }
  return { items, get };
}
module.exports = { createFillers, LINES };
