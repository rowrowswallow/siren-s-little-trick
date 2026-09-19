/* 塞壬的小把戏 —— 后端：game.js（状态机 + 编排）
 *
 * 依据：02-后端开发规格书 D3 / D9 / D10 / D11，对外契约 03-接口契约 C1–C4
 *
 * 硬规则（D0）：
 *   · 本文件不碰 DOM 渲染。唯一豁免：localStorage（store.js）与 AudioContext（audio.js）
 *   · 不返回任何中文话术；只广播技术状态码（契约 C4）
 *   · 音高实时数据每 50ms 推一次（D11）
 *
 * 状态机（D3）：
 *   BOOT → HOME → PERM_REQUEST → (GRANTED) LEARN_LOOP
 *                               └ (DENIED)  → RHYTHM_FALLBACK → FINALE
 *   LEARN_LOOP(i=0..4): LISTEN → COUNTDOWN → RECORD → ANALYZE → PULL → PHRASE_RESULT
 *   FINALE → RESULT → SHARE_CARD → HOME
 */

(function (global) {
  'use strict';

  var Siren = global.Siren = global.Siren || {};
  var Pitch = Siren.Pitch;
  var Segment = Siren.Segment;
  var Score = Siren.Score;
  var Audio = Siren.Audio;
  var Melody = Siren.Melody;
  var Fleet = Siren.Fleet;
  var Store = Siren.Store;

  var CFG = Fleet.CONFIG;

  // ---------------------------------------------------------------- 状态

  var phase = 'BOOT';
  var subPhase = null;
  var phraseIndex = 0;
  var seed = 0;
  var phrases = [];
  var shipsAll = [];
  var shipsByWave = [];
  var shipsSpawned = 0;
  var shipsWrecked = 0;
  var scoreSum = 0;
  var rng = null;

  var listeners = {};
  var timers = [];
  var pitchTimer = null;
  var stopRecord = null;
  var replayUsed = false;

  // 采音状态
  var mic = {
    stream: null, source: null, analyser: null, buf: null,
    noiseFloor: 0.004, peakRms: 0,
    inputGain: 1,        // 校准阶段自动算出的输入增益
    inputPeak: 0,        // 校准期测到的原始峰值
    gainBuf: null        // 施加增益后的副本（检测用）
  };
  var recordFrames = [];
  var recordStartAt = 0;
  var recordDuration = 0;
  var recordEndReason = null;
  var lastVoicedAt = 0;
  var lastPitchSent = 0;
  var countdownValue = 0;
  var pendingMicResolve = null;

  var fallbackTarget = null;      // 兜底模式的节奏目标
  var fallbackTaps = [];
  var fallbackTapHandler = null;

  var lastEnding = null;
  var lastTitleRevealed = null;

  // ---------------------------------------------------------------- 事件总线

  function on(type, handler) {
    if (typeof handler !== 'function') return function () {};
    if (!listeners[type]) listeners[type] = [];
    listeners[type].push(handler);
    return function off() { off_(type, handler); };
  }

  function off_(type, handler) {
    var arr = listeners[type];
    if (!arr) return;
    var i = arr.indexOf(handler);
    if (i >= 0) arr.splice(i, 1);
  }

  function emit(type, payload) {
    var arr = listeners[type];
    if (!arr || !arr.length) return;
    var snapshot = arr.slice();
    for (var i = 0; i < snapshot.length; i += 1) {
      try {
        snapshot[i](payload);
      } catch (e) {
        // 前端回调异常不得影响后端状态机
        if (global.console && global.console.warn) {
          global.console.warn('[Siren] listener error on "' + type + '"', e);
        }
      }
    }
  }

  /** 技术状态码（契约 C4）——绝不带中文文案 */
  function notice(code) { emit('notice', { code: code, level: 'notice' }); }
  function error(code, message) { emit('error', { code: code, message: message || '' }); }

  function setPhase(next, sub) {
    phase = next;
    subPhase = sub === undefined ? subPhase : sub;
    emit('state:change', { phase: phase, subPhase: subPhase, phraseIndex: phraseIndex });
  }

  function setSub(next) {
    subPhase = next;
    emit('state:change', { phase: phase, subPhase: subPhase, phraseIndex: phraseIndex });
  }

  function getState() {
    return {
      phase: phase,
      phraseIndex: phraseIndex,
      totalPhrases: CFG.PHRASES,
      subPhase: subPhase,
      shipsTotal: CFG.FLEET_TOTAL,
      shipsSpawned: shipsSpawned,
      shipsWrecked: shipsWrecked,
      seed: seed
    };
  }

  // ---------------------------------------------------------------- 定时器与时钟

  /**
   * 单调时钟。
   * ⚠️ 不用 Date.now()：设备改时间 / 时区跳变会让"静默 3 秒""回合 6 秒上限"
   *    这类判定出错。performance.now() 单调且精度更高。
   */
  function monoNow() {
    if (global.performance && typeof global.performance.now === 'function') {
      return global.performance.now();
    }
    return Date.now();
  }

  function later(fn, ms) {
    var id = global.setTimeout(function () {
      timers = timers.filter(function (t) { return t !== id; });
      fn();
    }, ms);
    timers.push(id);
    return id;
  }

  function clearTimers() {
    for (var i = 0; i < timers.length; i += 1) global.clearTimeout(timers[i]);
    timers = [];
    if (pitchTimer) { global.clearInterval(pitchTimer); pitchTimer = null; }
  }

  // ---------------------------------------------------------------- 麦克风

  function requestMic() {
    return new Promise(function (resolve) {
      if (!global.navigator || !global.navigator.mediaDevices ||
          typeof global.navigator.mediaDevices.getUserMedia !== 'function') {
        resolve(false);
        return;
      }
      global.navigator.mediaDevices.getUserMedia({
        audio: {
          // ⚠️ D4.7：这三个 false 是全项目最重要的配置
          echoCancellation: false,   // 会吃掉人声
          noiseSuppression: false,   // 会破坏音高
          autoGainControl: false     // 动态压缩影响判定
        }
      }).then(function (stream) {
        mic.stream = stream;
        var c = Audio.ensureAudio();
        mic.source = c.createMediaStreamSource(stream);
        mic.analyser = c.createAnalyser();
        mic.analyser.fftSize = 2048;
        mic.analyser.smoothingTimeConstant = 0;
        mic.source.connect(mic.analyser);
        // ⚠️ 绝不 connect 到 destination，否则啸叫
        mic.buf = new Float32Array(2048);
        pendingMicResolve = resolve;
        resolve(true);
      }).catch(function (err) {
        error('MIC_DENIED', err && err.name ? err.name : 'getUserMedia failed');
        resolve(false);
      });
    });
  }

  function releaseMic() {
    if (mic.stream) {
      var tracks = mic.stream.getTracks();
      for (var i = 0; i < tracks.length; i += 1) tracks[i].stop();
    }
    if (mic.source) { try { mic.source.disconnect(); } catch (e) { /* 忽略 */ } }
    mic.stream = null;
    mic.source = null;
    mic.analyser = null;
  }

  function rmsOf(buf) {
    var sum = 0;
    for (var i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }

  /**
   * 采集 500ms 环境噪音基线（D3：COUNTDOWN 期间做）。
   * ⚠️ 用"固定采样次数"而非挂钟判定结束：容器里 setTimeout 有节流，
   *    挂钟判定会让这段校准被拖长甚至不结束（自己写测试时就先踩到了）。
   */
  function calibrateNoise(done) {
    if (!mic.analyser) { done(); return; }
    var samples = [];
    var remaining = 12;          // 12 × 40ms ≈ 500ms
    var step = function () {
      if (!mic.analyser) { done(); return; }
      mic.analyser.getFloatTimeDomainData(mic.buf);
      samples.push(rmsOf(mic.buf));
      remaining -= 1;
      if (remaining > 0) {
        later(step, 40);
        return;
      }
      samples.sort(function (a, b) { return a - b; });
      mic.noiseFloor = samples[Math.floor(samples.length * 0.75)];
      done();
    };
    step();
  }

  // ---------------------------------------------------------------- 乐句流程

  function startRun() {
    rng = Fleet.mulberry32(seed);
    Fleet.resetIds();
    var built = Melody.buildPhrases(seed, CFG.NOTES_PER_PHRASE);
    phrases = built.phrases;
    shipsAll = [];
    shipsByWave = [];
    shipsSpawned = 0;
    shipsWrecked = 0;
    scoreSum = 0;
    phraseIndex = 0;
    lastEnding = null;
    lastTitleRevealed = null;
    Store.set(Store.KEYS.SEED, seed);
    setPhase('LEARN_LOOP');
    runPhrase();
  }

  function currentPhrase() { return phrases[phraseIndex]; }

  function phraseNotes() {
    return Melody.toNotes(currentPhrase(), CFG.BPM);
  }

  function runPhrase() {
    replayUsed = false;
    var phrase = currentPhrase();
    var notes = phraseNotes();

    setSub('LISTEN');
    emit('melody:phraseStart', {
      phraseIndex: phraseIndex,
      notes: notes,
      eighths: phrase.eighths.slice(),
      familiar: !!phrase.familiar,
      seed: seed
    });

    // 海妖唱出本乐句；后端负责播放，前端跟着 notes[] 做视觉同步（契约 C3）
    var sungS = Audio.playPhrase(notes);
    var listenMs = Math.max(900, Math.round(sungS * 1000) + 260);

    later(function () {
      setSub('COUNTDOWN');
      calibrateNoise(function () {
        countdownStep(3);
      });
    }, listenMs);
  }

  function countdownStep(n) {
    countdownValue = n;
    emit('attempt:countdown', { from: n });
    if (n > 1) {
      later(function () { countdownStep(n - 1); }, 700);
    } else {
      later(function () {
        // 正常模式与兜底模式共用倒计时，收口处分流
        if (phase === 'RHYTHM_FALLBACK') beginFallbackRecord();
        else beginRecord();
      }, 700);
    }
  }

  function beginRecord() {
    setSub('RECORD');
    recordFrames = [];
    recordStartAt = monoNow();
    recordDuration = 0;
    recordEndReason = null;
    lastVoicedAt = monoNow();
    lastPitchSent = 0;
    mic.peakRms = 0;

    // 音块提示：把目标音在演唱时同步提示一遍（极短极干，绝不抢注意力）
    var notes = phraseNotes();
    var base = Audio.ensureAudio().currentTime + 0.05;
    for (var i = 0; i < notes.length; i += 1) {
      Audio.cue(notes[i].midi, base + notes[i].startMs / 1000);
    }

    emit('attempt:start', { phraseIndex: phraseIndex });
    setSub(null);
    subPhase = 'RECORD';

    // D11：音高实时数据每 50ms 推一次
    pitchTimer = global.setInterval(pumpPitch, 50);

    // 上限 6s；静默 3s 中止（D3）
    later(function () { finishRecord('timeout'); }, CFG.RECORD_MAX_MS);
  }

  function pumpPitch() {
    if (!mic.analyser) { finishRecord('timeout'); return; }
    var now = monoNow();
    var t = now - recordStartAt;

    if (mic.buf.length !== 2048) mic.buf = new Float32Array(2048);
    mic.analyser.getFloatTimeDomainData(mic.buf);

    // ⚠️ 电平统计用**原始**缓冲：它反映麦克风真实水平，
    //    也是下一句增益自适应的依据。检测才用增益后的副本。
    var rms = rmsOf(mic.buf);
    if (rms > mic.peakRms) mic.peakRms = rms;

    var detectBuf = mic.buf;
    if (mic.inputGain > 1.05) {
      if (!mic.gainBuf || mic.gainBuf.length !== mic.buf.length) {
        mic.gainBuf = new Float32Array(mic.buf.length);
      }
      mic.gainBuf.set(mic.buf);
      Audio.applyInputGain(mic.gainBuf, mic.inputGain);
      detectBuf = mic.gainBuf;
    }

    var r = Pitch.detectPitch(detectBuf, Audio.ensureAudio().sampleRate, 2048);
    var voiced = r.hz > 0;

    // 记录帧（供切分与打分）
    recordFrames.push({ t: t, hz: r.hz, conf: r.conf, rms: rms });

    // 契约 C3：attempt:pitch 载荷 { t, midi, cents, conf, voiced }
    var cents = 0;
    if (voiced) {
      var nearest = Math.round(r.midi);
      cents = (r.midi - nearest) * 100;
      lastVoicedAt = now;
    }
    emit('attempt:pitch', {
      t: t,
      midi: voiced ? r.midi : 0,
      cents: cents,
      conf: r.conf,
      voiced: voiced
    });

    // 静默中止：不广播任何提示文案，只广播 reason: 'silence'（D3）
    if (now - lastVoicedAt >= CFG.SILENCE_ABORT_MS) {
      finishRecord('silence', true);
      return;
    }

    // 噪音环境提示（契约 C4 NOISY_ENV），不中断游戏
    if (mic.noiseFloor > 0 && mic.peakRms > 0 && (mic.peakRms / mic.noiseFloor) < 2.0) {
      notice('NOISY_ENV');
    }
  }

  /**
   * 本句结束后更新输入增益，供**下一句**使用。
   *
   * 为什么在句末而不是开场校准：
   *   开场（LISTEN/COUNTDOWN）玩家还没出声，测不到语音峰值；
   *   只有在真实演唱中量到的峰值才准。代价是第一句用默认增益（1x），
   *   从第二句起自动补偿——对于设备电平偏低的用户，这已经是能做到的最好情况，
   *   而且完全不需要改变用户流程或额外让他"唱一声来校准"。
   */
  function adaptInputGain() {
    if (!(mic.peakRms > 0)) return;
    if (mic.inputPeak > 0 && mic.peakRms <= mic.inputPeak) return;   // 没有新信息
    mic.inputPeak = mic.peakRms;
    var next = Audio.computeInputGain(mic.peakRms, mic.noiseFloor);
    // 只增不减：一次唱得轻不该把已经算好的补偿撤掉
    if (next > mic.inputGain) mic.inputGain = next;
  }

  function finishRecord(reason, isSilence) {
    if (pitchTimer === null && recordEndReason !== null) return;
    if (pitchTimer) { global.clearInterval(pitchTimer); pitchTimer = null; }
    if (recordEndReason !== null) return;
    recordEndReason = isSilence ? 'silence' : (reason || 'done');
    recordDuration = monoNow() - recordStartAt;

    emit('attempt:end', { reason: recordEndReason });
    setSub('ANALYZE');

    var phrase = currentPhrase();
    var score = 0;

    // 用本句实测峰值更新增益（供下一句），并给出"收不进声音"的技术提示
    adaptInputGain();
    if (mic.peakRms > 0 && mic.peakRms < 0.01) {
      // 契约 C4 的 LOW_CONFIDENCE 前端文案为"有点听不清，再靠近一点"，
      // 正是这里要表达的意思。**不擅自新增状态码**——契约 C4 表是封闭的，
      // 若需要专门的"输入太弱"码，应由契约维护者补充。
      notice('LOW_CONFIDENCE');
    }

    if (recordEndReason !== 'silence') {
      var seg = Segment.segment(recordFrames, { noiseFloor: mic.noiseFloor });
      var target = Score._buildTarget(phrase,
        (function (sc) { return function (d) { return Melody.toMidi(d, sc); }; })(phrase.scale),
        CFG.BPM);
      var result = Score._scoreAttempt(target, seg.notes);
      score = result.score;
      // 连续低置信度 → LOW_CONFIDENCE（契约 C4），不扣分
      var lowConf = 0;
      for (var i = 0; i < recordFrames.length; i += 1) {
        if (recordFrames[i].hz > 0 && recordFrames[i].conf < 0.5) lowConf += 1;
      }
      if (seg.notes.length === 0 || lowConf > recordFrames.length * 0.6) notice('LOW_CONFIDENCE');
    } else {
      notice('NO_INPUT');   // 契约 C4：建议前端不显示文字，改让海妖沉回水中
    }

    scoreSum += score;
    later(function () { pullWave(score); }, 120);
  }

  /** D9：生成 20 条新船 → 逐船判定 → 广播入场与触礁 */
  function pullWave(score) {
    setSub('PULL');

    var ships = Fleet.spawnWave(rng, phraseIndex);
    shipsByWave.push(ships);
    for (var i = 0; i < ships.length; i += 1) {
      shipsAll.push(ships[i]);
      shipsSpawned += 1;
    }

    var res = Fleet.resolveWave(ships, score);
    shipsWrecked += res.wrecked.length;

    // 入场：按 entryDelayMs 错开（契约 C3：一条船摊平成一组字段）
    for (var k = 0; k < ships.length; k += 1) {
      (function (ship) {
        later(function () {
          emit('ship:in', {
            id: ship.id,
            lane: ship.lane,
            depth: ship.depth,
            side: ship.side,
            entryDelayMs: ship.entryDelayMs
          });
        }, ship.entryDelayMs);
      })(ships[k]);
    }

    // 触礁：延后一点，先让船进场
    var wreckDelay = 620;
    for (var w = 0; w < res.wrecked.length; w += 1) {
      (function (ship, idx) {
        later(function () {
          emit('ship:wrecked', { id: ship.id, pull: ship.pull });
        }, wreckDelay + idx * 45);
      })(res.wrecked[w], w);
    }

    var settleMs = wreckDelay + res.wrecked.length * 45 + 320;

    later(function () {
      setSub('PHRASE_RESULT');
      emit('phrase:result', {
        phraseIndex: phraseIndex,
        newWrecked: res.wrecked.length,
        totalWrecked: shipsWrecked
      });

      // D8：歌名仅在 V4 结算且 score ≥ 60 时广播（仅熟曲）
      if (Melody.shouldRevealTitle(currentPhrase(), score)) {
        lastTitleRevealed = currentPhrase().title;
        emit('melody:titleReveal', { title: lastTitleRevealed });
      }

      later(function () {
        phraseIndex += 1;
        if (phraseIndex >= CFG.PHRASES) startFinale();
        else runPhrase();
      }, 1500);
    }, settleMs);
  }

  // ---------------------------------------------------------------- 终局

  function startFinale() {
    setPhase('FINALE');
    emit('game:finale', {
      wreckedTotal: shipsWrecked,
      ending: Fleet.decideEnding(shipsWrecked),
      seed: seed
    });
    lastEnding = Fleet.decideEnding(shipsWrecked);

    // 全曲回放（D3：REPLAY 3s 全曲回放）
    var all = [];
    for (var i = 0; i < phrases.length; i += 1) {
      var notes = Melody.toNotes(phrases[i], CFG.BPM);
      var step = 0.28;   // 回放提速，压到约 3 秒
      for (var j = 0; j < notes.length; j += 1) {
        all.push({
          midi: notes[j].midi,
          startMs: (i * notes.length + j) * step * 1000,
          durationMs: step * 1000,
          degree: notes[j].degree
        });
      }
    }
    emit('melody:replay', { notes: all });
    Audio.playPhrase(all, { gain: 0.12 });

    var replayMs = Math.max(1500, all.length * 280 + 600);
    later(function () {
      setPhase('RESULT');
      Store.commitRun(shipsWrecked, scoreSum);
      later(function () { setPhase('SHARE_CARD'); }, 400);
    }, replayMs);
  }

  // ---------------------------------------------------------------- 兜底模式（D10）

  /**
   * 无麦克风兜底：海妖以固定音高 C4 唱纯节奏，玩家点屏幕打拍子。
   * 船队完全沿用 D9，分数换算一致——兜底模式不残疾（D10）。
   */
  function startFallbackRun() {
    setPhase('RHYTHM_FALLBACK');
    rng = Fleet.mulberry32(seed);
    Fleet.resetIds();
    shipsAll = [];
    shipsByWave = [];
    shipsSpawned = 0;
    shipsWrecked = 0;
    scoreSum = 0;
    phraseIndex = 0;

    // 目标节奏：每句 N 拍，每拍一个八分格（C4 = MIDI 60）
    fallbackTarget = [];
    var cursor = 0;
    for (var i = 0; i < CFG.PHRASES; i += 1) {
      var count = CFG.NOTES_PER_PHRASE[i];
      var notes = [];
      for (var k = 0; k < count; k += 1) {
        notes.push({
          midi: 60,
          startMs: cursor,
          durationMs: Audio.eighthMs() * 2,
          degree: 0
        });
        cursor += Audio.eighthMs() * 2;
      }
      fallbackTarget.push({ phraseIndex: i, notes: notes, cursorEnd: cursor });
    }

    runFallbackPhrase();
  }

  function runFallbackPhrase() {
    var target = fallbackTarget[phraseIndex];
    setSub('LISTEN');
    emit('melody:phraseStart', {
      phraseIndex: phraseIndex,
      notes: target.notes,
      eighths: target.notes.map(function () { return 2; }),
      familiar: false,
      seed: seed
    });

    var leadInMs = 900;
    later(function () {
      setSub('COUNTDOWN');
      countdownStep(3);
    }, leadInMs);
  }

  function beginFallbackRecord() {
    setSub('RECORD');
    fallbackTaps = [];
    var target = fallbackTarget[phraseIndex];
    var startAt = monoNow();
    emit('attempt:start', { phraseIndex: phraseIndex });

    // 海妖唱纯节奏（固定 C4），玩家跟着点
    var base = Audio.ensureAudio().currentTime + 0.5;
    for (var i = 0; i < target.notes.length; i += 1) {
      Audio.tick(base + (target.notes[i].startMs + 500) / 1000, i === 0);
    }

    fallbackTapHandler = function () {
      fallbackTaps.push({ t: monoNow() - startAt - 500 });
    };
    global.document.addEventListener('pointerdown', fallbackTapHandler, { passive: true });

    later(function () { finishFallbackRecord(); }, Math.max(1500, target.notes.length * Audio.eighthMs() * 2 + 1200));
  }

  function finishFallbackRecord() {
    if (fallbackTapHandler) {
      global.document.removeEventListener('pointerdown', fallbackTapHandler);
      fallbackTapHandler = null;
    }
    setSub('ANALYZE');

    var target = fallbackTarget[phraseIndex];
    var targetNotes = [];
    for (var i = 0; i < target.notes.length; i += 1) {
      targetNotes.push({
        midi: 60,
        hz: Pitch.midiToHz(60),
        onsetMs: target.notes[i].startMs,
        durationMs: target.notes[i].durationMs
      });
    }
    var actualNotes = [];
    for (var k = 0; k < fallbackTaps.length; k += 1) {
      actualNotes.push({ midi: 60, hz: Pitch.midiToHz(60), onsetMs: fallbackTaps[k].t, durationMs: 150 });
    }
    actualNotes.sort(function (a, b) { return a.onsetMs - b.onsetMs; });

    var result = Score._scoreRhythmOnly(targetNotes, actualNotes);
    scoreSum += result.score;

    later(function () { pullWave(result.score); }, 120);
  }

  // ---------------------------------------------------------------- API（契约 C1）

  function init(options) {
    options = options || {};
    if (options.storagePrefix && Store.KEYS) {
      // 前缀由 store.js 在加载时固定；这里只接受默认前缀，避免破坏既定键名
      if (options.storagePrefix !== 'siren.') notice('STORAGE_FAILED');
    }
    if (options.seed !== undefined && options.seed !== null) {
      seed = Number(options.seed) || 0;
    } else {
      var saved = Store.getNumber(Store.KEYS.SEED, 0);
      seed = saved || (Math.floor(Math.random() * 900000) + 1000);
    }
    Store.set(Store.KEYS.SEED, seed);
    if (!Store.available) notice('STORAGE_FAILED');

    setPhase('HOME', null);
    return Promise.resolve(getState());
  }

  function start() {
    if (phase !== 'HOME' && phase !== 'SHARE_CARD' && phase !== 'RESULT') {
      // 允许在结算页再次开始
      if (phase !== 'RHYTHM_FALLBACK') { /* 其它状态忽略 */ }
    }
    clearTimers();
    setPhase('PERM_REQUEST');

    // start() 必须由用户手势调用：在这里解锁 AudioContext（D4.1）
    try {
      Audio.ensureAudio();
    } catch (e) {
      error('MIC_DENIED', 'AudioContext unavailable');
      later(function () { startFallbackRun(); }, 0);
      return;
    }

    requestMic().then(function (ok) {
      if (ok) {
        startRun();
      } else {
        // 契约 C4：MIC_DENIED 是 error 级（前端文案"如果您拒绝了麦克风权限…"）。
        // ⚠️ 这里曾误发成 notice('MIC_DENIED')，导致前端按契约监听 error 事件时
        //    永远收不到权限失败通知。已修正为 error，并保持 level 与契约一致。
        error('MIC_DENIED', 'getUserMedia rejected');
        // 契约 C4 另有 MIC_RETRY（notice，"再点一下让她开口"）：
        // 权限被系统重置或切后台回来时用它提示重试。此前该码从未被广播过。
        notice('MIC_RETRY');
        startFallbackRun();
      }
    });
  }

  /** 重听当前乐句（每句限 1 次） */
  function replayPhrase() {
    if (phase !== 'LEARN_LOOP' || replayUsed) return false;
    if (subPhase !== 'LISTEN') return false;
    replayUsed = true;
    var notes = phraseNotes();
    emit('melody:phraseStart', {
      phraseIndex: phraseIndex,
      notes: notes,
      eighths: currentPhrase().eighths.slice(),
      familiar: !!currentPhrase().familiar,
      seed: seed
    });
    Audio.playPhrase(notes);
    return true;
  }

  function abort() {
    clearTimers();
    if (fallbackTapHandler && global.document) {
      global.document.removeEventListener('pointerdown', fallbackTapHandler);
      fallbackTapHandler = null;
    }
    releaseMic();
    Audio.release();
    phraseIndex = 0;
    setPhase('HOME', null);
  }

  Siren.Game = {
    init: init,
    start: start,
    replayPhrase: replayPhrase,
    abort: abort,
    on: on,
    off: off_,
    getState: getState,
    // 内部：供 index.js 组装与离线验证
    _emit: emit,
    _setPhase: setPhase,
    _startFallbackRun: startFallbackRun,
    _beginFallbackRecord: beginFallbackRecord,
    _config: CFG
  };
})(typeof window !== 'undefined' ? window : globalThis);
