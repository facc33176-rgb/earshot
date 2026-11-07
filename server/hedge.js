// Ask two lanes when the first is slow. Lane A starts now; if it has produced no text after delayMs,
// lane B starts too. Whichever speaks first wins and the other is aborted, so nothing is said twice.
module.exports = function hedge(run, { delayMs = 6000, backup = true, signal, onDelta = () => {} } = {}) {
  const ctl = { a: new AbortController(), b: new AbortController() };
  const stopAll = () => { ctl.a.abort(); ctl.b.abort(); };
  if (signal) { if (signal.aborted) stopAll(); else signal.addEventListener('abort', stopAll, { once: true }); }
  let winner = null, timer = null, startB = () => {};
  const claim = who => { if (!winner) { winner = who; clearTimeout(timer); ctl[who === 'a' ? 'b' : 'a'].abort(); } return winner === who; };
  const lane = who => run(who, ctl[who].signal, delta => { if (claim(who)) onDelta(delta, who); })
    .then(r => ({ who, r }), e => ({ who, r: { ok: false, error: String(e?.message || e) } }));
  const b = new Promise(res => {
    startB = () => { clearTimeout(timer); startB = () => {}; if (!backup || winner || signal?.aborted) return res(null); res(lane('b')); };
  });
  if (backup) timer = setTimeout(() => startB(), delayMs); else startB();
  const a = lane('a');
  return new Promise(resolve => {
    const done = {};
    const settle = x => {
      if (!x) done.b = { skipped: true }; else done[x.who] = x.r;
      if (x?.who === 'a' && !winner && !x.r.ok && !done.b) return startB(); // A failed before speaking: try B now
      if (winner && done[winner]) return resolve({ ...done[winner], lane: winner });
      if (winner) return;
      for (const who of ['a', 'b']) if (done[who]?.ok) { claim(who); return resolve({ ...done[who], lane: who }); }
      if (done.a && done.b) { clearTimeout(timer); resolve({ ...done.a, lane: 'a' }); }
    };
    a.then(settle); b.then(settle);
  });
};
