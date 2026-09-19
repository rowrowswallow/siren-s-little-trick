/* M0 探针逻辑（开发工具，不进上传包）
 *
 * 验证 02-后端开发规格书 D14 步骤 1：
 *   真机能唱出准确音名 + 单帧耗时 + 采样率 + 端到端延迟 + 噪音基线
 * 依赖：../core/pitch.js（Siren.Pitch）
 *
 * 硬约束与正式代码一致：无内联脚本、无行内事件、无外部资源、无 eval。
 */

(function () {
  'use strict';

  var Pitch = window.Siren && window.Siren.Pitch;
  if (!Pitch) {
    document.getElementById('hz').textContent = 'pitch.js 未加载';
    return;
  }

  var el = function (id) { return document.getElementById(id); };

  var ctx = null;
  var stream = null;
  var analyser = null;
  var sourceNode = null;
  var timer = null;

  var WINDOW = 2048;          // 可切 1024
  var INTERVAL_MS = 50;       // D5 规定 50ms

  var perf = [];              // 单帧耗时
  var confs = [];             // 置信度
  var hzHistory = [];         // 近 N 帧频率（含 0 表示无音高）
  var noteSeq = [];           // 音名序列（去重连续）
  var noiseFloor = 0.004;     // 环境噪音基线 RMS
  var peakRms = 0;
  var totalFrames = 0;
  var hitFrames = 0;
  var running = false;
  var calibMode = false;

  // ---------------------------------------------------------------- 音频初始化

  function ensureContext() {
    if (!ctx) {
      var Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) throw new Error('本环境不支持 AudioContext');
      ctx = new Ctor();
    }
    return ctx;
  }

  function start() {
    var btn = el('start');
    btn.disabled = true;
    el('micState').textContent = '请求中…';

    // 必须在用户手势内创建 / 恢复（iOS 关键）
    var c;
    try {
      c = ensureContext();
    } catch (e) {
      el('micState').innerHTML = '<span class="err">AudioContext 创建失败：' + e.message + '</span>';
      btn.disabled = false;
      return;
    }

    var resumePromise = c.state === 'suspended' ? c.resume() : Promise.resolve();

    resumePromise
      .then(function () {
        el('ctxState').textContent = c.state;
        el('sr').textContent = c.sampleRate + ' Hz';
        return navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
          }
        });
      })
      .then(function (s) {
        stream = s;
        el('micState').innerHTML = '<span class="ok">已授权</span>';

        sourceNode = c.createMediaStreamSource(s);
        analyser = c.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0;
        sourceNode.connect(analyser);
        // 绝不 connect 到 destination，否则啸叫

        var track = s.getAudioTracks()[0];
        var settings = track && track.getSettings ? track.getSettings() : {};
        el('dspState').textContent =
          (settings.echoCancellation === false ? '关' : String(settings.echoCancellation)) + ' / ' +
          (settings.noiseSuppression === false ? '关' : String(settings.noiseSuppression)) + ' / ' +
          (settings.autoGainControl === false ? '关' : String(settings.autoGainControl));

        // 验证 getFloatTimeDomainData 可用
        try {
          var probe = new Float32Array(analyser.fftSize);
          analyser.getFloatTimeDomainData(probe);
          var isNum = typeof probe[0] === 'number';
          el('analyserOk').innerHTML = isNum
            ? '<span class="ok">可用</span>'
            : '<span class="err">返回非数值</span>';
        } catch (e2) {
          el('analyserOk').innerHTML = '<span class="err">不可用：' + e2.message + '</span>';
        }

        resetStats();
        startCalibration(3);
        el('stop').disabled = false;
        el('calib').disabled = false;
        btn.disabled = false;
        btn.textContent = '重新开始采集';
        running = true;
        loop();
      })
      .catch(function (err) {
        el('micState').innerHTML = '<span class="err">失败：' + (err && err.name ? err.name : '') +
          (err && err.message ? ' · ' + err.message : '') + '</span>';
        btn.disabled = false;
      });
  }

  function stop() {
    running = false;
    if (timer) { clearTimeout(timer); timer = null; }
    if (sourceNode) { try { sourceNode.disconnect(); } catch (e) { /* 忽略 */ } sourceNode = null; }
    if (stream) {
      var tracks = stream.getTracks();
      for (var i = 0; i < tracks.length; i += 1) tracks[i].stop();
      stream = null;
    }
    analyser = null;
    el('hz').textContent = '--';
    el('hz').className = 'big pitch none';
    el('note').textContent = '';
    el('stop').disabled = true;
    el('start').disabled = false;
  }

  // ---------------------------------------------------------------- 统计

  function resetStats() {
    perf = [];
    confs = [];
    hzHistory = [];
    noteSeq = [];
    peakRms = 0;
    totalFrames = 0;
    hitFrames = 0;
    el('seq').textContent = '--';
  }

  function startCalibration(seconds) {
    calibMode = true;
    el('noiseFloor').textContent = '测量中，请保持安静 ' + seconds + ' 秒…';
    var samples = [];
    var endAt = performance.now() + seconds * 1000;
    var calBuf = new Float32Array(analyser.fftSize);
    var tick = function () {
      if (!analyser || performance.now() >= endAt) {
        calibMode = false;
        if (samples.length) {
          samples.sort(function (a, b) { return a - b; });
          noiseFloor = samples[Math.floor(samples.length * 0.75)];  // 取 75 分位，避开偶发噪声
        }
        el('noiseFloor').textContent = noiseFloor.toFixed(5) + ' RMS';
        return;
      }
      analyser.getFloatTimeDomainData(calBuf);
      var sum = 0;
      for (var i = 0; i < calBuf.length; i += 1) sum += calBuf[i] * calBuf[i];
      samples.push(Math.sqrt(sum / calBuf.length));
      setTimeout(tick, 40);
    };
    tick();
  }

  function rmsOf(buf) {
    var sum = 0;
    for (var i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }

  function percentile(arr, p) {
    if (!arr.length) return 0;
    var sorted = arr.slice().sort(function (a, b) { return a - b; });
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  }

  function median(arr) {
    if (!arr.length) return 0;
    var sorted = arr.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // ---------------------------------------------------------------- 主循环

  var buf = null;

  function loop() {
    if (!running || !analyser) return;

    if (!buf || buf.length !== WINDOW) buf = new Float32Array(WINDOW);

    // AnalyserNode 的 fftSize 决定可取长度；窗口 1024 时取后 1024 个样本
    var t0 = performance.now();
    if (analyser.fftSize >= WINDOW) {
      var full = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(full);
      buf.set(full.subarray(full.length - WINDOW));
    } else {
      analyser.getFloatTimeDomainData(buf);
    }
    var rms = rmsOf(buf);

    var r = Pitch.detectPitch(buf, ctx.sampleRate, WINDOW);
    var t1 = performance.now();
    var cost = t1 - t0;

    if (!calibMode) {
      totalFrames += 1;
      perf.push(cost);
      if (perf.length > 400) perf.shift();
      if (rms > peakRms) peakRms = rms;
      if (r.hz > 0) {
        hitFrames += 1;
        confs.push(r.conf);
        if (confs.length > 400) confs.shift();
      }
      hzHistory.push(r.hz);
      if (hzHistory.length > 150) hzHistory.shift();

      var name = r.hz > 0 ? Pitch.midiToName(r.midi) : null;
      if (name) {
        if (!noteSeq.length || noteSeq[noteSeq.length - 1] !== name) noteSeq.push(name);
        if (noteSeq.length > 24) noteSeq.shift();
      }
    }

    render(r, rms);
    timer = setTimeout(loop, INTERVAL_MS);
  }

  function render(r, rms) {
    var hzEl = el('hz');
    if (r.hz > 0) {
      hzEl.textContent = r.hz.toFixed(1);
      hzEl.className = 'big pitch';
      el('note').textContent = Pitch.midiToName(r.midi);
    } else {
      hzEl.textContent = '--';
      hzEl.className = 'big pitch none';
      el('note').textContent = '';
    }

    el('conf').textContent = r.conf > 0 ? r.conf.toFixed(3) : '--';
    el('rms').textContent = rms.toFixed(5) + (rms > noiseFloor * 4 ? '  (有声)' : '  (静默)');

    var voiced = hzHistory.filter(function (h) { return h > 0; });
    if (voiced.length >= 3) {
      var m = median(voiced);
      el('median').textContent = m.toFixed(1) + ' Hz / ' + Pitch.midiToName(Pitch.hzToMidi(m));
    } else {
      el('median').textContent = '样本不足';
    }

    // 性能
    var p50 = percentile(perf, 0.5);
    var p95 = percentile(perf, 0.95);
    var mx = perf.length ? Math.max.apply(null, perf) : 0;
    el('perf50').textContent = p50.toFixed(3) + ' ms' + (p50 < 5 ? '' : '  ← 超预算');
    el('perf95').textContent = p95.toFixed(3) + ' ms';
    el('perfMax').textContent = mx.toFixed(3) + ' ms';
    el('perfCount').textContent = perf.length + ' 次 / 窗口 ' + WINDOW;
    var bar = el('perfBar');
    bar.style.width = Math.min(100, (p50 / 5) * 100).toFixed(1) + '%';
    bar.style.background = p50 < 5 ? '' : '#ff8098';

    // 环境
    el('ctxState').textContent = ctx ? ctx.state : '--';
    var snr = noiseFloor > 0 ? (peakRms / noiseFloor) : 0;
    el('snr').textContent = peakRms > 0
      ? snr.toFixed(1) + 'x' + (snr > 4 ? '  (可识别)' : '  (偏低，需靠近麦克风)')
      : '--';
    el('hitRate').textContent = totalFrames
      ? ((hitFrames / totalFrames) * 100).toFixed(1) + '%  (' + hitFrames + '/' + totalFrames + ')'
      : '--';
    el('seq').textContent = noteSeq.length ? noteSeq.join(' ') : '--';

    // 延迟估算：检测周期 + 分析窗口时长（半个窗口是固有延迟）
    var winMs = (WINDOW / (ctx ? ctx.sampleRate : 48000)) * 1000;
    var est = INTERVAL_MS / 2 + winMs / 2;
    el('latency').textContent = est.toFixed(0) + ' ms 估算'
      + (est < 150 ? '  (达标)' : '  ← 超 150ms 预算')
      + '（= 检测间隔/2 + 窗口/2；真实值需录屏帧比对）';

    drawHistory();
  }

  // ---------------------------------------------------------------- 音高历史条

  var histCanvas = null;
  var histCtx = null;

  function drawHistory() {
    if (!histCanvas) {
      histCanvas = el('history');
      histCtx = histCanvas.getContext('2d');
    }
    var W = histCanvas.width;
    var H = histCanvas.height;
    histCtx.clearRect(0, 0, W, H);

    // 音域参考线 C3..E5 (130.81 .. 659.26 Hz)
    var lo = Math.log(110), hi = Math.log(700);
    var yOf = function (hz) { return H - ((Math.log(hz) - lo) / (hi - lo)) * H; };

    var marks = [130.81, 196, 261.63, 329.63, 392, 523.25, 659.26];
    histCtx.strokeStyle = '#16323f';
    histCtx.fillStyle = '#4a7383';
    histCtx.font = '18px sans-serif';
    histCtx.lineWidth = 2;
    for (var i = 0; i < marks.length; i += 1) {
      var y = yOf(marks[i]);
      histCtx.beginPath();
      histCtx.moveTo(0, y);
      histCtx.lineTo(W, y);
      histCtx.stroke();
      histCtx.fillText(Pitch.midiToName(Pitch.hzToMidi(marks[i])), 4, y - 4);
    }

    // 曲线
    histCtx.strokeStyle = '#6fd8c4';
    histCtx.lineWidth = 4;
    histCtx.beginPath();
    var started = false;
    for (var j = 0; j < hzHistory.length; j += 1) {
      var x = (j / 150) * W;
      var hz = hzHistory[j];
      if (hz <= 0) { started = false; continue; }
      var yy = yOf(Math.max(110, Math.min(700, hz)));
      if (!started) { histCtx.moveTo(x, yy); started = true; }
      else histCtx.lineTo(x, yy);
    }
    histCtx.stroke();
  }

  // ---------------------------------------------------------------- 报告

  function buildReport() {
    var p50 = percentile(perf, 0.5);
    var p95 = percentile(perf, 0.95);
    var sr = ctx ? ctx.sampleRate : 0;
    var winMs = sr ? (WINDOW / sr) * 1000 : 0;
    var lines = [
      '# M0 探针报告',
      '时间：' + new Date().toISOString(),
      'UA：' + navigator.userAgent,
      '',
      '## A1 AudioContext / AnalyserNode',
      'AudioContext 可用：' + (ctx ? '是' : '否'),
      '采样率：' + (sr || '--') + ' Hz',
      '状态：' + (ctx ? ctx.state : '--'),
      'AnalyserNode 可用：' + el('analyserOk').textContent.trim(),
      '麦克风：' + el('micState').textContent.trim(),
      'DSP (AEC/NS/AGC)：' + el('dspState').textContent.trim() + '（规格书 D4.7 要求三个都关）',
      '',
      '## A2 主线程单帧耗时（目标 < 5ms）',
      '中位数：' + p50.toFixed(3) + ' ms',
      'P95：' + p95.toFixed(3) + ' ms',
      '最差：' + (perf.length ? Math.max.apply(null, perf).toFixed(3) : '--') + ' ms',
      '样本数：' + perf.length,
      '分析窗口：' + WINDOW,
      '结论：' + (p50 < 5 ? '达标' : '超预算，需切窗口 1024 或降低检测频率'),
      '',
      '## A4 采样率与延迟',
      '采样率：' + (sr || '--') + ' Hz（规格书要求运行时读取，不硬编码）',
      '窗口时长：' + winMs.toFixed(1) + ' ms',
      '检测间隔：' + INTERVAL_MS + ' ms（规格书 D11 要求 20Hz）',
      '端到端延迟估算：' + (INTERVAL_MS / 2 + winMs / 2).toFixed(0) + ' ms（目标 < 150ms，真实值需录屏帧比对）',
      '',
      '## A5 环境噪音与识别率',
      '噪音基线：' + noiseFloor.toFixed(5) + ' RMS',
      '峰值电平：' + peakRms.toFixed(5) + ' RMS',
      '信噪比：' + (noiseFloor > 0 ? (peakRms / noiseFloor).toFixed(1) + 'x' : '--'),
      '有音高帧占比：' + (totalFrames ? ((hitFrames / totalFrames) * 100).toFixed(1) + '%' : '--'),
      '音名序列：' + (noteSeq.join(' ') || '--'),
      '',
      '## 待人工确认（离线环境无法验证）',
      '- 唱 C4 时读数是否 ≈ 261.6Hz / 显示 C4',
      '- 唱 C5 时读数是否 ≈ 523.3Hz（若读到 261.6 说明又出现八度错误）',
      '- 哼唱（闭口）与真唱的音名是否一致',
      '- 端到端延迟体感是否跟得上（录屏逐帧比对）'
    ];
    return lines.join('\n');
  }

  // ---------------------------------------------------------------- 绑定

  function bind() {
    el('start').addEventListener('click', function () {
      if (running) stop();
      start();
    });
    el('stop').addEventListener('click', stop);
    el('calib').addEventListener('click', function () {
      if (!analyser) return;
      startCalibration(3);
    });
    el('report').addEventListener('click', function () {
      var text = buildReport();
      el('reportOut').textContent = text;
      // 剪贴板被禁（规格书 D1），只提供可选中文本让用户长按复制
    });
    el('toggleWin').addEventListener('click', function () {
      WINDOW = WINDOW === 2048 ? 1024 : 2048;
      buf = null;
      el('winInfo').textContent = WINDOW + (WINDOW === 2048 ? '（默认）' : '（性能兜底）');
      this.textContent = WINDOW === 2048 ? '切到窗口 1024（性能兜底）' : '切回窗口 2048（默认）';
      resetStats();
    });
  }

  bind();
  drawHistory();
})();
