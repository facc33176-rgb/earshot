// Earshot call page. One file on purpose: read it top to bottom and you have the whole call loop.
//
//   listen ──(she pauses)──▶ transcribe ──▶ think (model streams a reply) ──▶ speak sentence by sentence ──▶ listen
//      ▲                          │                 │                                   │
//      │                          └── she keeps talking: merge, keep listening          └── she cuts in: stop at once
//      └── nobody talks for a while: small sounds, then a few words of its own, finally a goodbye
//
import { takeSentences, hasSpeech, joinSpeech, speechParts, segmentPause } from './lib/speech.mjs';
import { joinSaid, isWait, mayBeWait, QUICK_PAUSE_MS, PATIENT_PAUSE_MS, PATIENT_GIVE_UP_MS, silenceFor } from './lib/turn.mjs';
import { InputGate } from './lib/gate.mjs';
import { GRACE_MS, idlePlan, idleSound, askedToWait, isNight, byeLine } from './lib/idle.mjs';
import { streamEvents } from './lib/sse.mjs';

const $ = s => document.querySelector(s);
const store = {
  get: (k, d = '') => { try { return localStorage.getItem('earshot:' + k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('earshot:' + k, v); } catch { /* private mode */ } },
};
const auth = (extra = {}) => ({ ...extra, ...(store.get('token') ? { Authorization: 'Bearer ' + store.get('token') } : {}) });
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const FILLER_GAP_MS = 1500, FILLER_SPACING_MS = 6000, FIRST_SPEECH_TIMEOUT_MS = 30000;
let INFO = { name: 'Earshot', lang: 'en', needsToken: false };

class Call {
  constructor(ui) {
    this.ui = ui;
    this.gen = 0;            // bumps on every new reply / interruption; anything from an older gen is ignored
    this.queue = [];         // sentences waiting to be spoken: { text, gen, audio: Promise<AudioBuffer> }
    this.history = [];       // the conversation so far, sent with every turn
    this.prefix = '';        // words she already said that are waiting for the rest of the sentence
    this.pieces = [];        // transcriptions of the bursts in the current utterance, in order
    this.phase = 'idle';
    this.herLevel = 0; this.meLevel = 0;
    this.useDictation = !!SR && store.get('dictation') === '1';
    this.barge = store.get('barge') === '1';
  }

  log(...a) { if (store.get('debug') === '1') console.log('[call]', ((performance.now() - this.t0) / 1000).toFixed(2), ...a); }
  setPhase(p) { this.phase = p; this.ui.phase(p); }

  // ── start / end ──────────────────────────────────────────────
  async start() {
    // Must run inside the tap: iPhone only grants audio here.
    const C = window.AudioContext || window.webkitAudioContext;
    this.ctx = new C(); this.ctx.resume();
    try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch { /* older Safari */ }
    this.t0 = performance.now(); this.ended = false;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) { this.ui.error('Microphone is blocked. Allow it in the browser settings and call again.'); this.ui.ended(); return; }
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser(); this.analyser.fftSize = 1024; src.connect(this.analyser);
    // Safari stops rendering a capture graph that goes nowhere; route it into a silent gain.
    const mute = this.ctx.createGain(); mute.gain.value = 0; this.analyser.connect(mute); mute.connect(this.ctx.destination);
    this.out = this.ctx.createGain(); this.meAnalyser = this.ctx.createAnalyser(); this.meAnalyser.fftSize = 512;
    this.out.connect(this.meAnalyser); this.meAnalyser.connect(this.ctx.destination);
    this.gate = new InputGate(); this.bargeGate = new InputGate({ min: 9, max: 14 });
    this.mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find(m => window.MediaRecorder?.isTypeSupported?.(m)) || '';
    this.loadFillers();
    this.listen();
    requestAnimationFrame(() => this.tick());
  }

  hangup() {
    if (this.ended) return;
    this.ended = true; this.gen++;
    clearTimeout(this.idleTimer); clearTimeout(this.byeTimer); clearTimeout(this.graceTimer); clearTimeout(this.patientTimer);
    this.abort?.(); this.stopAudio(); this.stopDictation();
    try { this.rec?.stop(); } catch { /* already stopped */ }
    this.stream?.getTracks().forEach(t => t.stop());
    this.ctx?.close().catch(() => {});
    this.setPhase('ended'); this.ui.ended();
  }

  // ── the microphone loop: runs every frame, decides what her sound means in the current phase ──
  tick() {
    if (this.ended) return;
    const data = new Uint8Array(this.analyser.fftSize); this.analyser.getByteTimeDomainData(data);
    let sum = 0; for (const v of data) sum += (v - 128) ** 2;
    const rms = Math.sqrt(sum / data.length), now = Date.now();
    this.herLevel = this.muted ? 0 : rms;
    const me = new Uint8Array(this.meAnalyser.fftSize); this.meAnalyser.getByteTimeDomainData(me);
    let s2 = 0; for (const v of me) s2 += (v - 128) ** 2; this.meLevel = Math.sqrt(s2 / me.length);

    if (!this.muted) {
      const loud = this.gate.loud(rms, now);
      if (this.phase === 'listen' && !this.useDictation) this.vadListen(loud, now);
      else if ((this.phase === 'think' || this.phase === 'recognize') && !this.fillerPlaying) {
        // Still thinking, nothing said yet: if she keeps talking, she wasn't done. Merge and keep listening.
        if (loud) { this.loudSince ||= now; if (now - this.loudSince > 250) { this.loudSince = 0; this.herContinues(); } } else this.loudSince = 0;
      } else if (this.phase === 'speak' && this.barge) {
        // Voice interruption: needs a clearly louder, sustained voice so our own echo doesn't trigger it.
        if (this.bargeGate.loud(rms, now)) { this.bargeSince ||= now; if (now - this.bargeSince > 300) { this.bargeSince = 0; this.interrupt('voice'); } } else this.bargeSince = 0;
      }
      if (loud) this.heardHer();
    }
    requestAnimationFrame(() => this.tick());
  }

  // ── listening, recorded path (works everywhere, including iPhone) ──
  newSegment() {
    try { this.rec?.stop(); } catch { /* fine */ }
    const chunks = [], rec = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime, audioBitsPerSecond: 32000 } : undefined);
    rec.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };
    this.rec = rec; this.seg = { rec, chunks, at: Date.now(), spoke: false, lastLoud: 0 };
    rec.start(250);
  }
  vadListen(loud, now) {
    const s = this.seg; if (!s) return;
    if (loud) { if (!s.spoke) { this.log('her voice'); this.ui.heard('…'); } s.spoke = true; s.lastLoud = now; }
    const pause = this.patient ? PATIENT_PAUSE_MS : QUICK_PAUSE_MS;
    if (s.spoke && now - s.lastLoud > pause) this.endSegment();
    else if (!s.spoke && now - s.at > 30000) this.newSegment(); // long silence: don't upload minutes of nothing later
  }
  endSegment() {
    const s = this.seg; this.seg = null;
    const blob = new Promise(ok => { s.rec.onstop = () => ok(new Blob(s.chunks, { type: s.rec.mimeType || this.mime || 'audio/mp4' })); s.rec.stop(); });
    this.newSegment(); // keep recording: if she goes on, the start of it is already captured
    if (this.seg) this.seg.spoke = false;
    const text = blob.then(b => this.transcribe(b));
    this.pieces.push(text);
    const ticket = this.ticket = (this.ticket || 0) + 1;
    this.setPhase('recognize');
    Promise.all(this.pieces).then(parts => {
      if (ticket !== this.ticket || this.ended) return; // she kept talking: a later burst will submit everything
      this.pieces = [];
      const said = parts.filter(Boolean).reduce(joinSaid, '');
      if (!said) { this.listen(); return; }
      this.submit(said, { byVoice: true });
    }, e => { if (ticket === this.ticket) { this.pieces = []; this.ui.error(e.message); this.listen(); } });
  }
  async transcribe(blob) {
    const t0 = performance.now();
    const res = await fetch('/api/stt', { method: 'POST', headers: auth({ 'Content-Type': blob.type }), body: blob });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || 'Transcription failed');
    this.log('transcribed in', Math.round(performance.now() - t0), 'ms:', j.text);
    return j.text || '';
  }

  // ── listening, browser dictation path (Chrome/Edge/Android; free, needs the browser's own speech service) ──
  startDictation() {
    if (this.sr) return;
    const rec = new SR(); rec.lang = store.get('hearLang', INFO.lang === 'zh' ? 'zh-CN' : 'en-US'); rec.continuous = true; rec.interimResults = true;
    let done = '';
    rec.onresult = e => {
      let fin = '', mid = '';
      for (let i = e.resultIndex; i < e.results.length; i++) (e.results[i].isFinal ? (fin += e.results[i][0].transcript) : (mid += e.results[i][0].transcript));
      done += fin; const text = (done + mid).trim();
      if (!text) return;
      this.heardHer();
      if (this.phase === 'think') { this.herContinues(); }
      this.dictated = text; this.ui.heard(joinSaid(this.prefix, text));
      clearTimeout(this.dictTimer);
      this.dictTimer = setTimeout(() => { if (this.phase === 'listen' && this.dictated) { const t = this.dictated; this.dictated = ''; done = ''; this.submit(t, { byVoice: false }); } }, silenceFor(text));
    };
    rec.onerror = e => { if (/not-allowed|network|service-not-allowed/.test(e.error)) { this.useDictation = false; this.ui.hint('Browser dictation unavailable, switching to recording'); this.stopDictation(); this.listen(); } };
    rec.onend = () => { if (this.sr === rec) { this.sr = null; if (this.phase === 'listen' || this.phase === 'think') this.startDictation(); } };
    this.sr = rec; rec.start();
  }
  stopDictation() { const r = this.sr; this.sr = null; clearTimeout(this.dictTimer); try { r?.abort(); } catch { /* fine */ } }

  listen() {
    if (this.ended) return;
    this.setPhase(this.muted ? 'muted' : 'listen');
    if (this.useDictation) { this.dictated = ''; this.startDictation(); }
    else this.newSegment();
    this.armIdle();
  }

  // She made a sound while we were still thinking: the sentence wasn't over.
  herContinues() {
    if (this.phase === 'recognize') { this.ticket++; this.log('she continues (while transcribing)'); this.setPhase('listen'); if (this.seg) { this.seg.spoke = true; this.seg.lastLoud = Date.now(); } return; }
    if (this.phase !== 'think') return;
    this.log('she continues (while thinking)');
    this.gen++; this.abort?.(); this.cancelVoices();
    this.prefix = joinSaid(this.prefix, this.asked); this.ui.heard(this.prefix);
    this.setPhase('listen'); if (this.seg) { this.seg.spoke = true; this.seg.lastLoud = Date.now(); }
  }

  // ── sending a turn ──
  submit(said, { byVoice }) {
    const text = joinSaid(this.prefix, said); this.prefix = '';
    const mayContinue = byVoice && !this.patient; this.patient = false;
    clearTimeout(this.patientTimer);
    if (this.useDictation) { /* keep dictation running while thinking: new words mean she isn't done */ }
    this.waitMode = askedToWait(text);
    this.ask(text, { mayContinue });
  }

  async ask(text, { mayContinue = false, idle = 0 } = {}) {
    this.cancelVoices();
    const gen = ++this.gen;
    this.asked = idle ? '' : text; this.askAt = performance.now(); this.firstSound = false; this.lastSegmentEnd = 0;
    this.queue = []; this.playing = false; this.replyDone = false; this.spoken = '';
    this.setPhase('think'); this.ui.error('');
    if (!idle) this.ui.line('her', text);
    const line = this.ui.line('me', '');
    let buf = '', all = '', first = true, pend = [], pendTimer = null;
    const flush = () => { clearTimeout(pendTimer); if (pend.length && gen === this.gen) { const j = joinSpeech(pend); if (j.length <= 140) this.say(j, gen); else pend.forEach(p => this.say(p, gen)); } pend = []; };
    // First sentence goes out alone and immediately; later ones are paired up (fewer, longer voice requests).
    const collect = s => { if (!hasSpeech(s)) return; if (first) { first = false; clearTimeout(this.firstTimer); this.say(s, gen); return; } pend.push(s); if (pend.length >= 2) flush(); else pendTimer = setTimeout(flush, 350); };
    this.firstTimer = setTimeout(() => { if (gen === this.gen && first) { this.log('no reply in time'); this.gen++; this.abort?.(); this.ui.hint('That took too long. Go on, I\'m listening.'); this.listen(); } }, FIRST_SPEECH_TIMEOUT_MS);
    const slow = setTimeout(() => { if (gen === this.gen && !this.firstSound) this.maybeFiller(gen); }, 2500);
    let flags = {};
    try {
      const ac = new AbortController(); this.abort = () => ac.abort();
      const res = await fetch('/api/turn', { method: 'POST', signal: ac.signal, headers: auth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ text, history: this.history.slice(-30), mayContinue, idle, night: isNight() }) });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `No answer (${res.status})`); }
      for await (const { event, data } of streamEvents(res.body)) {
        if (gen !== this.gen) return;
        if (event === 'delta') {
          buf += data.text; all += data.text;
          if (mayContinue && mayBeWait(all)) continue; // it may be "[[wait]]": don't speak or show yet
          line.textContent = all.replace(/\[[a-z][a-z ,'-]{0,40}\]\s?/gi, '');
          const { out, rest } = takeSentences(buf); buf = rest;
          out.forEach(collect);
        }
        if (event === 'done') flags = data;
        if (event === 'error') throw new Error(data.error || 'No answer');
      }
    } catch (e) {
      clearTimeout(slow); clearTimeout(this.firstTimer);
      if (gen !== this.gen || e.name === 'AbortError') return;
      line.remove(); this.ui.error(e.message); this.listen(); return;
    }
    clearTimeout(slow); clearTimeout(this.firstTimer);
    if (gen !== this.gen) return;
    if (mayContinue && isWait(all)) { // the model thinks she isn't finished
      this.log('model: not finished, keep listening');
      line.remove(); this.ui.unline('her');
      this.prefix = text; this.patient = true; this.ui.heard(this.prefix);
      this.setPhase('listen'); this.armIdle();
      // She doesn't go on after all: answer what she said.
      this.patientTimer = setTimeout(() => { if (this.phase === 'listen' && this.patient && !this.seg?.spoke && this.prefix) { const t = this.prefix; this.prefix = ''; this.patient = false; this.ask(t); } }, PATIENT_GIVE_UP_MS);
      return;
    }
    collect(buf); flush();
    const reply = all.trim();
    this.history.push({ role: 'user', content: idle ? `(${idle} minute(s) of silence on the line)` : text }, { role: 'assistant', content: reply || '…' });
    if (flags.stay) this.stay = true;
    if (flags.hangup) this.hangAfter = 'bye';
    this.replyDone = true;
    if (!this.playing && !this.queue.length) this.backToListen();
  }

  // ── speaking ──
  say(text, gen = this.gen) {
    for (const part of speechParts(text)) {
      const item = { text: part, gen };
      this.queue.push(item);
    }
    this.prepare(); this.pump();
  }
  // Fetch voice for the sentence being played and the next two; generating is often slower than speaking.
  prepare() { for (const it of this.queue.slice(0, 2)) if (!it.audio) { it.audio = this.voice(it.text); it.audio.catch(() => {}); } }
  async voice(text) {
    const ac = new AbortController(); (this.voiceRequests ||= new Set()).add(ac);
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await fetch('/api/tts', { method: 'POST', signal: ac.signal, headers: auth({ 'Content-Type': 'application/json' }), body: JSON.stringify({ text }) });
          if (!res.ok) { const j = await res.json().catch(() => ({})); if (res.status >= 500 && attempt < 2) throw new TypeError('retry'); throw new Error(j.error || 'The voice did not come through'); }
          const buf = await res.arrayBuffer();
          return await this.ctx.decodeAudioData(buf);
        } catch (e) {
          // Retry only network failures before any audio arrived, so nothing is ever said twice.
          if (e.name === 'AbortError' || !(e instanceof TypeError) || attempt >= 2) throw e;
          await new Promise(r => setTimeout(r, attempt ? 1000 : 400));
        }
      }
    } finally { this.voiceRequests.delete(ac); }
  }
  async pump() {
    if (this.playing) return;
    const item = this.queue.shift();
    if (!item) { if (this.replyDone) this.backToListen(); return; }
    if (item.gen !== this.gen) return this.pump();
    this.playing = true;
    if (!item.audio) item.audio = this.voice(item.text);
    this.prepare();
    const gapTimer = this.lastSegmentEnd ? setTimeout(() => this.maybeFiller(item.gen), FILLER_GAP_MS) : null;
    try {
      const audio = await item.audio;
      clearTimeout(gapTimer); await this.fillerDone;
      const wait = segmentPause(this.lastText, performance.now() - this.lastSegmentEnd, !!this.lastSegmentEnd);
      if (wait) await new Promise(r => setTimeout(r, wait));
      if (item.gen !== this.gen || this.ended) return;
      if (this.phase !== 'speak') { this.setPhase('speak'); if (this.useDictation) this.stopDictation(); }
      if (!this.firstSound) { this.firstSound = true; this.ui.timing((performance.now() - this.askAt) / 1000); }
      await this.play(audio);
      this.spoken += (this.spoken ? ' ' : '') + item.text;
    } catch (e) { if (item.gen === this.gen && e.name !== 'AbortError') this.ui.error(e.message); }
    finally { clearTimeout(gapTimer); }
    if (item.gen !== this.gen || this.ended) return;
    this.lastText = item.text; this.lastSegmentEnd = performance.now();
    this.playing = false; this.pump();
  }
  play(audio) {
    return new Promise(ok => {
      const src = this.ctx.createBufferSource(); src.buffer = audio; src.connect(this.out);
      const done = () => { if (this.current === src) this.current = null; ok(); };
      src.onended = done; this.current = src; src.start();
    });
  }
  stopAudio() { try { this.current?.stop(); } catch { /* ended */ } this.current = null; }
  cancelVoices() { for (const ac of this.voiceRequests || []) ac.abort(); this.queue = []; this.stopAudio(); this.playing = false; }

  backToListen() {
    if (this.ended) return;
    this.ui.heard('');
    if (this.hangAfter) { const why = this.hangAfter; this.hangAfter = null; this.startGrace(why); }
    this.listen();
  }

  // Tap the waveform (or say something loudly with voice interruption on): stop speaking now.
  interrupt(how = 'tap') {
    if (!(this.phase === 'speak' || this.phase === 'think')) return;
    this.log('interrupted by', how);
    const said = this.spoken;
    this.gen++; this.abort?.(); this.cancelVoices(); this.hangAfter = null;
    if (said && this.history.at(-1)?.role === 'assistant') this.history.at(-1).content = said + ' — (cut off here)';
    this.listen();
    if (how === 'voice' && this.seg) { this.seg.spoke = true; this.seg.lastLoud = Date.now(); }
  }

  // ── small sounds while waiting ──
  async loadFillers() {
    try {
      const j = await (await fetch('/api/fillers?lang=' + INFO.lang, { headers: auth() })).json();
      this.fillers = [];
      for (const it of j.items || []) {
        const res = await fetch(`/api/fillers/${it.id}?lang=${INFO.lang}`, { headers: auth() });
        if (res.ok && !this.ended) this.fillers.push({ id: it.id, audio: await this.ctx.decodeAudioData(await res.arrayBuffer()) });
      }
    } catch { /* the call works without them */ }
  }
  maybeFiller(gen) {
    if (this.ended || gen !== this.gen || this.fillerPlaying || !this.fillers?.length) return;
    if (this.fillerAt && performance.now() - this.fillerAt < FILLER_SPACING_MS) return;
    const pool = this.fillers.filter(f => f.id !== this.lastFiller);
    const f = pool[Math.floor(Math.random() * pool.length)]; this.lastFiller = f.id;
    this.fillerAt = performance.now(); this.fillerPlaying = true;
    this.fillerDone = new Promise(ok => { const s = this.ctx.createBufferSource(); s.buffer = f.audio; s.connect(this.out); s.onended = ok; s.start(); })
      .finally(() => { this.fillerPlaying = false; });
  }

  // ── when nobody talks ──
  heardHer() { this.quietSince = 0; this.idleStage = 0; clearTimeout(this.patientTimer); if (this.pendingHang) this.cancelGrace(); this.armIdle(); }
  armIdle() {
    clearTimeout(this.idleTimer); clearTimeout(this.byeTimer);
    if (this.ended || this.pendingHang || !(this.phase === 'listen' || this.phase === 'muted')) return;
    const plan = idlePlan({ night: isNight(), wait: this.waitMode, stay: this.stay, muted: this.muted });
    const since = (this.quietSince ||= Date.now()), left = ms => Math.max(0, ms - (Date.now() - since));
    const step = plan.steps[this.idleStage || 0];
    const quiet = () => !this.ended && (this.phase === 'listen' || this.phase === 'muted') && !this.seg?.spoke && !this.prefix;
    if (step) this.idleTimer = setTimeout(() => {
      if (!quiet()) return;
      this.idleStage = (this.idleStage || 0) + 1; this.log('idle', step.kind);
      if (step.kind === 'sound') { this.lastIdle = idleSound(this.lastIdle, isNight(), step.level); this.replyDone = true; this.say(this.lastIdle); }
      else this.ask('', { idle: step.minute });
    }, left(step.at));
    this.byeTimer = setTimeout(() => {
      if (!quiet()) return;
      if (plan.quiet) return this.hangup();
      this.hangAfter = plan.reason; this.replyDone = true; this.ui.line('me', byeLine(plan.reason, INFO.lang).replace(/\[[^\]]*\]\s?/g, '')); this.say(byeLine(plan.reason, INFO.lang));
    }, left(plan.bye));
  }
  startGrace() {
    clearTimeout(this.idleTimer); clearTimeout(this.byeTimer);
    this.pendingHang = true; this.ui.grace(true);
    this.graceTimer = setTimeout(() => { if (this.pendingHang) this.hangup(); }, GRACE_MS);
  }
  cancelGrace() { clearTimeout(this.graceTimer); this.pendingHang = false; this.ui.grace(false); }

  toggleMute() {
    this.muted = !this.muted;
    this.stream?.getAudioTracks().forEach(t => { t.enabled = !this.muted; });
    if (this.phase === 'listen' || this.phase === 'muted') this.setPhase(this.muted ? 'muted' : 'listen');
    this.armIdle();
    return this.muted;
  }
}

// ── the page ─────────────────────────────────────────────────────
const ui = {
  phase(p) {
    document.body.dataset.phase = p;
    $('#status').textContent = { listen: 'Listening', recognize: 'Listening', think: 'Thinking', speak: 'Speaking', muted: 'Muted', ended: 'Call ended' }[p] || '';
  },
  heard(t) { $('#heard').textContent = t; },
  hint(t) { $('#hint').textContent = t; clearTimeout(ui._h); if (t) ui._h = setTimeout(() => { $('#hint').textContent = ''; }, 4000); },
  error(t) { $('#error').textContent = t; },
  timing(s) { $('#timing').textContent = `first sound ${s.toFixed(1)}s`; },
  line(who, text) {
    const el = document.createElement('p'); el.className = who; el.textContent = text;
    $('#lines').append(el); while ($('#lines').children.length > 6) $('#lines').firstChild.remove();
    if (who === 'her') ui.heard('');
    return el;
  },
  unline(who) { const all = [...$('#lines').querySelectorAll('.' + who)]; all.at(-1)?.remove(); },
  grace(on) { $('#grace').hidden = !on; },
  ended() { document.body.classList.remove('in-call'); clearInterval(ui._clock); },
};

let call = null;
async function startCall() {
  if (INFO.needsToken && !store.get('token')) { openSettings(); $('#token').focus(); return; }
  document.body.classList.add('in-call'); $('#lines').innerHTML = ''; ui.error(''); ui.heard(''); $('#timing').textContent = ''; ui.grace(false);
  call = new Call(ui);
  const t0 = Date.now();
  ui._clock = setInterval(() => { const s = Math.floor((Date.now() - t0) / 1000); $('#clock').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }, 500);
  await call.start();
  drawWave();
}

// Two light trails, like the film: hers in coral, ours in white, scrolling right to left.
function drawWave() {
  const cv = $('#wave'), g = cv.getContext('2d'), her = [], me = [];
  const frame = () => {
    if (!call || call.ended) return;
    const W = cv.width = cv.clientWidth * devicePixelRatio, H = cv.height = cv.clientHeight * devicePixelRatio;
    her.push(Math.min(1, call.herLevel / 25)); me.push(Math.min(1, call.meLevel / 25));
    const n = 180; if (her.length > n) { her.shift(); me.shift(); }
    g.clearRect(0, 0, W, H);
    const line = (arr, color, phase, offset) => {
      g.save(); g.lineCap = 'round'; g.strokeStyle = color; g.shadowColor = color; g.shadowBlur = 16 * devicePixelRatio;
      for (let i = 1; i < arr.length; i++) {
        const x0 = W * (i - 1) / n, x1 = W * i / n, k = i / arr.length;
        const y = j => H / 2 + offset * H + Math.sin(j * 0.18 + phase) * arr[j] * H * 0.32;
        g.globalAlpha = 0.15 + 0.85 * k; g.lineWidth = (1 + 2.5 * k) * devicePixelRatio;
        g.beginPath(); g.moveTo(x0, y(i - 1)); g.lineTo(x1, y(i)); g.stroke();
      }
      g.restore();
    };
    const t = performance.now() / 1000;
    line(her, '#FF9C8C', t * 3, -0.04); line(me, '#FBF6EE', t * 3 + 2, 0.04);
    requestAnimationFrame(frame);
  };
  frame();
}

function openSettings() { $('#settings').showModal(); $('#token').value = store.get('token'); $('#dictation').checked = store.get('dictation') === '1'; $('#dictation').disabled = !SR; $('#barge').checked = store.get('barge') === '1'; }
$('#settings form').addEventListener('submit', () => { store.set('token', $('#token').value.trim()); store.set('dictation', $('#dictation').checked ? '1' : '0'); store.set('barge', $('#barge').checked ? '1' : '0'); });
$('#open-settings').addEventListener('click', openSettings);
$('#call').addEventListener('click', startCall);
$('#hangup').addEventListener('click', () => call?.hangup());
$('#mute').addEventListener('click', e => { const m = call?.toggleMute(); e.currentTarget.classList.toggle('on', !!m); e.currentTarget.setAttribute('aria-pressed', String(!!m)); });
$('#wave').addEventListener('click', () => call?.interrupt('tap'));
$('#grace').addEventListener('click', () => call?.cancelGrace());

fetch('/api/info').then(r => r.json()).then(j => { INFO = j; document.querySelectorAll('.name').forEach(e => { e.textContent = j.name; }); document.title = j.name; }).catch(() => {});
