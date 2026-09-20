#!/usr/bin/env node
// Fresh VM per scenario: prior successful games cannot mask cold-start failures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modules = ['data/melodies', 'js/core/store', 'js/core/pitch', 'js/core/segment',
  'js/core/score', 'js/core/audio', 'js/core/melody', 'js/core/fleet', 'js/core/game', 'js/core/index'];
const source = modules.map(name => [name, fs.readFileSync(path.join(root, 'game', name + '.js'), 'utf8')]);

function makeClock() {
  let now = 0, nextId = 1;
  const tasks = new Map();
  const add = (fn, ms, interval) => {
    const id = nextId++;
    tasks.set(id, { fn, at: now + Math.max(0, ms || 0), interval });
    return id;
  };
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const clock = {
    now: () => now,
    setTimeout: (fn, ms) => add(fn, ms, 0),
    setInterval: (fn, ms) => add(fn, ms, ms),
    clearTimeout: id => tasks.delete(id),
    clearInterval: id => tasks.delete(id),
    pending: () => tasks.size,
    flush,
    async advanceTo(target) {
      assert.ok(target >= now, 'clock must stay monotonic');
      await flush();
      for (let n = 0; n < 100000; n++) {
        const next = [...tasks].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) { now = target; await flush(); return; }
        const [id, task] = next;
        now = task.at;
        if (task.interval) task.at += task.interval;
        else tasks.delete(id);
        task.fn();
        await flush();
      }
      throw new Error('clock runaway');
    },
    async until(predicate, limit = 180000) {
      const deadline = now + limit;
      await flush();
      while (!predicate() && now < deadline) await clock.advanceTo(Math.min(now + 25, deadline));
      assert.ok(predicate(), 'condition reached before deadline');
    }
  };
  return clock;
}

function makeHarness({ mode = 'grant', audio = true, voiced = false } = {}) {
  const clock = makeClock(), streams = [], requests = [], oscillators = [], events = [], ticks = [], plays = [];
  const handlers = new Set(), storage = new Map();
  let latestPhrase = null, attemptAt = null;
  const param = (value = 0) => ({ value, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, cancelScheduledValues() {} });
  const node = extra => Object.assign({ connect() {}, disconnect() { this.disconnected = true; } }, extra);
  const currentNote = () => {
    if (!voiced || attemptAt === null || !latestPhrase) return null;
    const t = clock.now() - attemptAt;
    return latestPhrase.notes.find(n => t >= n.startMs && t < n.startMs + n.durationMs - 70) || null;
  };
  class Context {
    constructor() { this.state = 'running'; this.sampleRate = 48000; this.destination = node(); }
    get currentTime() { return clock.now() / 1000; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    createGain() { return node({ gain: param(1) }); }
    createOscillator() {
      const osc = node({ frequency: param(), detune: param(), starts: [], stops: [],
        start(at) { this.starts.push(at); }, stop(at) { this.stops.push(at === undefined ? clock.now() / 1000 : at); }, setPeriodicWave() {} });
      oscillators.push(osc);
      return osc;
    }
    createBiquadFilter() { return node({ frequency: param(), Q: param(), gain: param() }); }
    createDelay() { return node({ delayTime: param() }); }
    createConvolver() { return node(); }
    createDynamicsCompressor() { return node({ threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() }); }
    createPeriodicWave() { return {}; }
    createBuffer(channels, length) {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return { getChannelData: channel => data[channel] };
    }
    createMediaStreamSource() { return node(); }
    createAnalyser() { return node({ getFloatTimeDomainData: arr => arr.fill(currentNote() ? 0.2 : 0.001) }); }
  }
  const newStream = () => {
    const track = { stopped: 0, stop() { this.stopped++; } };
    const stream = { track, getTracks: () => [track] };
    streams.push(stream);
    return stream;
  };
  const win = {
    ...clock, performance: { now: clock.now }, console,
    localStorage: { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
    document: { addEventListener: (type, fn) => { if (type === 'pointerdown') handlers.add(fn); }, removeEventListener: (type, fn) => handlers.delete(fn) },
    navigator: { mediaDevices: { getUserMedia() {
      if (mode === 'deny') { requests.push({}); return Promise.reject(new Error('denied')); }
      if (mode === 'pending') return new Promise((resolve, reject) => requests.push({ resolve, reject }));
      requests.push({});
      return Promise.resolve(newStream());
    } } }
  };
  if (audio) win.AudioContext = Context;
  win.window = win;
  const context = vm.createContext(win);
  for (const [name, code] of source) vm.runInContext(code, context, { filename: name + '.js' });
  const S = win.Siren;
  for (const type of ['state:change', 'melody:phraseStart', 'melody:replay', 'attempt:start', 'attempt:end', 'attempt:countdown', 'attempt:pitch', 'phrase:result', 'ship:in', 'ship:wrecked', 'game:finale', 'notice', 'error']) {
    S.on(type, payload => events.push({ type, payload, at: clock.now() }));
  }
  S.on('melody:phraseStart', payload => { latestPhrase = payload; });
  S.on('attempt:start', () => { attemptAt = clock.now(); });
  S.on('attempt:end', () => { attemptAt = null; });
  S.Pitch.detectPitch = () => {
    const note = currentNote();
    return note ? { hz: S.Pitch.midiToHz(note.midi), midi: note.midi, conf: 1 } : { hz: 0, midi: 0, conf: 0 };
  };
  const playPhrase = S.Audio.playPhrase;
  S.Audio.playPhrase = (notes, opts) => {
    const duration = playPhrase(notes, opts);
    plays.push({ notes: JSON.parse(JSON.stringify(notes)), opts, at: clock.now(), duration });
    return duration;
  };
  const tick = S.Audio.tick;
  S.Audio.tick = (when, accent) => { ticks.push({ when, accent, phraseIndex: S.getState().phraseIndex }); tick(when, accent); };
  return { S, win, clock, events, requests, streams, newStream, oscillators, handlers, ticks, plays,
    of: type => events.filter(e => e.type === type),
    tap: () => { for (const fn of handlers) fn({ type: 'pointerdown' }); }
  };
}

async function start(h) { await h.S.init({ seed: 4821 }); h.S.start(); await h.clock.flush(); }
function verifyFinale(h) {
  const replay = h.of('melody:replay')[0];
  const result = h.of('state:change').find(e => e.payload.phase === 'RESULT');
  const notes = replay.payload.notes;
  assert.equal(notes.length, 25, 'all five phrases replayed');
  let end = 0;
  for (const n of notes) {
    assert.ok(Math.abs(n.startMs - end) < 0.001, 'notes concatenate with no phrase-index gaps or overlap');
    end = n.startMs + n.durationMs;
  }
  assert.ok(Math.abs(end - 3000) < 0.001, 'finale notes fit 3 seconds');
  const play = h.plays.at(-1);
  assert.ok(result.at >= play.at + play.duration * 1000, 'RESULT waits for scheduled audio');
  assert.ok(result.at - replay.at < 3300, 'finale meets approximate 3-second product target');
  assert.equal(h.S.Audio.stats().activeVoices, 0, 'all audio released on RESULT');
}

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('OK ' + name); }

await test('cold-start denied microphone: five audible/playable rhythm phrases, perfect taps attract 100 ships', async () => {
  const h = makeHarness({ mode: 'deny' });
  h.S.on('attempt:start', () => {
    const notes = h.of('melody:phraseStart').at(-1).payload.notes;
    for (const n of notes) h.clock.setTimeout(h.tap, 500 + n.startMs);
  });
  await start(h);
  await h.clock.until(() => h.S.getState().phase === 'SHARE_CARD');
  const phrases = h.of('melody:phraseStart');
  assert.equal(phrases.length, 5);
  assert.deepEqual(phrases.map(e => e.payload.notes.length), [3, 4, 5, 6, 7]);
  assert.ok(phrases.every(e => e.payload.notes[0].startMs === 0 && !e.payload.familiar));
  assert.equal(h.plays.length, 6, 'five demonstrations plus finale');
  assert.equal(h.of('attempt:start').length, 5);
  assert.equal(h.of('attempt:end').length, 5);
  assert.ok(h.of('attempt:end').every(e => e.payload.reason === 'done'));
  for (const e of h.of('attempt:start')) {
    const firstTick = h.ticks.find(t => t.phraseIndex === e.payload.phraseIndex);
    assert.ok(Math.abs(firstTick.when * 1000 - e.at - 500) < 0.001, 'tick and taps share one 500ms lead-in');
  }
  assert.equal(h.of('ship:in').length, 100);
  assert.equal(h.of('ship:wrecked').length, 100);
  assert.equal(h.S.getState().shipsWrecked, 100);
  assert.equal(h.handlers.size, 0);
  assert.ok(h.of('melody:replay')[0].payload.notes.every(n => n.midi === 60), 'fallback finale uses its own C4 notes');
  verifyFinale(h);
});

await test('LISTEN replay cancels old oscillators and deadline; replay is limited to once per phrase', async () => {
  const h = makeHarness(); await start(h);
  const first = h.plays[0];
  await h.clock.advanceTo(700);
  const previous = h.oscillators.slice();
  assert.equal(h.S.replayPhrase(), true);
  assert.equal(h.S.replayPhrase(), false);
  assert.ok(previous.every(o => o.disconnected), 'old scheduled and playing oscillators disconnected');
  assert.ok(previous.every(o => o.stops.some(t => t <= 0.7)), 'old scheduled oscillators cancelled immediately');
  const oldDeadline = first.at + Math.round(first.duration * 1000) + 260;
  await h.clock.advanceTo(oldDeadline + 1);
  assert.equal(h.S.getState().subPhase, 'LISTEN', 'original timer cannot interrupt replay');
  const replay = h.plays[1];
  await h.clock.advanceTo(replay.at + Math.round(replay.duration * 1000) + 261);
  assert.equal(h.S.getState().subPhase, 'COUNTDOWN');
  h.S.abort();
  assert.equal(h.clock.pending(), 0);
});

await test('normal short voiced phrase finishes instead of being discarded as silence; RECORD has no null state', async () => {
  const h = makeHarness({ voiced: true }); await start(h);
  await h.clock.until(() => h.of('attempt:end').length === 1);
  assert.equal(h.of('attempt:end')[0].payload.reason, 'done');
  const startEvent = h.of('attempt:start')[0];
  const endEvent = h.of('attempt:end')[0];
  assert.ok(h.of('state:change').filter(e => e.at >= startEvent.at && e.at <= endEvent.at)
    .every(e => e.payload.subPhase !== null));
  h.S.abort();
});

await test('normal cold-start full run: silent attempts stay silent, finale order and microphone release are correct', async () => {
  const h = makeHarness(); await start(h);
  await h.clock.until(() => h.S.getState().phase === 'SHARE_CARD');
  assert.equal(h.of('attempt:end').length, 5);
  assert.ok(h.of('attempt:end').every(e => e.payload.reason === 'silence'));
  assert.ok(h.streams.every(s => s.track.stopped === 1));
  assert.deepEqual(Array.from(h.of('melody:replay')[0].payload.notes, n => n.midi),
    h.of('melody:phraseStart').flatMap(e => Array.from(e.payload.notes, n => n.midi)));
  verifyFinale(h);
});

await test('abort while permission pending rejects stale completion; repeated start never creates duplicate requests', async () => {
  const h = makeHarness({ mode: 'pending' }); await start(h);
  h.S.start(); assert.equal(h.requests.length, 1);
  h.S.abort(); h.S.start(); assert.equal(h.requests.length, 2);
  const current = h.newStream(); h.requests[1].resolve(current); await h.clock.flush();
  assert.equal(h.S.getState().phase, 'LEARN_LOOP');
  const stale = h.newStream(); h.requests[0].resolve(stale); await h.clock.flush();
  assert.equal(stale.track.stopped, 1);
  assert.equal(current.track.stopped, 0, 'late old permission does not release current stream');
  assert.equal(h.of('melody:phraseStart').length, 1);
  h.S.abort(); assert.equal(current.track.stopped, 1);
  assert.equal(h.clock.pending(), 0);
});

await test('reinitializing a live run releases microphone, scheduled audio and stale game work', async () => {
  const h = makeHarness(); await start(h);
  assert.ok(h.clock.pending() > 0);
  await h.S.init({ seed: 99 });
  assert.equal(h.S.getState().phase, 'HOME');
  assert.equal(h.S.getState().seed, 99);
  assert.equal(h.clock.pending(), 0);
  assert.equal(h.S.Audio.stats().activeVoices, 0);
  assert.ok(h.streams.every(s => s.track.stopped === 1));
});

await test('audio-unavailable fallback also completes without a crashing AudioContext call', async () => {
  const h = makeHarness({ audio: false }); await start(h);
  await h.clock.until(() => h.S.getState().phase === 'SHARE_CARD');
  assert.equal(h.of('attempt:end').length, 5);
  assert.equal(h.of('ship:in').length, 100);
});

await test('abort from synchronous state/event listeners never rearms abandoned work', async () => {
  const targets = [
    ['state:change', p => p.phase === 'PERM_REQUEST'],
    ['state:change', p => p.subPhase === 'LISTEN'],
    ['melody:phraseStart'], ['attempt:countdown'], ['attempt:start'], ['attempt:pitch'], ['attempt:end'],
    ['state:change', p => p.subPhase === 'PULL'], ['phrase:result'], ['game:finale'], ['melody:replay'],
    ['state:change', p => p.phase === 'RESULT']
  ];
  for (const [event, match = () => true] of targets) {
    const h = makeHarness(); let aborted = false;
    h.S.on(event, payload => { if (!aborted && match(payload)) { aborted = true; h.S.abort(); } });
    await start(h);
    await h.clock.until(() => aborted);
    const eventCount = h.events.length;
    await h.clock.advanceTo(h.clock.now() + 20000);
    assert.equal(h.S.getState().phase, 'HOME', event);
    assert.equal(h.events.length, eventCount, event + ' emitted stale events');
    assert.equal(h.clock.pending(), 0, event + ' left timers');
    assert.equal(h.handlers.size, 0);
    assert.equal(h.S.Audio.stats().activeVoices, 0);
  }
});

console.log(`Lifecycle regressions passed: ${passed} isolated scenarios.`);
