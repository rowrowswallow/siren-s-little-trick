/* Presentation layer. All musical decisions and boat counts come from Siren's public events. */
(function () {
  'use strict';

  var api = window.Siren;
  var app = document.getElementById('app');
  if (!app || !api || typeof api.getState !== 'function') return;
  var ids = ['stage', 'fleet-canvas', 'siren', 'home-view', 'permission-view', 'state-heading',
    'state-title', 'state-hint', 'countdown', 'voice-dock', 'tap-target', 'mic-label', 'note-track',
    'ship-counter', 'ship-number', 'phrase-dots', 'phrase-result', 'phrase-number',
    'phrase-result-label', 'revealed-title', 'result-view', 'result-number', 'ending-line',
    'technical-notice', 'rotate-hint', 'boot-message', 'share-view', 'share-card', 'share-fleet',
    'share-number', 'share-line', 'status-live'];
  var el = {};
  ids.forEach(function (id) { el[id] = document.getElementById(id); });
  var controls = {};
  app.querySelectorAll('[data-action]').forEach(function (button) {
    controls[button.dataset.action] = button;
  });
  var canvas = el['fleet-canvas'];
  var ctx = canvas.getContext('2d');
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  var state = api.getState();
  var ships = new Map();
  var sprites = [];
  var size = { width: 1, height: 1, ratio: 1 };
  var notes = [];
  var noteNodes = [];
  var pearl = document.createElement('span');
  pearl.className = 'pitch-pearl';
  pearl.setAttribute('aria-hidden', 'true');
  var timing = { mode: '', start: 0, duration: 1, center: 66 };
  var ui = {
    phrase: -1, replayUsed: false, silent: false, sharing: false, fallback: false,
    total: 0, newShips: 0, ending: 'D', voicedUntil: 0, pitch: 66,
    hero: null, wreckCount: 0, lastNotice: '', noticeAt: -Infinity,
    noticeTimer: null, denied: false, rotateDismissed: false
  };
  var frameId = null;
  var lastFrame = 0;
  var tapUntil = 0;
  var lastActiveNote = -2;
  var endingCopy = {
    A: '你把她的小把戏学会了',
    B: '船队留下来听她唱歌',
    C: '她在试着留住更多',
    D: '船走远了，她还在等你'
  };

  // Fleet geometry as fractions of the stage. The two orientations need their own bands:
  // landscape stretches the sea scene over the whole stage (horizon at y 0.27), portrait
  // anchors it to the bottom at 87% height (horizon at y 0.36) and the siren occupies the
  // lower-left corner from y 0.61 down, so nothing may dock below that line.
  var FLEET = {
    landscape: {
      sailX: 0.200, sailStep: 0.0345, sailY: 0.285, waveStep: 0.046,
      dockX: 0.245, dockStep: 0.0385, dockColumns: 18, dockY: 0.715, dockRow: 0.0550,
      boatWidth: 0.037, wreckWidth: 0.024, heroX: 0.55, heroY: 0.55, heroWidth: 0.12
    },
    portrait: {
      sailX: 0.090, sailStep: 0.0425, sailY: 0.375, waveStep: 0.015,
      dockX: 0.050, dockStep: 0.0605, dockColumns: 15, dockY: 0.452, dockRow: 0.0255,
      boatWidth: 0.040, wreckWidth: 0.046, heroX: 0.62, heroY: 0.50, heroWidth: 0.17
    }
  };

  function now() { return performance.now(); }
  function clamp(value, low, high) { return Math.max(low, Math.min(high, value)); }
  function visible(id, show) { if (el[id]) el[id].hidden = !show; }
  function text(id, value) { if (el[id]) el[id].textContent = value; }
  function announce(value) { text('status-live', value); }
  function isPlaying() {
    return state.phase === 'LEARN_LOOP' || state.phase === 'RHYTHM_FALLBACK';
  }
  function clearNotice() {
    window.clearTimeout(ui.noticeTimer);
    ui.noticeTimer = null;
    visible('technical-notice', false);
    text('technical-notice', '');
  }
  function showNotice(code, copy) {
    if (ui.silent || (code === ui.lastNotice && now() - ui.noticeAt < 12000)) return;
    clearNotice();
    ui.lastNotice = code;
    ui.noticeAt = now();
    text('technical-notice', copy);
    visible('technical-notice', true);
    ui.noticeTimer = window.setTimeout(clearNotice, 3300);
  }
  function onTechnical(event) {
    var code = event.code;
    if (code === 'NO_INPUT') {
      setSilence();
    } else if (code === 'MIC_DENIED') {
      ui.denied = true;
      showNotice(code, '麦克风未开启，跟着节奏轻点也可以');
    } else if (code === 'MIC_RETRY') {
      // Denial immediately enters the playable tap route; a retry prompt would contradict it.
      if (!ui.denied && state.phase === 'HOME') showNotice(code, '再点一下让她开口');
    } else if (code === 'NOISY_ENV') {
      showNotice(code, '周围有点吵，靠近一点麦克风');
    } else if (code === 'LOW_CONFIDENCE') {
      showNotice(code, '有点听不清，再靠近一点');
    }
  }
  function setSilence() {
    ui.silent = true;
    ui.voicedUntil = 0;
    clearNotice();
    el.siren.classList.add('is-submerged');
    el.siren.classList.remove('is-glowing');
    visible('state-heading', false);
    announce('');
  }
  function resetRun() {
    ships.clear();
    ui.total = 0;
    ui.newShips = 0;
    ui.wreckCount = 0;
    ui.hero = null;
    ui.phrase = -1;
    ui.replayUsed = false;
    ui.silent = false;
    ui.sharing = false;
    ui.fallback = false;
    ui.denied = false;
    ui.ending = 'D';
    ui.voicedUntil = 0;
    ui.lastNotice = '';
    ui.noticeAt = -Infinity;
    tapUntil = 0;
    timing.mode = '';
    clearNotice();
    text('ship-number', '0');
    text('phrase-number', '0');
    text('result-number', '0');
    text('share-number', '0');
    visible('revealed-title', false);
    el.siren.classList.remove('is-submerged', 'is-glowing');
    drawFleet(now());
  }

  function renderState(event) {
    var previous = state;
    state = Object.assign({}, api.getState(), event || {});
    var phase = state.phase;
    var sub = state.subPhase;
    if (phase === 'HOME' && previous.phase !== 'HOME') resetRun();
    if (phase === 'PERM_REQUEST' && previous.phase !== 'PERM_REQUEST') resetRun();
    ui.fallback = phase === 'RHYTHM_FALLBACK';
    if (sub === 'LISTEN' && (previous.subPhase !== 'LISTEN' || previous.phraseIndex !== state.phraseIndex)) {
      ui.silent = false;
      ui.voicedUntil = 0;
      visible('revealed-title', false);
      el.siren.classList.remove('is-submerged', 'is-glowing');
    }
    if (sub === 'COUNTDOWN' && previous.subPhase !== 'COUNTDOWN') {
      el.countdown.querySelectorAll('i').forEach(function (dot) { dot.classList.remove('lit'); });
    }
    app.dataset.phase = phase;
    app.dataset.subphase = sub || '';
    app.dataset.input = ui.fallback ? 'rhythm' : 'voice';
    var playing = isPlaying();
    var result = phase === 'RESULT' || phase === 'SHARE_CARD';
    var phraseResult = playing && sub === 'PHRASE_RESULT';
    var dock = playing && ['LISTEN', 'COUNTDOWN', 'RECORD'].indexOf(sub) !== -1;
    visible('home-view', phase === 'HOME');
    visible('permission-view', phase === 'PERM_REQUEST');
    visible('boot-message', phase === 'BOOT');
    visible('voice-dock', dock);
    visible('phrase-result', phraseResult);
    visible('result-view', result && !ui.sharing);
    visible('share-view', ui.sharing);
    visible('ship-counter', playing && !phraseResult);
    visible('phrase-dots', playing && !phraseResult);
    visible('state-heading', ((playing && !phraseResult) || phase === 'FINALE') && !ui.silent);
    visible('countdown', sub === 'COUNTDOWN');
    if (controls.abort) controls.abort.hidden = !(playing || phase === 'PERM_REQUEST' || phase === 'FINALE');
    if (controls.replay) {
      controls.replay.disabled = phase !== 'LEARN_LOOP' || sub !== 'LISTEN' || ui.replayUsed;
      controls.replay.hidden = ui.fallback;
    }
    el.stage.classList.toggle('is-sharing', ui.sharing);
    el['tap-target'].disabled = !(ui.fallback && sub === 'RECORD');
    el['tap-target'].dataset.action = 'tap';
    el['tap-target'].classList.toggle('is-listening', sub === 'LISTEN');
    el['tap-target'].classList.toggle('is-recording', sub === 'RECORD');
    var labels = {
      LISTEN: ['听，她在唱', '', '她在唱'],
      COUNTDOWN: ['准备好了吗', '', '准备'],
      RECORD: [ui.fallback ? '跟着节奏轻点' : '轮到你了', '', ui.fallback ? '轻点' : '她在听'],
      ANALYZE: ['', '', ''],
      PULL: ['', '', '']
    };
    var label = labels[sub] || ['', '', ''];
    if (phase === 'FINALE') label = ['听，完整的旋律', '', ''];
    text('state-title', label[0]);
    text('state-hint', label[1]);
    visible('state-hint', !!label[1]);
    text('mic-label', label[2]);
    el.siren.dataset.pose = sub === 'LISTEN' || phase === 'FINALE' ? 'sing' : sub === 'RECORD' ? 'listen' : 'idle';
    el['phrase-dots'].querySelectorAll('i').forEach(function (dot, index) {
      dot.classList.toggle('past', index < state.phraseIndex);
      dot.classList.toggle('current', index === state.phraseIndex);
    });
    if (phase === 'RESULT' || phase === 'SHARE_CARD') {
      ui.total = state.shipsWrecked;
      text('result-number', ui.total);
      text('ending-line', endingCopy[ui.total === 0 ? 'D' : ui.ending]);
    }
    if (sub !== 'RECORD') pearl.style.opacity = '0';
    if (!dock && phase !== 'FINALE') timing.mode = '';
    if (label[0] && !ui.silent && (previous.subPhase !== sub || previous.phase !== phase)) announce(label[0]);
    requestFrame();
  }

  function installNotes(list, mode) {
    notes = (list || []).slice();
    timing.mode = mode;
    timing.start = now() + (mode === 'listen' || mode === 'finale' ? 80 : 0);
    timing.duration = notes.reduce(function (end, note) {
      return Math.max(end, note.startMs + note.durationMs);
    }, 1);
    timing.center = notes.length ? notes.reduce(function (sum, note) { return sum + note.midi; }, 0) / notes.length : 66;
    el['note-track'].textContent = '';
    noteNodes = [];
    // Finale has its own singing animation; a full song need not become dozens of tiny controls.
    if (mode !== 'finale') {
      notes.forEach(function (note) {
        var node = document.createElement('span');
        node.className = 'note';
        node.setAttribute('aria-hidden', 'true');
        node.style.setProperty('--note-y', clamp((timing.center - note.midi) * 2, -16, 16) + 'px');
        el['note-track'].appendChild(node);
        noteNodes.push(node);
      });
      el['note-track'].appendChild(pearl);
    }
    pearl.style.opacity = '0';
    lastActiveNote = -2;
    requestFrame();
  }
  function phraseStart(event) {
    if (ui.phrase !== event.phraseIndex) {
      ui.phrase = event.phraseIndex;
      ui.replayUsed = false;
      visible('revealed-title', false);
    }
    installNotes(event.notes, 'listen');
    renderState();
  }
  function attemptStart() {
    timing.mode = 'record';
    timing.start = now() + (ui.fallback ? 500 : 50);
    ui.voicedUntil = 0;
    lastActiveNote = -2;
    noteNodes.forEach(function (node) { node.classList.remove('on', 'current', 'dim'); });
    requestFrame();
  }
  function onPitch(event) {
    if (state.subPhase !== 'RECORD') return;
    ui.voicedUntil = event.voiced ? now() + 110 : 0;
    if (event.voiced && Number.isFinite(event.midi)) ui.pitch = event.midi;
    updateNotes(now());
  }
  function updateNotes(time) {
    if (!timing.mode || timing.mode === 'finale') return;
    var elapsed = time - timing.start;
    var active = -1;
    notes.some(function (note, index) {
      if (elapsed >= note.startMs && elapsed < note.startMs + note.durationMs) {
        active = index;
        return true;
      }
      return false;
    });
    var recording = timing.mode === 'record';
    var voiced = recording && (ui.fallback ? time < tapUntil : time < ui.voicedUntil);
    noteNodes.forEach(function (node, index) {
      node.classList.toggle('current', index === active);
      if (!recording) {
        node.classList.toggle('on', elapsed >= notes[index].startMs);
        node.classList.remove('dim');
      } else if (index === active) {
        node.classList.toggle('on', voiced);
        node.classList.toggle('dim', !voiced);
      } else if (active !== lastActiveNote && elapsed < notes[index].startMs) {
        node.classList.remove('on', 'dim');
      }
    });
    lastActiveNote = active;
    if (recording && !ui.fallback && voiced) {
      pearl.style.opacity = '1';
      pearl.style.left = clamp(elapsed / timing.duration * 96, 0, 96) + '%';
      // Register folding is only a position in the visual; it never produces a score or judgment.
      var shownPitch = ui.pitch + Math.round((timing.center - ui.pitch) / 12) * 12;
      pearl.style.top = 'calc(50% + ' + clamp((timing.center - shownPitch) * 3, -22, 22) + 'px)';
    } else {
      pearl.style.opacity = '0';
    }
    el['tap-target'].classList.toggle('tapped', time < tapUntil);
  }

  function onShipIn(event) {
    if (ships.has(event.id)) return;
    var wave = Math.floor((event.id - 1) / 20);
    var firstOfWave = !Array.from(ships.values()).some(function (ship) { return ship.wave === wave; });
    if (firstOfWave) ui.hero = event.id;
    // ship:in is emitted after entryDelayMs by the backend. Do not delay it a second time.
    ships.set(event.id, {
      id: event.id, lane: event.lane, depth: clamp(event.depth, 0, 1), side: event.side,
      born: now(), wave: wave, wrecked: false, wreckAt: 0, wreckSlot: -1,
      fromX: event.side === 'left' ? -0.08 : 1.08, fromY: 0.30,
      pull: 1, settled: false
    });
    requestFrame();
  }
  function layout() { return size.height > size.width ? FLEET.portrait : FLEET.landscape; }
  function shipLocation(ship, time) {
    var lay = layout();
    var unit = (ship.id - 1) % 20;
    var baseX = lay.sailX + unit * lay.sailStep;
    var baseY = lay.sailY + ship.wave * lay.waveStep + ship.lane * 0.003;
    var hero = ship.id === ui.hero && !ship.settled;
    if (hero) { baseX = lay.heroX; baseY = lay.heroY; }
    var entry = reduced.matches ? 1 : clamp((time - ship.born) / 850, 0, 1);
    var ease = 1 - Math.pow(1 - entry, 3);
    var x = ship.fromX + (baseX - ship.fromX) * ease;
    var y = ship.fromY + (baseY - ship.fromY) * ease;
    var width = hero ? lay.heroWidth : lay.boatWidth * (1 - ship.depth * 0.2);
    var angle = reduced.matches ? 0 : Math.sin(time / 550 + ship.id) * 0.035;
    var progress = 0;
    if (ship.wrecked) {
      progress = reduced.matches ? 1 : clamp((time - ship.wreckAt) / (780 - ship.pull * 70), 0, 1);
      var pullEase = progress * progress * (3 - 2 * progress);
      var dockX = lay.dockX + (ship.wreckSlot % lay.dockColumns) * lay.dockStep;
      var dockY = lay.dockY + Math.floor(ship.wreckSlot / lay.dockColumns) * lay.dockRow;
      x = ship.pullX + (dockX - ship.pullX) * pullEase;
      y = ship.pullY + (dockY - ship.pullY) * pullEase;
      width = ship.pullWidth + (lay.wreckWidth - ship.pullWidth) * pullEase;
      angle = reduced.matches ? 0 : -Math.sin(progress * Math.PI) * (0.16 + ship.pull * 0.07);
      if (progress === 1) ship.settled = true;
    } else if (!reduced.matches) {
      x += Math.sin(time / 3500 + ship.id * 2) * 0.002;
      y += Math.sin(time / 600 + ship.id) * 0.0018;
    }
    return { x: x, y: y, width: width, angle: angle, progress: progress, hero: hero };
  }
  function onShipWrecked(event) {
    var ship = ships.get(event.id);
    if (!ship || ship.wrecked) return;
    var at = now();
    var position = shipLocation(ship, at);
    ship.pullX = position.x;
    ship.pullY = position.y;
    ship.pullWidth = position.width;
    ship.wrecked = true;
    ship.wreckAt = at;
    ship.wreckSlot = ui.wreckCount++;
    ship.pull = Number.isFinite(event.pull) ? clamp(event.pull, 0, 4) : 4;
    ui.total += 1;
    text('ship-number', ui.total);
    el.siren.classList.add('is-glowing');
    requestFrame();
  }
  function drawBoat(context, x, y, width, angle, type, wake) {
    context.save();
    context.translate(x, y);
    context.rotate(angle || 0);
    if (wake) {
      context.strokeStyle = '#f8ffff';
      context.lineWidth = Math.max(1.5, width * 0.025);
      context.lineCap = 'round';
      context.beginPath();
      context.ellipse(0, 1, width * 0.56, width * 0.095, 0, 0.08, Math.PI - 0.08);
      context.stroke();
    }
    var sprite = sprites[type % 3];
    if (sprite) {
      var height = width * sprite.height / sprite.width;
      context.drawImage(sprite, -width / 2, -height + 2, width, height);
    } else {
      // A resource failure keeps the game legible; the packaged generated art is the normal route.
      context.fillStyle = '#fffbed'; context.strokeStyle = '#17232a'; context.lineWidth = Math.max(1, width * 0.04);
      context.beginPath(); context.moveTo(-width * 0.27, -width * 0.23); context.lineTo(-width * 0.20, -width * 0.48);
      context.lineTo(width * 0.20, -width * 0.48); context.lineTo(width * 0.27, -width * 0.23);
      context.closePath(); context.fill(); context.stroke();
      context.fillStyle = ['#ff8972', '#ffcb4a', '#6ed7c4'][type % 3];
      context.beginPath(); context.moveTo(-width / 2, -width * 0.22); context.lineTo(width / 2, -width * 0.22);
      context.lineTo(width * 0.33, 0); context.lineTo(-width * 0.33, 0); context.closePath(); context.fill(); context.stroke();
    }
    context.restore();
  }
  function drawFleet(time) {
    if (!ctx) return;
    ctx.clearRect(0, 0, size.width, size.height);
    var positioned = [];
    ships.forEach(function (ship) { positioned.push({ ship: ship, position: shipLocation(ship, time) }); });
    positioned.sort(function (a, b) { return a.position.y - b.position.y; });
    positioned.forEach(function (item) {
      var p = item.position;
      var ship = item.ship;
      var x = p.x * size.width;
      var y = p.y * size.height;
      var width = p.width * size.width;
      if (p.hero && !ship.wrecked && !reduced.matches) {
        ctx.save(); ctx.strokeStyle = '#eeffffb0'; ctx.lineWidth = Math.max(2, size.width * 0.002);
        ctx.setLineDash([size.height * 0.012, size.height * 0.012]);
        ctx.beginPath(); ctx.moveTo(x, size.height * layout().sailY); ctx.lineTo(x, y - width * 0.9); ctx.stroke(); ctx.restore();
      }
      drawBoat(ctx, x, y, width, p.angle, (ship.id - 1) % 3, !ship.settled);
      var flashAge = time - ship.wreckAt - (780 - ship.pull * 70);
      if (ship.wrecked && !reduced.matches && flashAge >= 0 && flashAge < 260) {
        ctx.save(); ctx.strokeStyle = '#fff7b0'; ctx.lineWidth = Math.max(2, width * 0.06);
        ctx.globalAlpha = 1 - flashAge / 260;
        for (var i = 0; i < 5; i += 1) {
          var angle = Math.PI + i * Math.PI / 4;
          ctx.beginPath();
          ctx.moveTo(x + Math.cos(angle) * width * 0.5, y - width * 0.4 + Math.sin(angle) * width * 0.5);
          ctx.lineTo(x + Math.cos(angle) * width * 0.75, y - width * 0.4 + Math.sin(angle) * width * 0.75);
          ctx.stroke();
        }
        ctx.restore();
      }
    });
  }
  function resize() {
    var rect = el.stage.getBoundingClientRect();
    size.width = Math.max(1, rect.width);
    size.height = Math.max(1, rect.height);
    size.ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(size.width * size.ratio);
    canvas.height = Math.round(size.height * size.ratio);
    if (ctx) ctx.setTransform(size.ratio, 0, 0, size.ratio, 0, 0);
    drawFleet(now());
    if (ui.sharing) drawShareFleet();
  }
  function requestFrame() {
    if (frameId === null && !document.hidden) frameId = window.requestAnimationFrame(frame);
  }
  function frame(time) {
    frameId = null;
    if (document.hidden) return;
    if (time - lastFrame > 30) {
      lastFrame = time;
      updateNotes(time);
      if (!ui.sharing) drawFleet(time);
    }
    if (!ui.sharing && (isPlaying() || state.phase === 'FINALE' || (ships.size && !reduced.matches))) requestFrame();
  }

  function drawShareFleet() {
    var shareCanvas = el['share-fleet'];
    var rect = shareCanvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    var ratio = Math.min(window.devicePixelRatio || 1, 2);
    shareCanvas.width = Math.round(rect.width * ratio);
    shareCanvas.height = Math.round(rect.height * ratio);
    var context = shareCanvas.getContext('2d');
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    // The miniature fleet contains one generated boat for each actually attracted ship.
    var count = ui.total;
    var columns = 10;
    var boatWidth = rect.width * 0.065;
    var rowGap = Math.min(boatWidth * 0.9, rect.height * 0.066);
    for (var index = 0; index < count; index += 1) {
      var row = Math.floor(index / columns);
      var x = rect.width * (0.075 + (index % columns) * 0.092);
      var y = rect.height * 0.11 + row * rowGap;
      drawBoat(context, x, y, boatWidth, 0, index % 3, false);
    }
  }
  function share() {
    if (state.phase !== 'RESULT' && state.phase !== 'SHARE_CARD') return;
    ui.sharing = true;
    text('share-number', ui.total);
    text('share-line', endingCopy[ui.total === 0 ? 'D' : ui.ending]);
    renderState();
    drawShareFleet();
    if (controls['close-share']) controls['close-share'].focus({ preventScroll: true });
  }
  function closeShare() {
    ui.sharing = false;
    renderState();
    if (controls.share) controls.share.focus({ preventScroll: true });
  }
  function startRun(changeMelody) {
    // All calls that unlock sound remain synchronous inside the original click gesture.
    if (changeMelody) {
      var seed = (state.seed + 1 + Math.floor(Math.random() * 2147480000)) % 2147483647;
      api.init({ seed: seed || 1 });
    }
    api.start();
  }
  app.addEventListener('click', function (event) {
    var button = event.target.closest('[data-action]');
    if (!button || button.disabled) return;
    var action = button.dataset.action;
    if (action === 'start' || action === 'restart') startRun(false);
    else if (action === 'new-melody') startRun(true);
    else if (action === 'abort') api.abort();
    else if (action === 'replay') {
      if (api.replayPhrase()) { ui.replayUsed = true; renderState(); }
    } else if (action === 'share') share();
    else if (action === 'close-share') closeShare();
    else if (action === 'dismiss-rotate') {
      ui.rotateDismissed = true;
      visible('rotate-hint', false);
    }
  });
  document.addEventListener('pointerdown', function (event) {
    if (!ui.fallback || state.subPhase !== 'RECORD') return;
    if (event.target.closest('[data-action="abort"]')) return;
    tapUntil = now() + 180;
    updateNotes(now());
    // The public backend already listens for taps. This is visual feedback only.
  }, { passive: true });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && ui.sharing) closeShare();
    if ((event.key === ' ' || event.key === 'Enter') && event.target === el['tap-target'] && ui.fallback && state.subPhase === 'RECORD' && !event.repeat) {
      event.preventDefault();
      el['tap-target'].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'keyboard' }));
    }
  });

  api.on('state:change', renderState);
  api.on('melody:phraseStart', phraseStart);
  api.on('melody:titleReveal', function (event) {
    text('revealed-title', '原来是《' + event.title + '》');
    visible('revealed-title', state.subPhase === 'PHRASE_RESULT');
  });
  api.on('attempt:countdown', function (event) {
    el.countdown.querySelectorAll('i').forEach(function (dot, index) {
      dot.classList.toggle('lit', index < 4 - event.from);
    });
  });
  api.on('attempt:start', attemptStart);
  api.on('attempt:pitch', onPitch);
  api.on('attempt:end', function (event) {
    timing.mode = '';
    pearl.style.opacity = '0';
    noteNodes.forEach(function (node) { node.classList.remove('current'); });
    if (event.reason === 'silence') setSilence();
  });
  api.on('ship:in', onShipIn);
  api.on('ship:wrecked', onShipWrecked);
  api.on('phrase:result', function (event) {
    ui.newShips = event.newWrecked;
    ui.total = event.totalWrecked;
    text('phrase-number', event.newWrecked);
    text('ship-number', event.totalWrecked);
    text('phrase-result-label', '这一句，吸引了');
    if (!event.newWrecked) el.siren.classList.add('is-submerged');
    announce('这一句吸引了 ' + event.newWrecked + ' 条船');
  });
  api.on('game:finale', function (event) {
    ui.total = event.wreckedTotal;
    ui.ending = event.ending;
    ui.silent = false;
    ui.hero = null;
    clearNotice();
    el.siren.classList.remove('is-submerged');
    text('result-number', ui.total);
    text('ending-line', endingCopy[ui.total === 0 ? 'D' : ui.ending]);
    renderState();
  });
  api.on('melody:replay', function (event) { installNotes(event.notes, 'finale'); });
  api.on('notice', onTechnical);
  api.on('error', onTechnical);

  window.addEventListener('resize', resize, { passive: true });
  if (window.ResizeObserver) new ResizeObserver(resize).observe(el.stage);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      window.cancelAnimationFrame(frameId);
      frameId = null;
      if (isPlaying() || state.phase === 'PERM_REQUEST' || state.phase === 'FINALE') api.abort();
      clearNotice();
    } else {
      resize();
      requestFrame();
    }
  });
  window.addEventListener('pagehide', function () {
    window.cancelAnimationFrame(frameId);
    frameId = null;
    if (isPlaying() || state.phase === 'PERM_REQUEST' || state.phase === 'FINALE') api.abort();
    clearNotice();
  });

  function loadImage(path) {
    return new Promise(function (resolve) {
      var image = new Image();
      image.onload = function () { resolve(image); };
      image.onerror = function () { resolve(null); };
      image.src = path;
    });
  }
  function compileSprites(atlas, mask) {
    if (!atlas || !mask) return;
    for (var index = 0; index < 3; index += 1) {
      var width = Math.ceil(atlas.naturalWidth / 3);
      var height = atlas.naturalHeight;
      var sprite = document.createElement('canvas');
      sprite.width = width; sprite.height = height;
      var context = sprite.getContext('2d', { willReadFrequently: true });
      context.drawImage(atlas, index * atlas.naturalWidth / 3, 0, atlas.naturalWidth / 3, height, 0, 0, width, height);
      var pixels = context.getImageData(0, 0, width, height);
      context.clearRect(0, 0, width, height);
      context.drawImage(mask, index * mask.naturalWidth / 3, 0, mask.naturalWidth / 3, mask.naturalHeight, 0, 0, width, height);
      var coverage = context.getImageData(0, 0, width, height).data;
      var left = width, top = height, right = 0, bottom = 0;
      for (var offset = 0; offset < coverage.length; offset += 4) {
        // The separately generated luminance mask is the alpha source, including all drawn edges.
        var alpha = Math.round(coverage[offset] * 0.2126 + coverage[offset + 1] * 0.7152 + coverage[offset + 2] * 0.0722);
        pixels.data[offset + 3] = Math.round(pixels.data[offset + 3] * alpha / 255);
        if (alpha > 24) {
          var x = (offset / 4) % width, y = Math.floor(offset / 4 / width);
          left = Math.min(left, x); right = Math.max(right, x);
          top = Math.min(top, y); bottom = Math.max(bottom, y);
        }
      }
      context.putImageData(pixels, 0, 0);
      if (right <= left || bottom <= top) continue;
      left = Math.max(0, left - 4); top = Math.max(0, top - 4);
      right = Math.min(width, right + 5); bottom = Math.min(height, bottom + 5);
      var trimmed = document.createElement('canvas');
      trimmed.width = right - left; trimmed.height = bottom - top;
      trimmed.getContext('2d').drawImage(sprite, left, top, trimmed.width, trimmed.height, 0, 0, trimmed.width, trimmed.height);
      sprites[index] = trimmed;
    }
  }

  renderState(state);
  resize();
  // Subscribe before init so the first synchronous HOME transition cannot be missed.
  api.init().then(function () { renderState(); });
  Promise.all([
    loadImage('./assets/boats/boats-atlas.webp'),
    loadImage('./assets/boats/boats-mask.webp'),
    loadImage('./assets/scenery/sea.webp'),
    loadImage('./assets/characters/siren-atlas.webp'),
    loadImage('./assets/characters/siren-mask.webp')
  ]).then(function (images) {
    try { compileSprites(images[0], images[1]); } catch (_) { sprites = []; }
    drawFleet(now());
    if (ui.sharing) drawShareFleet();
  });
})();
