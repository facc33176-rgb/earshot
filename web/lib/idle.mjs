// What happens when nobody talks. The timer only runs while we're listening and they're silent;
// the moment they make a sound it starts over.
export const GRACE_MS = 3000; // after the goodbye line: 3 seconds to say "wait, don't go"
// sound = a small noise (cough, hum, yawn, a mutter); think = ask the model to say something on its own.
export const DAY_STEPS = [{ at: 30000, kind: 'sound', level: 1 }, { at: 65000, kind: 'think', minute: 1 }, { at: 95000, kind: 'sound', level: 2 },
  { at: 125000, kind: 'think', minute: 2 }, { at: 155000, kind: 'sound', level: 2 }, { at: 185000, kind: 'think', minute: 3 },
  { at: 215000, kind: 'sound', level: 3 }, { at: 245000, kind: 'think', minute: 4 }, { at: 310000, kind: 'think', minute: 5 }];
export const NIGHT_STEPS = [{ at: 40000, kind: 'sound', level: 1 }, { at: 125000, kind: 'think', minute: 2 }, { at: 200000, kind: 'sound', level: 1 }, { at: 250000, kind: 'think', minute: 4 }];

// Level 1 sounds accidental, level 3 is clearly trying to get attention.
const SOUNDS = {
  1: ['[coughs softly] Mm.', '[hums softly] Mm-mm...', '[quiet yawn] Mmh...', "[mutters to himself] So quiet... hm..."],
  2: ['[coughs] Hm.', '[hums a little louder] Mm-mm-mm...', '[yawns] Haah... mm.', '[mumbling] Did they fall asleep on me...'],
  3: ['[fake playful cough] Cough, cough.', '[hums a silly little tune] Da-da-dum, da-dum...', "[muttering, loud enough to be overheard] Guess I'm talking to myself again..."],
};
const NIGHT_SOUNDS = ['[quiet yawn] Mmh...', '[hums softly] Mm-mm...', '[coughs softly] Mm.'];
export const idleSound = (last = '', night = false, level = 1, pick = Math.random) => {
  const pool = (night ? NIGHT_SOUNDS : SOUNDS[level] || SOUNDS[1]).filter(x => x !== last);
  return pool[Math.floor(pick() * pool.length) % pool.length];
};

const WAIT_RE = /等(一)?下|等等|稍等|马上回来|先别挂|hold on|wait|one sec|give me a (sec|minute)|brb|be right back/i;
export const askedToWait = text => WAIT_RE.test(String(text || ''));
export const isNight = (date = new Date()) => { const h = date.getHours(); return h >= 23 || h < 6; };

// Returns the plan for this stretch of silence, in ms from when it started.
export function idlePlan({ night = false, wait = false, stay = false, muted = false } = {}) {
  if (stay) return { steps: [], bye: 2 * 3600000, reason: 'idle', quiet: true };
  if (muted) return { steps: [], bye: 30 * 60000, reason: 'idle' };
  if (wait) return { steps: [{ at: 10 * 60000, kind: 'think', minute: 10 }], bye: 13 * 60000, reason: 'idle' };
  if (night) return { steps: NIGHT_STEPS, bye: 5 * 60000, reason: 'asleep' };
  return { steps: DAY_STEPS, bye: 7 * 60000, reason: 'idle' };
}

const BYE = {
  en: { idle: ["I'll hang up for now. Call me whenever you like.", "Seems like you're busy. I'll let you go, call me back later."],
    asleep: ["Did you fall asleep? Good night. I'll hang up now.", '[whispers] Good night... talk tomorrow.'] },
  zh: { idle: ['那我先挂啦，想聊了随时再打给我。', '你好像在忙，我先挂了，回来叫我。'], asleep: ['睡着啦？晚安，我先挂了。', '[whispers] 晚安……明天聊。'] },
};
export const byeLine = (reason, lang = 'en', pick = Math.random) => { const a = (BYE[lang] || BYE.en)[reason] || BYE.en.idle; return a[Math.floor(pick() * a.length) % a.length]; };
