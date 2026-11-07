// People say one sentence in several bursts. These helpers glue the bursts back together
// and recognise the model's "[[wait]]" answer, meaning "you're not done yet, keep listening".

export const joinSaid = (a, b) => {
  a = String(a || '').trim(); b = String(b || '').trim();
  if (!a) return b;
  if (!b) return a;
  if (/[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(b)) return a + ' ' + b;
  if (/[，。！？、…～]$/.test(a)) return a + b;
  if (/[\u4e00-\u9fff]$/.test(a)) return a + '，' + b;
  return a + (/[,.!?~]$/.test(a) ? ' ' : ', ') + b;
};

export const isWait = all => /^\s*\[\[wait\]\]/i.test(String(all || ''));
// While streaming, the reply may still turn out to be [[wait]] (we may only have "[[wa" so far): don't speak yet.
export const mayBeWait = all => /^\s*\[(\[(w(a(i(t(\]\]?)?)?)?)?)?)?$/i.test(String(all || '')) || isWait(all);

// How long a pause counts as "finished speaking".
export const QUICK_PAUSE_MS = 800;      // recorded path: hand over early, let the model judge
export const PATIENT_PAUSE_MS = 2200;   // after the model said [[wait]]
export const PATIENT_GIVE_UP_MS = 4000; // waited for more, nothing came: answer what we have
// Browser dictation path: longer utterances get a little more time, a breath mid-sentence isn't the end.
export const silenceFor = text => (text.length > 40 ? 2000 : text.length > 18 ? 1600 : 1000);
