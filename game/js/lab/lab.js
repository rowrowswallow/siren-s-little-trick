/* D14 试唱台逻辑（开发工具，不进上传包）
 *
 * 步骤 2：试听海妖的合成音色（siren / cue / tick），判断能否听出旋律
 * 步骤 3：对着乐句真唱或哼唱 → 走完整的切分 + 打分链路 → 看分数是否符合直觉
 *
 * 这里用的是与正式游戏**完全相同的模块**（pitch/segment/score/audio/melody），
 * 不是另一套实现——否则验证就没有意义。
 *
 * 硬约束与正式代码一致：无内联脚本、无行内事件、无外部资源、无 eval。
 */

(function () {
  'use strict';

  var Siren = window.Siren;
  if (!Siren || !Siren.Pitch || !Siren.Segment || !Siren.Score || !Siren.Audio) {
    document.getElementById('verdict').innerHTML =
      '<span class="err">后端模块未加载，请检查脚本顺序（D2）</span>';
    return;
  }

  var Pitch = Siren.Pitch;
  var Segment = Siren.Segment;
  var Score = Siren.Score;
  var Audio = Siren.Audio;
  var Melody = Siren.Melody;
  var Fleet = Siren.Fleet;
  var MELODIES = Siren.MELODIES || [];

  var BPM = 92;
  var LAB_VERSION = 'lab-v8';   // 每次改动递增，用于确认浏览器没有跑缓存的旧版本
  var el = function (id) { return document.getElementById(id); };

  // ---------------------------------------------------------------- 乐句库
  // 用与正式游戏相同的音数曲线 3/4/5/6/7，第 5 句是 Boss（必用原创）

  var phrases = [];
  (function buildPhraseList() {
    var generated = Melody.buildPhrases(2024, [3, 4, 5, 6, 7]).phrases;
    for (var i = 0; i < generated.length; i += 1) {
      var p = generated[i];
      phrases.push({
        label: '句' + (i + 1) + ' · ' + p.degrees.length + ' 音 · ' +
          (p.familiar ? ('熟曲：' + p.title) : '原创') + (i === 4 ? ' · Boss' : ''),
        phrase: p
      });
    }
    // 额外放一句最耳熟的，便于做"我应该唱得不错"的对照
    var twinkle = MELODIES[0] && MELODIES[0].phrases[0];
    if (twinkle) {
      phrases.unshift({
        label: '对照 · 《小星星》第 1 句（7 音，最熟）',
        phrase: {
          degrees: twinkle.degrees.slice(),
          eighths: twinkle.eighths.slice(),
          scale: 'major',
          familiar: true,
          title: MELODIES[0].title
        }
      });
    }
  })();

  var current = 0;

  // ---------------------------------------------------------------- 错误可见化
  // 静默异常是"听不到声音"最常见的原因：某个 API 抛错 → 整段播放逻辑中断，
  // 但页面上什么都不显示。这里把错误直接摆到界面上。

  var pageErrors = [];
  function recordError(where, e) {
    var msg = where + ': ' + (e && e.message ? e.message : String(e));
    pageErrors.push(msg);
    var box = el('errBox');
    if (box) box.innerHTML = '<span class="err">' + pageErrors.length + ' 条（见下）</span>';
    var out = el('diagOut');
    if (out) out.textContent = (out.textContent === '点上面的按钮开始。' ? '' : out.textContent + '\n') + '⚠ ' + msg;
  }
  window.addEventListener('error', function (ev) { recordError('未捕获', ev.error || ev.message); });
  window.addEventListener('unhandledrejection', function (ev) { recordError('Promise 未处理', ev.reason); });

  // ---------------------------------------------------------------- 音频上下文

  /**
   * 统一走 Siren.Audio.ready()。
   *
   * ⚠️ 不要在这里自己 new AudioContext：
   *    playPhrase / cue / tick 读的是 Siren.Audio **模块内部**的 ctx，
   *    外部另建一个上下文会让它们静默失败（ctx 为 null 时直接 return 0，无任何报错）。
   *    这个坑导致过"点试听没声音"。
   */
  function ensureRunningCtx() {
    return Audio.ready();
  }

  // ---------------------------------------------------------------- 诊断

  function audioDiagnostics() {
    var card = el('diagCard');
    card.hidden = false;
    var lines = [];
    var push = function (s) { lines.push(s); el('diagOut').textContent = lines.join('\n'); };

    lines.length = 0;
    push('=== 音频诊断 ===');
    push('时间：' + new Date().toLocaleTimeString());
    push('');

    var Ctor = window.AudioContext || window.webkitAudioContext;
    push('1) 浏览器 AudioContext 构造器：' + (Ctor ? '存在 ✓' : '缺失 ✗'));

    var st = Audio.stats ? Audio.stats() : null;
    var c = Audio.getAudioContext ? Audio.getAudioContext() : null;
    push('2) Siren.Audio 内部 ctx：' + (c ? '已创建 ✓' : '**为 null ✗** —— playPhrase 会静默 return 0'));
    push('3) Siren.Audio.stats()：' + (st ? JSON.stringify(st) : '不可用 ✗'));
    if (c) {
      push('4) ctx.state = ' + c.state + (c.state === 'running' ? ' ✓' : ' ✗ 非 running，声音不会出来'));
      push('5) ctx.sampleRate = ' + c.sampleRate);
      push('6) ctx.currentTime = ' + c.currentTime.toFixed(3) + 's' +
        (c.currentTime > 0 ? ' ✓ 在走动' : ' ⚠ 停着不动，上下文被挂起'));
      push('7) ctx.destination = ' + (c.destination ? '存在 ✓' : '缺失 ✗'));
    }
    push('');

    push('8) 后端模块加载：');
    push('   Pitch   ' + (window.Siren.Pitch ? '✓' : '✗') +
      '   Segment ' + (window.Siren.Segment ? '✓' : '✗') +
      '   Score   ' + (window.Siren.Score ? '✓' : '✗'));
    push('   Audio   ' + (window.Siren.Audio ? '✓' : '✗') +
      '   Melody  ' + (window.Siren.Melody ? '✓' : '✗') +
      '   Fleet   ' + (window.Siren.Fleet ? '✓' : '✗'));
    push('');

    var notes = Melody.toNotes(phrases[current].phrase, BPM);
    push('9) 当前乐句：' + notes.length + ' 个音，总时长 ' +
      Math.round(notes[notes.length - 1].startMs + notes[notes.length - 1].durationMs) + 'ms');
    push('   首音：' + JSON.stringify(notes[0]));
    push('');

    push('10) 页面报错：' + (pageErrors.length ? pageErrors.length + ' 条' : '无 ✓'));
    for (var i = 0; i < pageErrors.length; i += 1) push('    ⚠ ' + pageErrors[i]);
    push('');

    push('11) 自动测试：');
    push('    (a) 初始化 Siren.Audio（等价于点「试听」的第一步）…');
    Audio.ready().then(function (readyCtx) {
      push('        ✓ Audio.ready() 成功，ctx.state = ' + readyCtx.state);
      push('    (b) 播一个 1 秒 440Hz 正弦（绕过音色链，直接接 destination）…');
      return playRawBeepDirect(readyCtx);
    }).then(function () {
      push('        ✓ 已排程 440Hz 正弦。');
      push('    (c) 用后端 siren 音色播一个音…');
      Audio.playTone({
        type: 'siren',
        freq: 440,
        startTime: Audio.getAudioContext().currentTime + 0.1,
        durationS: 1.0
      });
      push('        ✓ 已排程 siren 音色。');
      push('');
      push('结论：如果 (b) 有声而 (c) 没声 → 问题在音色链；');
      push('      如果 (b)(c) 都没声 → 问题在浏览器/系统音量，不在代码；');
      push('      如果 (a) 就失败 → 看上面的报错。');
    }).catch(function (e) {
      push('        ✗ 失败：' + (e && e.message ? e.message : e));
      push('');
      push('结论：连初始化都失败，先看第 10 项报错。');
    });
  }

  /** 最原始的振荡器 → destination，绕过所有音色链 */
  function playRawBeepDirect(c) {
    return new Promise(function (resolve) {
      var osc = c.createOscillator();
      var g = c.createGain();
      osc.type = 'sine';
      osc.frequency.value = 440;
      var t0 = c.currentTime + 0.1;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.25, t0 + 0.02);
      g.gain.setValueAtTime(0.25, t0 + 0.7);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.0);
      osc.connect(g);
      g.connect(c.destination);
      osc.start(t0);
      osc.stop(t0 + 1.05);
      resolve();
    });
  }

  // ---------------------------------------------------------------- 状态

  var stream = null;
  var sourceNode = null;
  var analyser = null;
  var buf = null;
  var gainBuf = null;         // 施加增益后的副本（检测用）
  var tickTimer = null;
  var recording = false;
  var recordStartAt = 0;
  var frames = [];
  var noiseFloor = 0.004;
  var inputGain = 1;          // 输入增益（校准阶段自动算出）
  var inputPeak = 0;          // 校准期测到的原始峰值
  var lastResult = null;

  // ---------------------------------------------------------------- 工具

  function fillSelect() {
    var sel = el('phraseSelect');
    sel.innerHTML = '';
    for (var i = 0; i < phrases.length; i += 1) {
      var opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = phrases[i].label;
      sel.appendChild(opt);
    }
    sel.value = '0';
    current = 0;
  }

  function currentNotes() {
    return Melody.toNotes(phrases[current].phrase, BPM);
  }

  function setPhase(text, cls) {
    var e = el('phase');
    e.textContent = text;
    e.className = 'v' + (cls ? ' ' + cls : '');
  }

  function midiName(m) { return Pitch.midiToName(m); }

  // ---------------------------------------------------------------- 麦克风

  function ensureMic() {
    if (analyser) return Promise.resolve(true);
    el('micState').textContent = '请求中…';

    return ensureRunningCtx().then(function (c) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('本环境没有 getUserMedia（需要 https 或 localhost）');
      }
      return navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      }).then(function (s) {
        stream = s;
        sourceNode = c.createMediaStreamSource(s);
        analyser = c.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0;
        sourceNode.connect(analyser);
        buf = new Float32Array(2048);
        el('micState').innerHTML = '<span class="ok">已授权</span>';
        el('micBtn').disabled = true;
        return true;
      });
    }).catch(function (err) {
      el('micState').innerHTML = '<span class="err">失败：' +
        (err && err.name ? err.name + ' · ' : '') + (err && err.message ? err.message : '') + '</span>';
      recordError('麦克风', err);
      return false;
    });
  }

  function rmsOf(b) {
    var s = 0;
    for (var i = 0; i < b.length; i += 1) s += b[i] * b[i];
    return Math.sqrt(s / b.length);
  }

  /** 采 12 帧环境噪音（与 game.js 的校准一致） */
  function calibrate(done) {
    var samples = [];
    var left = 12;
    var step = function () {
      if (!analyser) { done(); return; }
      analyser.getFloatTimeDomainData(buf);
      samples.push(rmsOf(buf));
      left -= 1;
      if (left > 0) { window.setTimeout(step, 40); return; }
      samples.sort(function (a, b) { return a - b; });
      noiseFloor = samples[Math.floor(samples.length * 0.75)];
      done();
    };
    step();
  }

  /**
   * 输入增益校准：请用户唱一声，测峰值，算出安全增益。
   *
   * 这一步是必须的，不是优化——实测用户的麦克风峰值只有 0.032 RMS
   * （正常应 −12 ~ −6 dBFS，差 15–20 dB），而这类差距来自设备/系统层，
   * 用户自己无法解决（也不该由他解决）。
   * YIN 在 0.003 RMS 以上就有 100% 检出率，所以抬进 0.02–0.05 就完全够用。
   */
  function calibrateInputGain(next) {
    var peak = 0;
    var left = 30;               // 30 × 50ms = 1.5 秒
    setPhase('校准输入电平：请用平时的音量唱「啊——」');
    el('liveHz').innerHTML = '<span class="warn">请出声，正在测你的麦克风电平…</span>';

    var step = function () {
      if (!analyser) { next(); return; }
      analyser.getFloatTimeDomainData(buf);
      var r = rmsOf(buf);
      if (r > peak) peak = r;
      left -= 1;
      if (left > 0) {
        el('liveHz').innerHTML = '<span class="warn">测电平中 ' +
          Math.ceil(left * 50 / 1000) + 's ｜ 当前峰值 ' + peak.toFixed(5) + '</span>';
        window.setTimeout(step, 50);
        return;
      }
      inputGain = Audio.computeInputGain(peak, noiseFloor);
      inputPeak = peak;
      el('liveHz').innerHTML = '增益 <b>' + inputGain.toFixed(2) + 'x</b>' +
        '（原始峰值 ' + peak.toFixed(5) + '）' +
        (inputGain > 1.05
          ? ' <span class="warn">—— 你的麦克风电平偏低，已自动补偿</span>'
          : ' <span class="ok">—— 电平正常</span>');
      window.setTimeout(next, 600);
    };
    step();
  }

  /**
   * 抓一帧原始样本存起来，供离线复现。
   * 报告里带不出来 2048 个浮点数，但可以降采样到 256 点 + 记录真实采样率，
   * 足以在 Node 里重跑 YIN 并比对不同阈值/窗口设置。
   */
  var rawFrame = null;
  function captureRawFrame() {
    if (!analyser) return;
    var full = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(full);
    // 只保留后 2048 点（与检测窗口一致），再降采样到 256 点
    var win = full.subarray(full.length - 2048);
    var out = new Array(256);
    for (var i = 0; i < 256; i += 1) {
      out[i] = Number(win[Math.floor(i * 2048 / 256)].toFixed(6));
    }
    rawFrame = { samples256: out, fullLength: 2048, sampleRate: Audio.getAudioContext().sampleRate };
  }

  /**
   * 麦克风电平体检（10 秒）。
   *
   * 存在的理由：用户实测"声音很大、贴着麦克风"，但进来只有 0.04 RMS（−28 dBFS），
   * 正常值应为 −12 ~ −6 dBFS，差 15–20 dB。这个差距不可能是"唱得轻"，
   * 只能来自设备/系统层（其他程序占用麦克风、系统输入级别、麦克风加强等）。
   * 与其继续猜，不如把原始电平、轨道设置、增益需求直接摆出来。
   */
  function micCheckup() {
    var card = el('diagCard');
    card.hidden = false;
    var lines = [];
    var push = function (s) { lines.push(s); el('diagOut').textContent = lines.join('\n'); };
    lines.length = 0;

    push('=== 麦克风电平体检 ===');
    push('请对着麦克风用正常音量持续唱"啊——"，10 秒内会实时采样。');
    push('');

    ensureMic().then(function (ok) {
      if (!ok) { push('✗ 麦克风未就绪'); return; }

      // 报告轨道真实设置（这是判断"是不是被别的程序影响了"的关键）
      var tracks = stream.getAudioTracks();
      var tk = tracks[0];
      push('轨道数：' + tracks.length + '（若 > 1 说明有多个输入源）');
      if (tk) {
        push('设备标签：' + (tk.label || '(未授权时为空)'));
        var st = tk.getSettings ? tk.getSettings() : {};
        push('实际设置：' + JSON.stringify(st));
        var caps = tk.getCapabilities ? tk.getCapabilities() : null;
        if (caps && caps.sampleRate) push('设备支持采样率：' + JSON.stringify(caps.sampleRate));
        if (caps && caps.echoCancellation) push('设备支持 AEC：' + JSON.stringify(caps.echoCancellation));
        push('轨道静音：' + tk.muted + '　启用：' + tk.enabled);
      }
      push('');
      push('现在开始采样（请持续发声）…');

      var peak = 0;
      var sum = 0;
      var n = 0;
      var voiced = 0;
      var peakHz = 0;
      var t0 = performance.now();

      var tick = window.setInterval(function () {
        if (!analyser) { window.clearInterval(tick); return; }
        analyser.getFloatTimeDomainData(buf);
        var rms = rmsOf(buf);
        var r = Pitch.detectPitch(buf, Audio.getAudioContext().sampleRate, 2048);
        peak = Math.max(peak, rms);
        sum += rms;
        n += 1;
        if (r.hz > 0) { voiced += 1; peakHz = Math.max(peakHz, r.hz); }

        var left = Math.max(0, 10 - (performance.now() - t0) / 1000);
        el('liveHz').innerHTML = '体检中 ' + left.toFixed(1) + 's · 峰值 ' + peak.toFixed(5) +
          (r.hz > 0 ? ' · ' + r.hz.toFixed(0) + 'Hz' : ' · 无音高');

        if (performance.now() - t0 >= 10000) {
          window.clearInterval(tick);
          finishCheckup(push, { peak: peak, avg: n ? sum / n : 0, frames: n, voiced: voiced, peakHz: peakHz });
        }
      }, 50);
    }).catch(function (e) {
      push('✗ 失败：' + (e && e.message ? e.message : e));
    });
  }

  function finishCheckup(push, m) {
    var dbfs = m.peak > 0 ? (20 * Math.log10(m.peak)).toFixed(1) : '-inf';
    push('');
    push('=== 结果 ===');
    push('峰值电平：' + m.peak.toFixed(5) + ' RMS  =  ' + dbfs + ' dBFS');
    push('平均电平：' + m.avg.toFixed(5) + ' RMS');
    push('检出帧：' + m.voiced + '/' + m.frames +
      '（' + Math.round(m.voiced / Math.max(1, m.frames) * 100) + '%）');
    push('最高检出音高：' + (m.peakHz > 0 ? m.peakHz.toFixed(0) + ' Hz' : '(无)'));
    push('');

    push('=== 判读 ===');
    if (m.peak >= 0.25) {
      push('✓ 电平很好（>= -12 dBFS），设备正常。');
    } else if (m.peak >= 0.1) {
      push('△ 电平偏低（' + dbfs + ' dBFS）。勉强可用，但嘈杂环境下容易漏检。');
      push('  → 建议在 Windows 声音设置里把麦克风"输入级别"调到 100，"麦克风加强"调高。');
    } else if (m.peak >= 0.02) {
      push('✗ 电平明显偏低（' + dbfs + ' dBFS，正常应为 -12 ~ -6）。');
      push('  → 不是唱得轻的问题。请依次检查：');
      push('    1. 是否有其他程序正在占用麦克风（腾讯会议/微信/QQ/浏览器其他标签页）');
      push('       —— Windows 允许独占，抢占后浏览器会拿到被降级的流，这是最常见原因；');
      push('    2. Windows 设置 → 系统 → 声音 → 输入 → 设备属性：输入级别是否被调低、麦克风加强是否关闭；');
      push('    3. 麦孔是否有遮挡/灰尘，或笔记本内置麦本身增益偏低（可试外接耳机麦对比）。');
    } else {
      push('✗ 电平极低（' + dbfs + ' dBFS），几乎等于没收到声音。');
      push('  → 极可能被其他程序独占或被系统静音。请先关掉腾讯会议/微信等占用麦克风的程序再测。');
    }
    push('');
    push('对照：本机 M0 探针实测峰值 0.183（−14.8 dBFS），那一次是正常量级。');
  }

  // ---------------------------------------------------------------- 步骤 2：音色试听

  function playTimbreDemo() {
    el('playTimbre').disabled = true;
    el('timbreState').textContent = '准备音频上下文…';

    // ⚠️ 必须先等到 ctx 真的 running 再排程。
    //    之前是在 resume() 的 Promise 还没落实时就调 playPhrase，
    //    此时 ctx.currentTime 几乎不动，排出的时间点全挤在一起 → 听不到声音。
    ensureRunningCtx().then(function (c) {
      var notes = Melody.toNotes({
        degrees: MELODIES[0].phrases[0].degrees.slice(),
        eighths: MELODIES[0].phrases[0].eighths.slice(),
        scale: 'major'
      }, BPM);

      // 给排程留一点提前量，避免首音被吃掉
      var t = c.currentTime + 0.05;

      // ① siren 唱《小星星》第 1 句
      el('timbreState').textContent = '正在听 siren（海妖唱《小星星》）…';
      var dur = Audio.playPhrase(notes, { when: t });
      t += dur + 0.6;

      // ② cue：三个短提示音
      window.setTimeout(function () {
        el('timbreState').textContent = '正在听 cue（提示音）…';
        var base2 = Audio.getAudioContext().currentTime + 0.05;
        Audio.cue(60, base2);
        Audio.cue(64, base2 + 0.45);
        Audio.cue(67, base2 + 0.9);
      }, Math.max(0, (t - c.currentTime) * 1000));
      t += 1.5;

      // ③ tick：四拍节拍
      window.setTimeout(function () {
        el('timbreState').textContent = '正在听 tick（节拍）…';
        var base3 = Audio.getAudioContext().currentTime + 0.05;
        for (var i = 0; i < 4; i += 1) Audio.tick(base3 + i * Audio.quarterMs() / 1000, i === 0);
      }, Math.max(0, (t - c.currentTime) * 1000));
      t += 4 * Audio.quarterMs() / 1000 + 0.3;

      window.setTimeout(function () {
        el('timbreState').innerHTML = '<span class="ok">播放完毕</span>——听出是哪首歌了吗？';
        el('playTimbre').disabled = false;
      }, Math.max(0, (t - c.currentTime) * 1000));
    }).catch(function (e) {
      el('timbreState').innerHTML = '<span class="err">' + (e && e.message ? e.message : e) + '</span>';
      recordError('试听', e);
      el('playTimbre').disabled = false;
      el('diagCard').hidden = false;
    });
  }

  // ---------------------------------------------------------------- 步骤 3：试唱

  function listenPhrase() {
    el('listenBtn').disabled = true;
    setPhase('准备音频…');
    ensureRunningCtx().then(function (c) {
      setPhase('海妖在唱…');
      var notes = currentNotes();
      var dur = Audio.playPhrase(notes, { when: c.currentTime + 0.05 });
      window.setTimeout(function () {
        setPhase('空闲（可以开录了）');
        el('listenBtn').disabled = false;
      }, dur * 1000 + 300);
    }).catch(function (e) {
      setPhase('音频启动失败');
      recordError('听乐句', e);
      el('diagCard').hidden = false;
      el('listenBtn').disabled = false;
    });
  }

  function startRecord() {
    ensureMic().then(function (ok) {
      if (!ok) return;
      el('recordBtn').disabled = true;
      setPhase('校准环境噪音…（现在请安静）');
      calibrate(function () {
        // ⚠️ 必须有明确的"该唱了"信号。
        //    之前点完开录直接进录音，用户还在看屏幕，3 秒静默中止就把他切断了
        //    ——实测这会让"一直在唱"的人拿到 0 分。
        el('recordBtn').disabled = true;
        calibrateInputGain(function () {
          runCountdown(3, function () { beginCapture(); });
        });
      });
    });
  }

  /** 3-2-1 倒数，给出明确的开口时机（与 game.js 的 COUNTDOWN 阶段一致） */
  function runCountdown(from, done) {
    var n = from;
    var step = function () {
      setPhase('准备… ' + n);
      el('liveHz').textContent = String(n);
      if (n > 1) {
        n -= 1;
        window.setTimeout(step, 700);
      } else {
        window.setTimeout(function () {
          el('liveHz').textContent = '--';
          done();
        }, 700);
      }
    };
    step();
  }

  /** 真正开始采集 */
  function beginCapture() {
    var notes = currentNotes();
    frames = [];
    rawFrame = null;          // 每次录音重置，避免报告里带上一次的样本
    recording = true;
    el('stopBtn').disabled = false;
    el('score').className = 'score dim';
    el('score').textContent = '--';
    el('verdict').textContent = '正在录…唱吧。';
    el('captureStats').textContent = '--';

    // 提示音（与 game.js 一致：极短极干，不抢注意力）
    var cueCtx = Audio.getAudioContext();
    var base = cueCtx.currentTime + 0.05;
    for (var i = 0; i < notes.length; i += 1) {
      Audio.cue(notes[i].midi, base + notes[i].startMs / 1000);
    }

    recordStartAt = performance.now();
    setPhase('● 录音中 —— 唱！');

    var maxMs = 6000;
    var silenceAbort = 3000;
    var lastVoiced = performance.now();

    tickTimer = window.setInterval(function () {
      if (!recording) return;
      var t = performance.now() - recordStartAt;

      analyser.getFloatTimeDomainData(buf);
      // ⚠️ 电平统计必须用**原始**缓冲：它反映麦克风的真实水平，
      //    若用增益后的值，就再也看不出"你的设备电平偏低"这件事了。
      var rawRms = rmsOf(buf);

      // 检测用增益后的缓冲（音高检测只看周期结构，线性缩放不影响结果）
      var detectBuf = buf;
      if (inputGain > 1.05) {
        if (!gainBuf || gainBuf.length !== buf.length) gainBuf = new Float32Array(buf.length);
        gainBuf.set(buf);
        Audio.applyInputGain(gainBuf, inputGain);
        detectBuf = gainBuf;
      }

      var r = Pitch.detectPitch(detectBuf, cueCtx.sampleRate, 2048);
      var voiced = r.hz > 0;
      if (voiced) {
        lastVoiced = performance.now();
        // 抓一帧"检出成功"的原始样本，供离线复现（只抓一次）
        if (!rawFrame) captureRawFrame();
      }

      // 实时电平反馈：让用户当场知道"系统听不清"
      //   离线验证已证明 YIN 在 0.003 RMS 下仍有 100% 检出率；
      //   用户实测"一直在唱却只录到 1 秒"，根因是输入电平太低而系统没有任何提示。
      var levelTag;
      if (rawRms < 0.005) {
        levelTag = '<span class="err">▁ 太轻了，大声一点 / 靠近麦克风</span>';
      } else if (rawRms < 0.02) {
        levelTag = '<span class="warn">▃ 偏轻' + (inputGain > 1.05 ? '（已自动放大）' : '') + '</span>';
      } else if (rawRms < 0.05) {
        levelTag = '<span class="ok">▅ 可以</span>';
      } else {
        levelTag = '<span class="ok">█ 很好</span>';
      }

      // 实时显示：剩余时间 + 实时音高 + 电平
      var silenceLeft = Math.max(0, silenceAbort - (performance.now() - lastVoiced));
      el('liveHz').innerHTML = levelTag + ' <span style="color:#4a7383">|</span> ' +
        (voiced
          ? r.hz.toFixed(1) + ' Hz ' + midiName(r.midi)
          : '（没听到音高，静默 ' + Math.ceil(silenceLeft / 1000) + 's 后结束）');

      frames.push({ t: t, hz: r.hz, conf: r.conf, rms: rawRms });

      if (t >= maxMs) { finish(buildResult('timeout')); return; }
      // 静默中止：给 1.5 秒宽限，避免"刚开口就被判静默"
      if (performance.now() - lastVoiced >= silenceAbort && t > 1500) {
        finish(buildResult('silence'));
      }
    }, 50);
  }

  function stopRecord() {
    if (!recording) return;
    finish(buildResult('manual'));
  }

  function buildResult(reason) {
    var phrase = phrases[current].phrase;
    var seg = Segment.segment(frames, { noiseFloor: noiseFloor });
    var toMidi = function (d) { return Melody.toMidi(d, phrase.scale); };
    var target = Score._buildTarget(phrase, toMidi, BPM);
    var verbose = Score._scoreAttemptVerbose(target, seg.notes);

    // 采集统计：0 分时用来判断"是没录到"还是"录到了但没检出"
    var voicedFrames = 0;
    var rmsSum = 0;
    var rmsMax = 0;
    for (var i = 0; i < frames.length; i += 1) {
      if (frames[i].hz > 0) voicedFrames += 1;
      rmsSum += frames[i].rms;
      if (frames[i].rms > rmsMax) rmsMax = frames[i].rms;
    }

    return {
      reason: reason,
      phrase: phrase,
      target: target,
      heard: seg.notes,
      segStats: seg.stats,
      verbose: verbose,
      score: verbose.score,
      durationMs: performance.now() - recordStartAt,
      frames: frames.slice(),          // 逐帧轨迹，供报告使用
      capture: {
        frames: frames.length,
        voicedFrames: voicedFrames,
        rmsAvg: frames.length ? rmsSum / frames.length : 0,
        rmsMax: rmsMax,
        noiseFloor: noiseFloor,
        silenceThreshold: noiseFloor * 1.8,
        inputGain: inputGain,
        inputPeak: inputPeak,
        sampleRate: Audio.getAudioContext() ? Audio.getAudioContext().sampleRate : 0
      }
    };
  }

  /**
   * 逐帧轨迹（每帧 50ms）。这是定位"为什么没检出音高"的关键数据：
   *   · 音名  = 该帧检出的音高，`.` = 无音高
   *   · 电平  = 该帧 RMS，分级显示（越响字越大写）
   * 有了它就能一眼看出：是整段都太轻，还是只有碎片段能被检出。
   */
  function frameTrace(frames) {
    var treble = '';
    var level = '';
    for (var i = 0; i < frames.length; i += 1) {
      var f = frames[i];
      treble += f.hz > 0 ? midiName(Pitch.hzToMidi(f.hz)).replace(/[0-9]/g, '') : '.';
      var r = f.rms;
      level += r < 0.005 ? '_' : r < 0.02 ? '-' : r < 0.05 ? '=' : r < 0.1 ? '+' : '#';
    }
    return { treble: treble, level: level, intervalMs: 50 };
  }

  function finish(result) {
    recording = false;
    if (tickTimer) { window.clearInterval(tickTimer); tickTimer = null; }
    el('recordBtn').disabled = false;
    el('stopBtn').disabled = true;
    el('liveHz').textContent = '--';

    lastResult = result;
    render(result);
    setPhase(result.reason === 'silence' ? '录到静默，提前结束' : '完成');
  }

  // ---------------------------------------------------------------- 结果渲染

  function render(res) {
    var sc = el('score');
    sc.textContent = String(res.score);
    sc.className = 'score' + (res.score >= 60 ? '' : ' dim');

    var diag = res.verbose.dims;
    el('transpose').textContent = 'offset ' + res.verbose.transposition.offset +
      ' 半音（八度 ' + res.verbose.transposition.octaveShift + ' + 细调 ' + res.verbose.transposition.fineOffset + '）';
    el('noteStats').textContent = '目标 ' + res.target.length + ' 个 → 听出 ' + res.heard.length +
      ' 个（原始段 ' + res.segStats.rawNotes + '，合并后 ' + res.segStats.mergedNotes +
      '，丢碎片 ' + res.segStats.droppedFragments + '）';
    el('targetNames').textContent = res.target.map(function (n) { return midiName(n.midi); }).join(' ');
    el('heardNames').textContent = res.heard.length
      ? res.heard.map(function (n) { return midiName(n.midi); }).join(' ')
      : '（一个都没听出来）';

    el('dimContour').textContent = (diag.contour * 100).toFixed(1) + '%';
    el('dimPitch').textContent = (diag.pitch * 100).toFixed(1) + '%';
    el('dimRhythm').textContent = (diag.rhythm * 100).toFixed(1) + '%';
    el('dimComplete').textContent = (diag.completeness * 100).toFixed(1) + '%';

    el('verdict').innerHTML = verdictText(res);

    // 采集统计（0 分时最关键：区分"没录到"与"录到了但没检出"）
    var cap = res.capture;
    var capLine = el('captureStats');
    if (cap) {
      var voicedRatio = cap.frames ? Math.round((cap.voicedFrames / cap.frames) * 100) : 0;
      var rmsVsFloor = cap.noiseFloor > 0 ? (cap.rmsMax / cap.noiseFloor) : 0;
      capLine.innerHTML =
        '帧数 <b>' + cap.frames + '</b>（预期约 ' + Math.round(res.durationMs / 50) + '）· ' +
        '有音高帧 <b>' + cap.voicedFrames + '</b>（' + voicedRatio + '%）<br />' +
        '峰值电平 <b>' + cap.rmsMax.toFixed(5) + '</b> · 平均 <b>' + cap.rmsAvg.toFixed(5) + '</b> · ' +
        '底噪 <b>' + cap.noiseFloor.toFixed(5) + '</b> · 静默阈值 <b>' + cap.silenceThreshold.toFixed(5) + '</b>' +
        ' · 峰值/底噪 = <b>' + rmsVsFloor.toFixed(1) + 'x</b><br />' +
        (cap.frames === 0
          ? '<span class="err">一帧都没记录 → 录音循环没有运行（不是识别问题）</span>'
          : (cap.voicedFrames === 0
            ? '<span class="err">没有一帧检出音高 → 声音太小、太远，或音高超出 90–660Hz</span>'
            : (cap.rmsMax < cap.silenceThreshold
              ? '<span class="warn">峰值电平低于静默阈值 → 你唱的音被切成"静默"丢掉了</span>'
              : '<span class="ok">采集正常</span>')));
    }

    drawRoll(res);
  }

  function verdictText(res) {
    var s = res.score;
    var heard = res.heard.length;
    var target = res.target.length;
    var lines = [];

    if (res.reason === 'silence') {
      lines.push('<span class="warn">录到静默提前结束</span>——一分没拿到。这是设计行为（规格书 D3），不是 bug。');
    }
    if (heard === 0) {
      lines.push('<span class="err">一个音都没听出来。</span>可能原因：麦克风太远 / 声音太小 / 环境太吵。先确认「实时音高」那行在唱的时候有数字。');
    } else if (heard < target.length * 0.5) {
      lines.push('<span class="warn">只听到 ' + heard + ' / ' + target + ' 个音。</span>如果图里青色明显比黄色少，说明有的音没被检出（可能唱得太短、太轻，或连音没断开）。');
    }
    if (s >= 85) lines.push('分数很高。对照下面的图确认一下：青色和黄色的形状应该基本重合。');
    else if (s >= 60) lines.push('分数中等。看图里哪几个音对不上——如果确实是那几个音你没唱准，那分数是合理的。');
    else if (heard > 0) lines.push('分数偏低。看图判断：是<b>音高不对</b>（青色在同时间的黄色上下偏移很多），还是<b>节奏不对</b>（青色整体偏左或偏右），还是<b>音数不对</b>（青色比黄色少或多）？');
    lines.push('关键判据：<b>你自己觉得唱得怎么样，和这个分数一致吗？</b>不一致就是评分需要调，请点下面的按钮把记录发我。');
    return lines.join('<br />');
  }

  // ---------------------------------------------------------------- 音高图

  function drawRoll(res) {
    var cv = el('roll');
    var c = cv.getContext('2d');
    var W = cv.width;
    var H = cv.height;
    c.clearRect(0, 0, W, H);

    var all = [];
    var i;
    for (i = 0; i < res.target.length; i += 1) all.push(res.target[i].midi);
    for (i = 0; i < res.heard.length; i += 1) all.push(res.heard[i].midi);
    if (!all.length) return;

    var lo = Math.min.apply(null, all) - 2;
    var hi = Math.max.apply(null, all) + 2;
    if (hi - lo < 8) { var mid = (lo + hi) / 2; lo = mid - 4; hi = mid + 4; }

    var totalMs = Math.max(
      res.target.length ? res.target[res.target.length - 1].onsetMs + res.target[res.target.length - 1].durationMs : 0,
      res.durationMs
    );
    if (totalMs <= 0) totalMs = 1;

    var padL = 34;
    var padB = 16;
    var plotW = W - padL - 8;
    var plotH = H - padB - 8;

    var xOf = function (ms) { return padL + (ms / totalMs) * plotW; };
    var yOf = function (m) { return 8 + plotH - ((m - lo) / (hi - lo)) * plotH; };

    // 网格 + 音名刻度（每个半音）
    c.font = '10px sans-serif';
    c.strokeStyle = '#16323f';
    c.fillStyle = '#4a7383';
    c.lineWidth = 1;
    for (var m = Math.ceil(lo); m <= Math.floor(hi); m += 1) {
      var y = yOf(m);
      c.beginPath(); c.moveTo(padL, y); c.lineTo(W - 8, y); c.stroke();
      if (m % 12 === 0) { c.fillText(midiName(m), 2, y + 3); }
    }

    // 目标音（黄色）
    c.fillStyle = 'rgba(255, 217, 138, 0.85)';
    for (i = 0; i < res.target.length; i += 1) {
      var n = res.target[i];
      var x1 = xOf(n.onsetMs);
      var x2 = xOf(n.onsetMs + n.durationMs);
      var yy = yOf(n.midi);
      c.fillRect(x1, yy - 5, Math.max(2, x2 - x1 - 2), 10);
    }

    // 听出的音（青色）
    c.fillStyle = 'rgba(111, 216, 196, 0.85)';
    for (i = 0; i < res.heard.length; i += 1) {
      var h = res.heard[i];
      var hx1 = xOf(h.startMs);
      var hx2 = xOf(h.endMs);
      var hy = yOf(h.midi);
      c.fillRect(hx1, hy - 3, Math.max(2, hx2 - hx1), 6);
    }
  }

  // ---------------------------------------------------------------- 测试记录

  function buildReport() {
    if (!lastResult) return '还没唱。先听一句，再开录。';
    var r = lastResult;
    var d = r.verbose.dims;
    var cap = r.capture || { frames: 0, voicedFrames: 0, rmsAvg: 0, rmsMax: 0, noiseFloor: 0, silenceThreshold: 0, sampleRate: 0 };
    var voicedRatio = cap.frames ? Math.round((cap.voicedFrames / cap.frames) * 100) : 0;
    var rmsVsFloor = cap.noiseFloor > 0 ? (cap.rmsMax / cap.noiseFloor) : 0;
    var tr = frameTrace(r.frames || []);
    var lines = [
      '# D14 步骤 3 试唱记录（' + LAB_VERSION + '）',
      '时间：' + new Date().toISOString(),
      'UA：' + navigator.userAgent,
      '',
      '## 本次',
      '乐句：' + phrases[current].label,
      '结束原因：' + r.reason,
      '录音时长：' + Math.round(r.durationMs) + ' ms',
      '总分：' + r.score,
      '',
      '## 采集统计（0 分时最先看这里）',
      '帧数：' + cap.frames + '（预期约 ' + Math.round(r.durationMs / 50) + '）',
      '有音高帧：' + cap.voicedFrames + '（' + voicedRatio + '%）',
      '峰值电平：' + cap.rmsMax.toFixed(5) + ' RMS',
      '平均电平：' + cap.rmsAvg.toFixed(5) + ' RMS',
      '底噪基线：' + cap.noiseFloor.toFixed(5) + ' RMS',
      '静默阈值：' + cap.silenceThreshold.toFixed(5) + ' RMS（= 底噪 × 1.8）',
      '峰值/底噪：' + rmsVsFloor.toFixed(1) + 'x',
      '采样率：' + cap.sampleRate + ' Hz',
      '输入增益：' + (cap.inputGain !== undefined ? cap.inputGain.toFixed(2) + 'x' : '(未校准)') +
        '（校准期原始峰值 ' + (cap.inputPeak !== undefined ? cap.inputPeak.toFixed(5) : '-') + '）',
      (cap.inputGain > 1.05
        ? '  → 麦克风电平偏低，已自动补偿。这是设备/系统层的问题，不是你的问题。'
        : '  → 麦克风电平正常，未做补偿。'),
      '',
      '## 逐帧轨迹（每格 50ms）',
      '音名轨：' + tr.treble,
      '电平轨：' + tr.level,
      '  音名轨：字母=检出音名（不含八度），"." = 该帧无音高',
      '  电平轨：_ <0.005  - <0.02  = <0.05  + <0.1  # >=0.1（RMS）',
      '',
      '## 目标 vs 听出',
      '目标音数：' + r.target.length + '  →  听出：' + r.heard.length,
      '目标音名：' + r.target.map(function (n) { return midiName(n.midi); }).join(' '),
      '听出音名：' + (r.heard.length ? r.heard.map(function (n) { return midiName(n.midi); }).join(' ') : '(无)'),
      '切分统计：原始段 ' + r.segStats.rawNotes + ' / 合并后 ' + r.segStats.mergedNotes +
        ' / 保留 ' + r.segStats.keptNotes + ' / 丢碎片 ' + r.segStats.droppedFragments,
      '移调补偿：offset ' + r.verbose.transposition.offset +
        ' (八度 ' + r.verbose.transposition.octaveShift + ' + 细调 ' + r.verbose.transposition.fineOffset + ')',
      '',
      '## 四维拆解（仅开发期，P4 要求正式版不返回）',
      'Contour      ' + (d.contour * 100).toFixed(1) + '%  (权重 30%)',
      'Pitch        ' + (d.pitch * 100).toFixed(1) + '%  (权重 35%)',
      'Rhythm       ' + (d.rhythm * 100).toFixed(1) + '%  (权重 25%)',
      'Completeness ' + (d.completeness * 100).toFixed(1) + '%  (权重 10%)',
      '',
      '## 听出的音（起音ms / 时长ms / 音名 / 音分偏差）',
      r.heard.map(function (n) {
        return '  ' + Math.round(n.startMs) + 'ms  ' + Math.round(n.durationMs) + 'ms  ' +
          midiName(n.midi) + '  ' + n.hz.toFixed(1) + 'Hz';
      }).join('\n') || '  (无)',
      '',
      '## 需要你补充的主观判断',
      '1. 你唱的是真唱还是哼唱？',
      '2. 你自己觉得这次唱得怎么样（很好 / 还行 / 跑调 / 没跟上）？',
      '3. 这个分数和你的感觉一致吗？',
      '4. 如果面板里显示了"听出的音名"，和你实际想唱的一致吗？',
      '',
      '## 原始样本（一帧检出成功的 2048 点，降采样到 256 点）',
      rawFrame
        ? ('sampleRate: ' + rawFrame.sampleRate + '\nfullLength: ' + rawFrame.fullLength +
           '\nsamples256: [' + rawFrame.samples256.join(',') + ']')
        : '(本次没有成功检出的帧，未能抓取)'
    ];
    return lines.join('\n');
  }

  // ---------------------------------------------------------------- 绑定

  function bind() {
    el('playTimbre').addEventListener('click', playTimbreDemo);
    el('diagBtn').addEventListener('click', audioDiagnostics);
    el('micCheckBtn').addEventListener('click', micCheckup);
    el('diagBeep').addEventListener('click', function () {
      playRawBeep().catch(function (e) { recordError('原始正弦', e); });
    });
    el('listenBtn').addEventListener('click', listenPhrase);
    el('recordBtn').addEventListener('click', startRecord);
    el('stopBtn').addEventListener('click', stopRecord);
    el('micBtn').addEventListener('click', function () { ensureMic(); });
    el('phraseSelect').addEventListener('change', function () {
      current = parseInt(this.value, 10) || 0;
      setPhase('已换句：' + phrases[current].label);
      el('score').className = 'score dim';
      el('score').textContent = '--';
      el('verdict').textContent = '换句了。先点「① 听乐句」。';
      lastResult = null;
    });
    el('copyBtn').addEventListener('click', function () {
      var text = buildReport();
      el('reportOut').textContent = text;
    });
  }

  fillSelect();
  bind();
  setPhase('空闲');
  // 版本号显示在页面上，用于确认浏览器没有跑缓存的旧脚本
  var vt = el('verTag');
  if (vt) vt.textContent = '构建版本：' + LAB_VERSION + '（如果这里不是 ' + LAB_VERSION + '，说明页面跑的是旧缓存，请强制刷新）';
})();
