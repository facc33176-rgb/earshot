import test from 'node:test';
import assert from 'node:assert/strict';
import { takeSentences, hasSpeech, speechParts, segmentPause } from '../web/lib/speech.mjs';
import { joinSaid, isWait, mayBeWait } from '../web/lib/turn.mjs';
import { InputGate } from '../web/lib/gate.mjs';
import { idlePlan, idleSound, askedToWait, isNight, byeLine } from '../web/lib/idle.mjs';

test('sentences come out as soon as they end', () => {
  const r = takeSentences('Hey you. I was just thinking about it! And then');
  assert.deepEqual(r.out, ['Hey you.', 'I was just thinking about it!']);
  assert.equal(r.rest.trim(), 'And then');
  assert.deepEqual(takeSentences('今天好累。你呢？').out, ['今天好累。', '你呢？']);
  assert.deepEqual(takeSentences('Ask Dr. Lee about it. ').out, ['Ask Dr. Lee about it.']);
  assert.deepEqual(takeSentences('3.5 hours. ').out, ['3.5 hours.']);
});

test('tags alone are not speech', () => {
  assert.equal(hasSpeech('[laughs]'), false);
  assert.equal(hasSpeech('[[wait]]'), false);
  assert.equal(hasSpeech('[laughs] okay'), true);
  assert.equal(hasSpeech('……'), false);
});

test('very long sentences are split under the limit without breaking words', () => {
  const long = Array(400).fill('word').join(' ');
  const parts = speechParts(long, 100);
  assert.ok(parts.every(p => p.length <= 100));
  assert.equal(parts.join(' ').split(/\s+/).length, 400);
});

test('pause between segments counts the time already waited', () => {
  assert.equal(segmentPause('Hi.', 0, false), 0);
  assert.equal(segmentPause('Hi.', 50, true), 150);
  assert.equal(segmentPause('Really?', 0, true), 300);
  assert.equal(segmentPause('Hi.', 900, true), 0);
});

test('bursts of speech are glued back together', () => {
  assert.equal(joinSaid('I think we', 'should go'), 'I think we should go');
  assert.equal(joinSaid('我今天', '去了超市'), '我今天，去了超市');
  assert.equal(joinSaid('我今天，', '去了'), '我今天，去了');
  assert.equal(joinSaid('', 'hi'), 'hi');
});

test('[[wait]] is recognised, also half-streamed', () => {
  assert.ok(isWait('[[wait]]'));
  assert.ok(mayBeWait('[[wa'));
  assert.ok(mayBeWait('['));
  assert.ok(!mayBeWait('Well'));
  assert.ok(!isWait('Sure, [[wait]]'));
});

test('input gate ignores clicks but keeps a sustained soft voice', () => {
  const g = new InputGate();
  for (let t = 0; t < 2000; t += 16) g.loud(0.5, t); // quiet room
  assert.equal(g.loud(3, 2000), false); // first loud frame: not yet
  assert.equal(g.loud(3, 2050), false);
  assert.equal(g.loud(3, 2110), true); // 100 ms of it: yes
  assert.equal(g.loud(0.5, 2200), false);
  assert.equal(g.loud(9, 2300), true); // clearly loud: immediately
});

test('silence plan: day steps, night is gentler, stay never pesters', () => {
  assert.equal(idlePlan().steps[0].kind, 'sound');
  assert.equal(idlePlan({ night: true }).reason, 'asleep');
  assert.deepEqual(idlePlan({ stay: true }).steps, []);
  assert.ok(idlePlan({ wait: true }).bye > idlePlan().bye);
  assert.notEqual(idleSound('[coughs softly] Mm.', false, 1, () => 0), '[coughs softly] Mm.');
  assert.ok(askedToWait('hold on a sec'));
  assert.ok(askedToWait('等一下'));
  assert.ok(isNight(new Date(2026, 0, 1, 23, 30)));
  assert.ok(!isNight(new Date(2026, 0, 1, 15, 0)));
  assert.match(byeLine('asleep', 'en', () => 0), /fall asleep/);
});
