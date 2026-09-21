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

  // ---------------------------------------------------------------- 常量

  /**
   * 引导关的示范性船队强度（PRD §7.5.1.2）。
   * 引导关不评分，但**必须有船动**——玩家要学到的是"我的声音让船动起来"这个因果，
   * 而不是"对着麦克风发声"。取 70 分对应的强度：船成片涌向礁石，视觉上足够明确。
   */
  var TUTORIAL_DEMO_SCORE = 70;

  /**
   * 单句录音缓存的样本上限（防内存失控）。
   * 6s × 48kHz = 288000 样本；留 10% 余量取 320000（≈1.28MB/句，5 句约 6.4MB 上限）。
   * 正常情况下录制会在 RECORD_MAX_MS(6s) 或更早结束，不会触顶。
   */
  var PCM_MAX_SAMPLES = 320000;

  /** 采样间隔（与 pumpPitch 的定时器一致），用于按帧号换算毫秒 */
  var PITCH_INTERVAL_MS = 50;
  /** 去留白后总时长超过此值即 1.2 倍速（PRD §7.5.1.4 决策） */
  var PCM_SPEEDUP_THRESHOLD_MS = 15000;
  var PCM_SPEEDUP_RATE = 1.2;
  // 回放状态
  var replaySource = null;
  var replayStopAt = 0;

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
  var listenTimer = null;
  var recordTimer = null;
  var runToken = 0;
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
  var recordTargetEnd = 0;
  // v1.1.0 逐音档位反馈（契约 C5）
  var recordTarget = null;      // 本句目标音序列
  var recordJudged = 0;         // 已判到第几个音（不含末音）
  var recordJudgements = [];    // 已判结果（末音在 finishRecord 里补）
  // v1.1.0 新手引导关（PRD §7.5.1.2）
  var tutorialDone = false;     // 本局是否已走完引导
  var tutorialAttempts = 0;     // 引导关重试次数（仅用于诊断）
  // v1.1.0 终局回放玩家录音（PRD §7.5.1.4）：每句缓存一段原始 PCM
  var recordPcm = null;         // 本句的 PCM 累积（Float32Array 数组）
  var recordPcmLen = 0;         // 本句已累积的样本数
  var pcmPhrases = [];          // 各句缓存：{ pcm, sampleRate, validFrom, validTo }
  var recordHadVoice = false;
  var lastVoicedAt = 0;
  var lastPitchSent = 0;
  var countdownValue = 0;

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
    var token = runToken;
    var arr = listeners[type];
    if (!arr || !arr.length) return true;
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
      // 回调可以同步 abort/init；之后不得继续本局的事件或定时器。
      if (token !== runToken) return false;
    }
    return true;
  }

  /** 技术状态码（契约 C4）——绝不带中文文案 */
  function notice(code) { return emit('notice', { code: code, level: 'notice' }); }
  function error(code, message) { return emit('error', { code: code, message: message || '' }); }

  function setPhase(next, sub) {
    phase = next;
    subPhase = sub === undefined ? subPhase : sub;
    return emit('state:change', { phase: phase, subPhase: subPhase, phraseIndex: phraseIndex });
  }

  function setSub(next) {
    subPhase = next;
    return emit('state:change', { phase: phase, subPhase: subPhase, phraseIndex: phraseIndex });
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
    var token = runToken;
    var id = global.setTimeout(function () {
      timers = timers.filter(function (t) { return t !== id; });
      if (token === runToken) fn();
    }, ms);
    timers.push(id);
    return id;
  }

  function cancelTimer(id) {
    if (id === null) return;
    global.clearTimeout(id);
    timers = timers.filter(function (t) { return t !== id; });
  }

  function clearTimers() {
    for (var i = 0; i < timers.length; i += 1) global.clearTimeout(timers[i]);
    timers = [];
    listenTimer = null;
    recordTimer = null;
    if (pitchTimer) { global.clearInterval(pitchTimer); pitchTimer = null; }
  }

  // ---------------------------------------------------------------- 麦克风

  function requestMic(token) {
    return new Promise(function (resolve) {
      if (!global.navigator || !global.navigator.mediaDevices ||
          typeof global.navigator.mediaDevices.getUserMedia !== 'function') {
        resolve(false);
        return;
      }
      var request;
      try { request = global.navigator.mediaDevices.getUserMedia({
        audio: {
          // ⚠️ D4.7：这三个 false 是全项目最重要的配置
          echoCancellation: false,   // 会吃掉人声
          noiseSuppression: false,   // 会破坏音高
          autoGainControl: false     // 动态压缩影响判定
        }
      }); } catch (e) { resolve(false); return; }
      Promise.resolve(request).then(function (stream) {
        if (token !== runToken) {
          stopStream(stream);
          resolve(false);
          return;
        }
        mic.stream = stream;
        var c = Audio.ensureAudio();
        mic.source = c.createMediaStreamSource(stream);
        mic.analyser = c.createAnalyser();
        mic.analyser.fftSize = 2048;
        mic.analyser.smoothingTimeConstant = 0;
        mic.source.connect(mic.analyser);
        // ⚠️ 绝不 connect 到 destination，否则啸叫
        mic.buf = new Float32Array(2048);
        resolve(true);
      }).catch(function (err) {
        if (token === runToken) releaseMic();
        resolve(false);
      });
    });
  }

  function stopStream(stream) {
    if (!stream) return;
    var tracks = stream.getTracks();
    for (var i = 0; i < tracks.length; i += 1) tracks[i].stop();
  }

  function releaseMic() {
    stopStream(mic.stream);
    if (mic.source) { try { mic.source.disconnect(); } catch (e) { /* 忽略 */ } }
    mic.stream = null;
    mic.source = null;
    mic.analyser = null;
    mic.buf = null;
    mic.gainBuf = null;
  }

  function cleanRun() {
    runToken += 1;
    clearTimers();
    if (fallbackTapHandler && global.document) {
      global.document.removeEventListener('pointerdown', fallbackTapHandler);
      fallbackTapHandler = null;
    }
    releaseMic();
    Audio.release();
    recordEndReason = 'done';
    mic.inputGain = 1;
    mic.inputPeak = 0;
    mic.noiseFloor = 0.004;
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
    tutorialAttempts = 0;
    pcmPhrases = [];          // v1.1.0：清空上一局的录音缓存
    stopPlayerRecording();
    lastEnding = null;
    lastTitleRevealed = null;
    Store.set(Store.KEYS.SEED, seed);
    fallbackTarget = null;
    // 首次进入先走引导关（PRD §7.5.1.2）；已完成过则直接开正片
    if (Store.get(Store.KEYS.TUTORIAL_DONE, '') !== '1') {
      startTutorial();
      return;
    }
    if (!setPhase('LEARN_LOOP', null)) return;
    runPhrase();
  }

  /** 当前正在唱的乐句：引导关用固定教学句，正片用生成的乐句 */
  function currentPhrase() {
    return phase === 'TUTORIAL' ? tutorialPhrase() : phrases[phraseIndex];
  }

  function phraseNotes() {
    return Melody.toNotes(currentPhrase(), CFG.BPM);
  }

  function runPhrase() {
    replayUsed = false;
    var phrase = currentPhrase();
    var notes = phraseNotes();

    if (!setSub('LISTEN')) return;
    playListen(notes, phrase.eighths.slice(), !!phrase.familiar);
  }

  function playListen(notes, eighths, familiar) {
    cancelTimer(listenTimer);
    Audio.stopPlayback();
    if (!emit('melody:phraseStart', {
      phraseIndex: phraseIndex,
      notes: notes,
      eighths: eighths,
      familiar: familiar,
      seed: seed
    })) return;

    // 海妖唱出本乐句；后端负责播放，前端跟着 notes[] 做视觉同步（契约 C3）
    var sungS = Audio.playPhrase(notes);
    var noteEndMs = notes.reduce(function (end, n) { return Math.max(end, n.startMs + n.durationMs); }, 0);
    var listenMs = Math.max(900, Math.round(Math.max(sungS * 1000, noteEndMs)) + 260);

    listenTimer = later(function () {
      listenTimer = null;
      if (!setSub('COUNTDOWN')) return;
      if (phase === 'RHYTHM_FALLBACK') countdownStep(3);
      else calibrateNoise(function () { countdownStep(3); });
    }, listenMs);
  }

  function countdownStep(n) {
    countdownValue = n;
    if (!emit('attempt:countdown', { from: n })) return;
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
    if (!setSub('RECORD')) return;
    recordFrames = [];
    recordStartAt = monoNow();
    recordDuration = 0;
    recordEndReason = null;
    recordHadVoice = false;
    lastVoicedAt = monoNow();
    lastPitchSent = 0;
    mic.peakRms = 0;

    // 音块提示：把目标音在演唱时同步提示一遍（极短极干，绝不抢注意力）
    var notes = phraseNotes();
    recordTargetEnd = notes.reduce(function (end, n) { return Math.max(end, n.startMs + n.durationMs); }, 0);
    var base = Audio.ensureAudio().currentTime + 0.05;
    for (var i = 0; i < notes.length; i += 1) {
      Audio.cue(notes[i].midi, base + notes[i].startMs / 1000);
    }

    // v1.1.0 逐音档位反馈（契约 C5）：预建目标序列 + 进度游标
    recordTarget = Score._buildTarget(
      currentPhrase(),
      (function (sc) { return function (d) { return Melody.toMidi(d, sc); }; })(currentPhrase().scale),
      CFG.BPM
    );
    recordJudged = 0;
    recordJudgements = [];

    // v1.1.0 原始 PCM 缓存（供终局回放，PRD §7.5.1.4）
    recordPcm = [];
    recordPcmLen = 0;

    if (!emit('attempt:start', { phraseIndex: phraseIndex })) return;

    // D11：音高实时数据每 50ms 推一次
    pitchTimer = global.setInterval(pumpPitch, PITCH_INTERVAL_MS);

    // 上限 6s；静默 3s 中止（D3）
    recordTimer = later(function () { finishRecord('timeout'); }, CFG.RECORD_MAX_MS);
  }

  /**
   * 逐音推进判定（v1.1.0 / 契约 C5）。
   *
   * 每帧检查：录音时间是否已越过某个目标音的**结束时刻**；越过了就判它并广播。
   * 判定用的是**到目前为止**采集到的帧（现场切分），因此玩家一唱完这个音，
   * 探针滑到那里就能立刻弹出档位。
   *
   * 末音（最后一个）不在这里判——它的结束时刻之后可能还有尾音，
   * 统一留到 `finishRecord` 用完整数据补判，避免"尾音还没唱完就判 miss"。
   */
  function pumpNoteJudgements(t) {
    if (!recordTarget || !recordTarget.length) return;
    var lastIdx = recordTarget.length - 1;
    while (recordJudged < lastIdx) {
      var tn = recordTarget[recordJudged];
      var endMs = tn.onsetMs + tn.durationMs;
      if (t < endMs) break;

      // 只切分"到这个音结束为止"的帧，避免把后面的音也算进来
      var upto = [];
      for (var i = 0; i < recordFrames.length; i += 1) {
        if (recordFrames[i].t <= endMs) upto.push(recordFrames[i]);
      }
      var seg = Segment.segment(upto, { noiseFloor: mic.noiseFloor });
      var jd = Score._judgeNotes(recordTarget, seg.notes, { onlyIndex: recordJudged })[0];
      if (jd) {
        jd.t = endMs;   // 契约 C5：判定时刻 = 该音结束时刻（相对 attempt:start）
        recordJudgements.push(jd);
        if (!emit('attempt:note', jd)) return;
      }
      recordJudged += 1;
    }
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
      recordHadVoice = true;
      var nearest = Math.round(r.midi);
      cents = (r.midi - nearest) * 100;
      lastVoicedAt = now;
    }
    if (!emit('attempt:pitch', {
      t: t,
      midi: voiced ? r.midi : 0,
      cents: cents,
      conf: r.conf,
      voiced: voiced
    })) return;

    // v1.1.0：累积原始 PCM（供终局回放玩家录音，PRD §7.5.1.4）
    // ⚠️ 存**原始**样本而不是增益后的：回放要放玩家真实的声音。
    //    内存预算见 §7.5.1.5：每句最多 6s × 48kHz × 4B ≈ 1.1MB，5 句约 5.5MB（已确认接受）。
    if (recordPcm && recordPcmLen + mic.buf.length <= PCM_MAX_SAMPLES) {
      recordPcm.push(new Float32Array(mic.buf));   // 必须复制：mic.buf 会被反复覆写
      recordPcmLen += mic.buf.length;
    }

    // v1.1.0：逐音档位反馈（契约 C5）
    pumpNoteJudgements(t);

    // 短乐句唱完就结算，不能继续等待到「静默 3 秒」把已唱出的内容归零。
    // 完全没有输入仍沿用下面的静默中止；600ms 留出跟唱反应时间。
    if (recordHadVoice && t >= recordTargetEnd + 600) {
      finishRecord('done');
      return;
    }

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
    if (subPhase !== 'RECORD') return;
    if (pitchTimer === null && recordEndReason !== null) return;
    if (pitchTimer) { global.clearInterval(pitchTimer); pitchTimer = null; }
    if (recordEndReason !== null) return;
    recordEndReason = isSilence ? 'silence' : (reason || 'done');
    recordDuration = monoNow() - recordStartAt;
    cancelTimer(recordTimer);
    recordTimer = null;
    Audio.stopPlayback();

    if (!emit('attempt:end', { reason: recordEndReason })) return;
    if (!setSub('ANALYZE')) return;

    var phrase = currentPhrase();
    var score = 0;

    // 用本句实测峰值更新增益（供下一句），并给出"收不进声音"的技术提示
    adaptInputGain();
    if (mic.peakRms > 0 && mic.peakRms < 0.01) {
      // 契约 C4 的 LOW_CONFIDENCE 前端文案为"有点听不清，再靠近一点"，
      // 正是这里要表达的意思。**不擅自新增状态码**——契约 C4 表是封闭的，
      // 若需要专门的"输入太弱"码，应由契约维护者补充。
      if (!notice('LOW_CONFIDENCE')) return;
    }

    if (recordEndReason !== 'silence') {
      var seg = Segment.segment(recordFrames, { noiseFloor: mic.noiseFloor });
      var target = Score._buildTarget(phrase,
        (function (sc) { return function (d) { return Melody.toMidi(d, sc); }; })(phrase.scale),
        CFG.BPM);
      var result = Score._scoreAttempt(target, seg.notes);
      score = result.score;

      // v1.1.0：补判末音（契约 C5）。前面已逐音判到倒数第二个，
      // 末音的结束时刻之后可能还有尾音，所以等录音真正结束再用完整数据判。
      if (recordTarget && recordTarget.length &&
          recordJudged === recordTarget.length - 1) {
        var lastJd = Score._judgeNotes(recordTarget, seg.notes, { onlyIndex: recordJudged })[0];
        if (lastJd) {
          lastJd.t = recordTargetEnd;
          recordJudgements.push(lastJd);
          if (!emit('attempt:note', lastJd)) return;
        }
        recordJudged += 1;
      }

      // 连续低置信度 → LOW_CONFIDENCE（契约 C4），不扣分
      var lowConf = 0;
      for (var i = 0; i < recordFrames.length; i += 1) {
        if (recordFrames[i].hz > 0 && recordFrames[i].conf < 0.5) lowConf += 1;
      }
      if ((seg.notes.length === 0 || lowConf > recordFrames.length * 0.6) && !notice('LOW_CONFIDENCE')) return;
    } else {
      if (!notice('NO_INPUT')) return;   // 契约 C4：建议前端不显示文字，改让海妖沉回水中
    }

    // ---- 新手引导关：不计分、不产生战果、可无限重试（PRD §7.5.1.2）
    if (phase === 'TUTORIAL') {
      recordPcm = null;        // 引导关不参与终局回放
      finishTutorialAttempt(score);
      return;
    }

    // 本句 PCM 收尾（供终局回放玩家录音，PRD §7.5.1.4）
    stashPhrasePcm(recordFrames, recordFrames.length);
    recordPcm = null;

    scoreSum += score;
    later(function () { pullWave(score); }, 120);
  }

  /**
   * 引导关一次尝试的收尾。
   *
   * 通过条件：**唱出至少 1 个音**（门槛极低，目的是教学不是筛选）。
   * 通过后先放一段示范性的船队动画（让玩家看到"声音→船动"的因果），再进正片。
   * 没通过则回到 LISTEN，重新来一次。
   */
  function finishTutorialAttempt(score) {
    var heard = 0;
    for (var i = 0; i < recordJudgements.length; i += 1) {
      if (recordJudgements[i].tier !== 'miss') heard += 1;
    }

    if (heard < 1) {
      // 没唱出来：不提示文字，直接重来（P4：不评价玩家）
      later(function () {
        if (phase !== 'TUTORIAL') return;
        runTutorialPhrase();
      }, 600);
      return;
    }

    // 通过：给一段固定的船队反馈（不消耗正片船队，故单独生成一批）
    if (!setSub('PULL')) return;
    var ships = Fleet.spawnWave(rng, 0);
    var res = Fleet.resolveWave(ships, TUTORIAL_DEMO_SCORE);
    for (var k = 0; k < ships.length; k += 1) {
      (function (ship) {
        later(function () {
          emit('ship:in', {
            id: ship.id, lane: ship.lane, depth: ship.depth,
            side: ship.side, entryDelayMs: ship.entryDelayMs
          });
        }, ship.entryDelayMs);
      })(ships[k]);
    }
    for (var w = 0; w < res.wrecked.length; w += 1) {
      (function (ship, idx) {
        later(function () {
          emit('ship:wrecked', { id: ship.id, pull: ship.pull });
        }, 620 + idx * 45);
      })(res.wrecked[w], w);
    }

    later(function () {
      if (phase !== 'TUTORIAL') return;
      finishTutorial('passed');
    }, 620 + res.wrecked.length * 45 + 900);
  }

  // ---------------------------------------------------------------- 新手引导关（v1.1.0）

  /**
   * 新手引导关（PRD §7.5.1.2 / 契约 C2 的 `TUTORIAL` phase）。
   *
   * 目的：让玩家在没有任何压力的情况下走一遍「听 → 备 → 唱」，
   *       并**看见"自己的声音让船动起来"这个因果**——这是本作唯一的规则，必须亲眼见到。
   *
   * ⚠️ 教学 ≠ 评分：不产生战果、不计入 scoreSum、不参与结局判定。
   *    但**保留船的动画反馈**（评分按固定值传入，保证一定有船动），
   *    否则玩家只学到"对着麦克风发声"，学不到规则。
   */
  function startTutorial() {
    tutorialDone = false;
    if (!setPhase('TUTORIAL', null)) return;
    runTutorialPhrase();
  }

  /** 引导关的单句：3 音级进，固定种子，不参与随机 */
  function tutorialPhrase() {
    return {
      degrees: [0, 1, 0],
      eighths: [2, 2, 4],
      scale: 'pentatonic',
      familiar: false,
      title: null,
      phraseIndex: 0
    };
  }

  function runTutorialPhrase() {
    replayUsed = false;
    tutorialAttempts += 1;
    if (!setSub('LISTEN')) return;
    var p = tutorialPhrase();
    var notes = Melody.toNotes(p, CFG.BPM);
    playListen(notes, p.eighths.slice(), false);
  }

  /** 引导关通过（或跳过）后进入正片 */
  function finishTutorial(reason) {
    tutorialDone = true;
    Store.set(Store.KEYS.TUTORIAL_DONE, '1');
    // 清掉引导关产生的临时战果，确保正片从 0 开始
    shipsAll = [];
    shipsByWave = [];
    shipsSpawned = 0;
    shipsWrecked = 0;
    scoreSum = 0;
    if (!setPhase('LEARN_LOOP', null)) return;
    runPhrase();
  }

  /** 外部（前端按钮）跳过引导关 */
  function skipTutorial() {
    if (phase !== 'TUTORIAL') return false;
    clearTimers();
    Audio.stopPlayback();
    finishTutorial('skipped');
    return true;
  }

  // ---------------------------------------------------------------- 终局回放（v1.1.0）

  /**
   * 求本句"有效演唱段"在 PCM 里的样本区间（PRD §7.5.1.4 要求去掉留白）。
   *
   * 判据：某帧有音高（`hz > 0`）或电平明显高于底噪 → 视为有效。
   * 起 = 第一个有效帧的**帧首**；止 = 最后一个有效帧的**帧尾**。
   * 前后各留 `PAD_MS` 的余量，避免把起音的辅音切掉。
   *
   * 为什么不用"整段 6 秒窗口"拼接：那样 5 句会有大量静音留白，
   * 回放又长又散；裁掉后通常只剩 1–3 秒/句，5 句拼起来接近真实演唱长度。
   */
  function validRangeOf(frames, samplesPerFrame, totalSamples) {
    var PAD_MS = 80;
    var padFrames = Math.max(1, Math.round(PAD_MS / PITCH_INTERVAL_MS));
    var first = -1;
    var last = -1;
    for (var i = 0; i < frames.length; i += 1) {
      var f = frames[i];
      var active = f.hz > 0 || (mic.noiseFloor > 0 && f.rms > mic.noiseFloor * 3);
      if (!active) continue;
      if (first < 0) first = i;
      last = i;
    }
    if (first < 0) return { from: 0, to: 0 };   // 整句没唱

    var fromSample = Math.max(0, (first - padFrames) * samplesPerFrame);
    var toSample = Math.min(totalSamples, (last + 1 + padFrames) * samplesPerFrame);
    if (toSample <= fromSample) return { from: 0, to: 0 };
    return { from: fromSample, to: toSample };
  }

  /** 本句录音的 PCM 收尾：把累积的帧拼成一条，算出有效区间，存入 pcmPhrases */
  function stashPhrasePcm(frames, uptoFrames) {
    if (!recordPcm || recordPcmLen === 0) return;
    var sr = Audio.ensureAudio().sampleRate;

    var merged = new Float32Array(recordPcmLen);
    var off = 0;
    for (var i = 0; i < recordPcm.length; i += 1) {
      merged.set(recordPcm[i], off);
      off += recordPcm[i].length;
    }
    var samplesPerFrame = recordPcm[0].length;
    var range = validRangeOf(frames, samplesPerFrame, merged.length);
    if (range.to <= range.from) return;    // 没唱出东西，不留

    pcmPhrases.push({
      pcm: merged,
      sampleRate: sr,
      from: range.from,
      to: range.to,
      phraseIndex: phraseIndex
    });
  }

  /**
   * 播放玩家录音（终局）。返回实际播放时长（毫秒），失败返回 0。
   *
   * ⚠️ 调用前必须已经 `releaseMic()`——否则麦克风会把回放当成新输入（PRD §7.5.1.4 技术点 1）。
   *    本函数只负责播放，不碰麦克风生命周期。
   */
  function playPlayerRecording() {
    if (!pcmPhrases.length) return 0;
    var ctx = Audio.getAudioContext();
    if (!ctx || ctx.state !== 'running') return 0;

    // 计算有效总样本数
    var total = 0;
    for (var i = 0; i < pcmPhrases.length; i += 1) {
      total += (pcmPhrases[i].to - pcmPhrases[i].from);
    }
    if (total <= 0) return 0;

    var sr = pcmPhrases[0].sampleRate;
    var buf = ctx.createBuffer(1, total, sr);
    var ch = buf.getChannelData(0);
    var cursor = 0;
    var parts = [];
    var srcParts = [];
    for (var j = 0; j < pcmPhrases.length; j += 1) {
      var p = pcmPhrases[j];
      var len = p.to - p.from;
      ch.set(p.pcm.subarray(p.from, p.to), cursor);
      srcParts.push({ phraseIndex: p.phraseIndex, startMs: cursor / sr * 1000, durationMs: len / sr * 1000 });
      parts.push({ phraseIndex: p.phraseIndex, startMs: cursor / sr * 1000, durationMs: len / sr * 1000 });
      cursor += len;
    }

    var src = ctx.createBufferSource();
    src.buffer = buf;
    // 去掉留白后仍超长则 1.2 倍速（PRD §7.5.1.4）
    var naturalMs = total / sr * 1000;
    src.playbackRate.value = naturalMs > PCM_SPEEDUP_THRESHOLD_MS ? PCM_SPEEDUP_RATE : 1;
    var gain = ctx.createGain();
    gain.gain.value = 1;
    src.connect(gain);
    gain.connect(ctx.destination);

    var t0 = ctx.currentTime + 0.06;
    src.start(t0);
    var playedMs = naturalMs / src.playbackRate.value;
    replayStopAt = t0 + playedMs / 1000 + 0.05;
    replaySource = src;

    if (!emit('player:replay', { durationMs: Math.round(playedMs), parts: srcParts })) return 0;
    return playedMs;
  }

  /** 停止玩家录音回放（abort / 重开时调用，避免残留播放） */
  function stopPlayerRecording() {
    if (replaySource) {
      try { replaySource.stop(); } catch (e) { /* 已停止 */ }
      try { replaySource.disconnect(); } catch (e) { /* 忽略 */ }
      replaySource = null;
    }
    replayStopAt = 0;
  }

  // ---------------------------------------------------------------- 船队波次

  /** D9：生成 20 条新船 → 逐船判定 → 广播入场与触礁 */
  function pullWave(score) {
    if (!setSub('PULL')) return;

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
      if (!setSub('PHRASE_RESULT')) return;
      if (!emit('phrase:result', {
        phraseIndex: phraseIndex,
        newWrecked: res.wrecked.length,
        totalWrecked: shipsWrecked
      })) return;

      // D8：歌名仅在 V4 结算且 score ≥ 60 时广播（仅熟曲）
      if (phase === 'LEARN_LOOP' && Melody.shouldRevealTitle(currentPhrase(), score)) {
        lastTitleRevealed = currentPhrase().title;
        if (!emit('melody:titleReveal', { title: lastTitleRevealed })) return;
      }

      later(function () {
        phraseIndex += 1;
        if (phraseIndex >= CFG.PHRASES) startFinale();
        else if (phase === 'RHYTHM_FALLBACK') runFallbackPhrase();
        else runPhrase();
      }, 1500);
    }, settleMs);
  }

  // ---------------------------------------------------------------- 终局

  function startFinale() {
    var fallback = phase === 'RHYTHM_FALLBACK';
    releaseMic();               // ⚠️ 必须在回放前：否则麦克风会把回放当成新输入
    Audio.stopPlayback();
    if (!setPhase('FINALE', null)) return;
    if (!emit('game:finale', {
      wreckedTotal: shipsWrecked,
      ending: Fleet.decideEnding(shipsWrecked),
      seed: seed
    })) return;
    lastEnding = Fleet.decideEnding(shipsWrecked);

    // v1.1.0：终局改为回放**玩家自己的录音**（PRD §7.5.1.4）。
    //   原「海妖全曲加速回放」已取消——`melody:replay` 不再在此发出。
    //   兜底模式没有录音（是打拍子），直接进 RESULT。
    var replayMs = 0;
    if (!fallback && pcmPhrases.length) {
      replayMs = playPlayerRecording();
    }

    // 若因环境原因（AudioContext 未 running 等）没能回放，也照常进结算，
    // 不能因为回放失败把玩家卡在 FINALE。
    var waitMs = replayMs > 0 ? replayMs + 160 : 0;
    later(function () {
      stopPlayerRecording();
      Audio.release();
      if (!setPhase('RESULT', null)) return;
      Store.commitRun(shipsWrecked, scoreSum);
      later(function () { setPhase('SHARE_CARD', null); }, 400);
    }, waitMs);
  }

  // ---------------------------------------------------------------- 兜底模式（D10）

  /**
   * 无麦克风兜底：海妖以固定音高 C4 唱纯节奏，玩家点屏幕打拍子。
   * 船队完全沿用 D9，分数换算一致——兜底模式不残疾（D10）。
   */
  function startFallbackRun() {
    rng = Fleet.mulberry32(seed);
    Fleet.resetIds();
    shipsAll = [];
    shipsByWave = [];
    shipsSpawned = 0;
    shipsWrecked = 0;
    scoreSum = 0;
    phraseIndex = 0;
    phrases = [];
    lastEnding = null;
    lastTitleRevealed = null;
    Store.set(Store.KEYS.SEED, seed);

    // 目标节奏：每句 N 拍，每拍一个八分格（C4 = MIDI 60）
    fallbackTarget = [];
    for (var i = 0; i < CFG.PHRASES; i += 1) {
      var cursor = 0;
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

    if (setPhase('RHYTHM_FALLBACK', null)) runFallbackPhrase();
  }

  function runFallbackPhrase() {
    replayUsed = false;
    var target = fallbackTarget[phraseIndex];
    if (!setSub('LISTEN')) return;
    playListen(target.notes, target.notes.map(function () { return 2; }), false);
  }

  function beginFallbackRecord() {
    if (!setSub('RECORD')) return;
    fallbackTaps = [];
    var target = fallbackTarget[phraseIndex];
    var startAt = monoNow();
    recordEndReason = null;

    // 海妖唱纯节奏（固定 C4），玩家跟着点
    var audioContext = Audio.getAudioContext();
    var base = (audioContext ? audioContext.currentTime : 0) + 0.5;
    for (var i = 0; i < target.notes.length; i += 1) {
      Audio.tick(base + target.notes[i].startMs / 1000, i === 0);
    }

    fallbackTapHandler = function () {
      fallbackTaps.push({ t: monoNow() - startAt - 500 });
    };
    if (global.document) global.document.addEventListener('pointerdown', fallbackTapHandler, { passive: true });
    // 兜底固定提前 500ms 给玩家准备；前端使用同样的提前量同步音块。
    if (!emit('attempt:start', { phraseIndex: phraseIndex })) return;

    recordTimer = later(function () { finishFallbackRecord(); }, Math.max(1500, target.cursorEnd + 1200));
  }

  function finishFallbackRecord() {
    if (phase !== 'RHYTHM_FALLBACK' || subPhase !== 'RECORD' || recordEndReason !== null) return;
    recordEndReason = 'done';
    cancelTimer(recordTimer);
    recordTimer = null;
    if (fallbackTapHandler) {
      global.document.removeEventListener('pointerdown', fallbackTapHandler);
      fallbackTapHandler = null;
    }
    Audio.stopPlayback();
    if (!emit('attempt:end', { reason: 'done' })) return;
    if (!setSub('ANALYZE')) return;

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
    cleanRun();
    options = options || {};
    if (options.storagePrefix && Store.KEYS) {
      // 前缀由 store.js 在加载时固定；这里只接受默认前缀，避免破坏既定键名
      if (options.storagePrefix !== 'siren.' && !notice('STORAGE_FAILED')) return Promise.resolve(getState());
    }
    if (options.seed !== undefined && options.seed !== null) {
      seed = Number(options.seed) || 0;
    } else {
      var saved = Store.getNumber(Store.KEYS.SEED, 0);
      seed = saved || (Math.floor(Math.random() * 900000) + 1000);
    }
    Store.set(Store.KEYS.SEED, seed);
    if (!Store.available && !notice('STORAGE_FAILED')) return Promise.resolve(getState());

    phraseIndex = 0;
    shipsSpawned = 0;
    shipsWrecked = 0;
    setPhase('HOME', null);
    return Promise.resolve(getState());
  }

  function start() {
    if (phase !== 'HOME' && phase !== 'SHARE_CARD' && phase !== 'RESULT') return;
    cleanRun();
    var token = runToken;
    if (!setPhase('PERM_REQUEST', null)) return;

    // start() 必须由用户手势调用：在这里解锁 AudioContext（D4.1）
    try {
      Audio.ensureAudio();
    } catch (e) {
      if (!error('MIC_DENIED', 'AudioContext unavailable')) return;
      later(function () { startFallbackRun(); }, 0);
      return;
    }

    requestMic(token).then(function (ok) {
      if (token !== runToken) return;
      if (ok) {
        startRun();
      } else {
        // 契约 C4：MIC_DENIED 是 error 级（前端文案"如果您拒绝了麦克风权限…"）。
        // ⚠️ 这里曾误发成 notice('MIC_DENIED')，导致前端按契约监听 error 事件时
        //    永远收不到权限失败通知。已修正为 error，并保持 level 与契约一致。
        if (!error('MIC_DENIED', 'getUserMedia rejected')) return;
        // 契约 C4 另有 MIC_RETRY（notice，"再点一下让她开口"）：
        // 权限被系统重置或切后台回来时用它提示重试。此前该码从未被广播过。
        if (!notice('MIC_RETRY')) return;
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
    playListen(notes, currentPhrase().eighths.slice(), !!currentPhrase().familiar);
    return true;
  }

  function abort() {
    cleanRun();
    // v1.1.0：中止时也要停掉可能正在播放的录音回放，并释放 PCM 缓存
    stopPlayerRecording();
    pcmPhrases = [];
    recordPcm = null;
    phraseIndex = 0;
    setPhase('HOME', null);
  }

  Siren.Game = {
    init: init,
    start: start,
    replayPhrase: replayPhrase,
    skipTutorial: skipTutorial,
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
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : {}));
