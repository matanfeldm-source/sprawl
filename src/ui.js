/* Sprawl UI: Modern Board Rendering, Web Audio SFX, Confetti, Themes & Engine Integration */
(function(){
  var R = SprawlRules, E = SprawlEngine;
  var DIRS = R.DIRS, WIN = E.WIN, W = E.WEIGHTS;
  var k = R.k, parse = R.parse, other = R.other, fresh = R.fresh, clone = R.clone;
  var slots = R.slots, opens = R.opens, lineAt = R.lineAt, threatCells = R.threatCells;
  var search = E.search, growCands = E.growCands, turnMoves = E.turnMoves, evalPos = E.evalPos, scan = E.scan;
  var BOT_MODES = { easy: 1, medium: 1, hard: 1, master: 1, grandmaster: 1 };
  var DIFF_LABEL = { easy: 'Easy', medium: 'Medium', hard: 'Hard', master: 'Master', grandmaster: 'Grandmaster' };

  var worker = new Worker('src/worker.js');
  var reqId = 0, pendingReq = {}, reqSeq = 0;
  worker.onmessage = function(ev){
    var d = ev.data, cb = pendingReq[d.id];
    delete pendingReq[d.id];
    if (cb) cb(d.result);
  };
  function searchAsync(cells, turn, ms, maxd, w, cb){
    var id = ++reqId;
    pendingReq[id] = cb;
    worker.postMessage({ id: id, cells: E.copyCells(cells), turn: turn, ms: ms, depth: maxd, w: w });
  }

  /* Grandmaster runs a genuine parallel search: a pool of workers, each a
     fully independent copy of the engine (separate Worker = separate JS
     realm, no shared state of any kind), each searching only every Nth
     root move so it can push deeper before the shared time budget runs
     out. No cache is shared between them — this sidesteps the whole class
     of bug documented in README.md under "The transposition table bug"
     rather than risking a third attempt at it. */
  var poolSize = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 8));
  var pool = null;
  function ensurePool(){
    if (pool) return pool;
    pool = [];
    for (var i = 0; i < poolSize; i++) {
      var pw = new Worker('src/worker.js');
      var preq = {};
      pw.onmessage = (function(preq){ return function(ev){
        var d = ev.data, cb = preq[d.id];
        delete preq[d.id];
        if (cb) cb(d.result);
      }; })(preq);
      pool.push({ worker: pw, pending: preq, nextId: 0 });
    }
    return pool;
  }
  function searchParallel(cells, turn, ms, maxd, w, cb){
    var workers = ensurePool(), n = workers.length, results = new Array(n), remaining = n;
    for (var i = 0; i < n; i++) {
      (function(slot, idx){
        var id = ++slot.nextId;
        slot.pending[id] = function(r){
          results[idx] = r;
          remaining--;
          if (remaining === 0) combine();
        };
        slot.worker.postMessage({ id: id, cells: E.copyCells(cells), turn: turn, ms: ms, depth: maxd, w: w, part: idx, parts: n });
      })(workers[i], i);
    }
    function combine(){
      /* A proven forced win always wins, at any depth, over a non-winning
         result from a deeper search: the win is exact and absolute (the
         low depth just means it needed less searching to prove — that's
         a good sign, not a weak one), while a non-winning score at any
         depth is only ever a heuristic estimate. Comparing raw depth
         first, before checking for a win, previously caused Grandmaster
         to reject a real forced win found by one partition (2 plies) in
         favor of a losing partition's deeper-but-ordinary result (6
         plies) — found via a live game report, reproduced and fixed. */
      var winner = null, bestWin = null, totalNodes = 0;
      for (var i = 0; i < results.length; i++) {
        var r = results[i];
        if (!r) continue;
        totalNodes += r.nodes || 0;
        if (!r.best) continue;
        if (r.score >= WIN) { if (!bestWin || r.score > bestWin.score) bestWin = r; continue; }
        if (!winner || r.depth > winner.depth || (r.depth === winner.depth && r.score > winner.score)) winner = r;
      }
      winner = bestWin || winner;
      cb(winner ? Object.assign({}, winner, { nodes: totalNodes }) : { score: 0, best: null, depth: 0, nodes: totalNodes, pv: [], alts: [] });
    }
  }

  /* ---------- DOM Elements ---------- */
  var boardEl = document.getElementById('board');
  var whoText = document.getElementById('whoText');
  var dot = document.getElementById('dot');
  var hint = document.getElementById('hint');
  var countEl = document.getElementById('count');
  var undoBtn = document.getElementById('undo');
  var thBtn = document.getElementById('threats');
  var anaBtn = document.getElementById('analyse');
  var panel = document.getElementById('panel');
  var resetBtn = document.getElementById('reset');

  var playerCardX = document.getElementById('playerCardX');
  var playerCardO = document.getElementById('playerCardO');
  var nameX = document.getElementById('nameX');
  var nameO = document.getElementById('nameO');
  var roleX = document.getElementById('roleX');
  var roleO = document.getElementById('roleO');
  var scoreXEl = document.getElementById('scoreX');
  var scoreOEl = document.getElementById('scoreO');
  var step1 = document.getElementById('step1');
  var step2 = document.getElementById('step2');

  var soundToggle = document.getElementById('soundToggle');
  var soundIcon = document.getElementById('soundIcon');
  var themeToggle = document.getElementById('themeToggle');
  var themeIcon = document.getElementById('themeIcon');
  var rulesBtn = document.getElementById('rulesBtn');
  var rulesModal = document.getElementById('rulesModal');
  var closeRulesBtn = document.getElementById('closeRulesBtn');
  var victoryModal = document.getElementById('victoryModal');
  var victoryTitle = document.getElementById('victoryTitle');
  var victorySubtitle = document.getElementById('victorySubtitle');
  var playAgainBtn = document.getElementById('playAgainBtn');
  var closeVictoryBtn = document.getElementById('closeVictoryBtn');
  var appToast = document.getElementById('appToast');
  var confettiCanvas = document.getElementById('confettiCanvas');

  /* ---------- State ---------- */
  var S = fresh(), history = [], mode = 'human', oppType = 'human', botDiff = 'hard', humanColor = 'X';
  var showTh = false, justAdded = null, plan = null;
  var lastPlacedMark = null, lastGrownSquare = null;
  var lastMoveBadge = document.getElementById('lastMoveBadge');

  function updateLastMoveBadge(html){
    if (!lastMoveBadge) return;
    lastMoveBadge.innerHTML = html;
    lastMoveBadge.removeAttribute('hidden');
    lastMoveBadge.style.display = 'inline-flex';
  }
  function hideLastMoveBadge(){
    if (!lastMoveBadge) return;
    lastMoveBadge.setAttribute('hidden', '');
    lastMoveBadge.style.display = 'none';
  }

  var onlinePhase = 'idle', onlineConnected = false, myColor = null;
  var scores = { X: 0, O: 0 };
  var hasAwardedWin = false;

  function perspective(){
    if (BOT_MODES[mode]) return humanColor;
    if (mode === 'online' && myColor) return myColor;
    return 'X';
  }

  /* ---------- Web Audio Sound Synthesizer ---------- */
  var audioCtx = null;
  var soundEnabled = localStorage.getItem('sprawl_sound') !== 'false';

  function initAudio(){
    if (!audioCtx && (window.AudioContext || window.webkitAudioContext)) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
  }

  function playTone(freq, duration, type, startGain, endGain){
    if (!soundEnabled) return;
    try {
      initAudio();
      if (!audioCtx) return;
      if (audioCtx.state === 'suspended') audioCtx.resume();

      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, audioCtx.currentTime);

      gain.gain.setValueAtTime(startGain !== undefined ? startGain : 0.15, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(endGain !== undefined ? endGain : 0.001, audioCtx.currentTime + duration);

      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + duration);
    } catch(e) {}
  }

  function playPlaceSfx(){
    if (!soundEnabled) return;
    try {
      initAudio();
      if (!audioCtx) return;
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var now = audioCtx.currentTime;
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(360, now);
      osc.frequency.exponentialRampToValueAtTime(140, now + 0.12);
      gain.gain.setValueAtTime(0.25, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(now + 0.12);
    } catch(e) {}
  }

  function playGrowSfx(){
    if (!soundEnabled) return;
    try {
      initAudio();
      if (!audioCtx) return;
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var now = audioCtx.currentTime;
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(220, now);
      osc.frequency.exponentialRampToValueAtTime(440, now + 0.15);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(now + 0.15);
    } catch(e) {}
  }

  function playWinSfx(){
    if (!soundEnabled) return;
    var notes = [261.63, 329.63, 392.00, 523.25, 659.25]; // C E G C E
    notes.forEach(function(freq, i){
      setTimeout(function(){
        playTone(freq, 0.35, 'triangle', 0.22, 0.001);
      }, i * 80);
    });
  }

  function playBtnClick(){
    playTone(600, 0.04, 'sine', 0.08, 0.001);
  }

  function updateSoundUI(){
    if (soundIcon) soundIcon.textContent = soundEnabled ? '🔊' : '🔇';
    localStorage.setItem('sprawl_sound', soundEnabled ? 'true' : 'false');
  }
  updateSoundUI();
  if (soundToggle) {
    soundToggle.onclick = function(){
      soundEnabled = !soundEnabled;
      updateSoundUI();
      if (soundEnabled) playBtnClick();
    };
  }

  /* ---------- Theme Manager (Dark / Light) ---------- */
  var currentTheme = localStorage.getItem('sprawl_theme') || 'dark';
  function applyTheme(th){
    currentTheme = th;
    document.documentElement.setAttribute('data-theme', th);
    if (themeIcon) {
      themeIcon.textContent = th === 'dark' ? '☀️' : '🌙';
      if (themeToggle) {
        themeToggle.setAttribute('title', th === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode');
        themeToggle.setAttribute('aria-label', th === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode');
      }
    }
    localStorage.setItem('sprawl_theme', th);
  }
  applyTheme(currentTheme);
  if (themeToggle) {
    themeToggle.onclick = function(){
      playBtnClick();
      applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
    };
  }

  /* ---------- Rules Modal ---------- */
  if (rulesBtn) {
    rulesBtn.onclick = function(){
      playBtnClick();
      if (rulesModal) rulesModal.classList.add('open');
    };
  }
  if (closeRulesBtn) {
    closeRulesBtn.onclick = function(){
      playBtnClick();
      if (rulesModal) rulesModal.classList.remove('open');
    };
  }
  if (rulesModal) {
    rulesModal.onclick = function(e){
      if (e.target === rulesModal) rulesModal.classList.remove('open');
    };
  }

  /* ---------- Victory Modal ---------- */
  function showVictoryModal(winner){
    if (!victoryModal) return;
    var winnerName = winner === 'X' ? (nameX ? nameX.textContent : 'Player 1') : (nameO ? nameO.textContent : 'Player 2');
    if (victoryTitle) victoryTitle.textContent = winnerName + ' Wins!';
    if (victorySubtitle) victorySubtitle.textContent = 'Aligned three ' + winner + ' marks in a row to capture the match!';
    setTimeout(function(){
      victoryModal.classList.add('open');
    }, 450);
  }

  function hideVictoryModal(){
    if (victoryModal) victoryModal.classList.remove('open');
  }

  if (playAgainBtn) {
    playAgainBtn.onclick = function(){
      playBtnClick();
      hideVictoryModal();
      reset(false);
    };
  }

  if (closeVictoryBtn) {
    closeVictoryBtn.onclick = function(){
      playBtnClick();
      hideVictoryModal();
    };
  }

  if (victoryModal) {
    victoryModal.onclick = function(e){
      if (e.target === victoryModal) hideVictoryModal();
    };
  }

  /* ---------- Toast System ---------- */
  var toastTimer = null;
  function showToast(msg){
    if (!appToast) return;
    appToast.textContent = msg;
    appToast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){
      appToast.classList.remove('show');
    }, 2800);
  }

  /* ---------- Confetti Particle System ---------- */
  var confettiCtx = confettiCanvas ? confettiCanvas.getContext('2d') : null;
  var confettiParticles = [], confettiRunning = false;

  function resizeConfetti(){
    if (!confettiCanvas) return;
    confettiCanvas.width = window.innerWidth;
    confettiCanvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resizeConfetti);
  resizeConfetti();

  function triggerConfetti(){
    if (!confettiCanvas || !confettiCtx) return;
    confettiParticles = [];
    var colors = ['#38bdf8', '#fb7185', '#34d399', '#fbbf24', '#a855f7', '#6366f1'];
    var w = confettiCanvas.width, h = confettiCanvas.height;
    for (var i = 0; i < 90; i++) {
      confettiParticles.push({
        x: w * (0.2 + 0.6 * Math.random()),
        y: h * 0.4,
        vx: (Math.random() - 0.5) * 16,
        vy: -Math.random() * 14 - 4,
        size: Math.random() * 8 + 6,
        color: colors[Math.floor(Math.random() * colors.length)],
        rotation: Math.random() * 360,
        rSpeed: (Math.random() - 0.5) * 12,
        gravity: 0.45,
        alpha: 1
      });
    }
    if (!confettiRunning) {
      confettiRunning = true;
      requestAnimationFrame(updateConfetti);
    }
  }

  function updateConfetti(){
    if (!confettiCtx) return;
    confettiCtx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
    for (var i = 0; i < confettiParticles.length; i++) {
      var p = confettiParticles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += p.gravity;
      p.rotation += p.rSpeed;
      p.alpha -= 0.009;

      if (p.alpha > 0) {
        confettiCtx.save();
        confettiCtx.translate(p.x, p.y);
        confettiCtx.rotate((p.rotation * Math.PI) / 180);
        confettiCtx.globalAlpha = Math.max(0, p.alpha);
        confettiCtx.fillStyle = p.color;
        confettiCtx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        confettiCtx.restore();
      }
    }
    confettiParticles = confettiParticles.filter(function(p){ return p.alpha > 0; });
    if (confettiParticles.length > 0) {
      requestAnimationFrame(updateConfetti);
    } else {
      confettiRunning = false;
      confettiCtx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
    }
  }

  /* ---------- SVG Vector Marks Generator ---------- */
  function getMarkSvg(mark){
    if (mark === 'X') {
      return '<svg class="mark-svg mark-x" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<line x1="22" y1="22" x2="78" y2="78" stroke="currentColor" stroke-width="16" stroke-linecap="round"/>' +
        '<line x1="78" y1="22" x2="22" y2="78" stroke="currentColor" stroke-width="16" stroke-linecap="round"/>' +
        '</svg>';
    } else if (mark === 'O') {
      return '<svg class="mark-svg mark-o" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<circle cx="50" cy="50" r="32" stroke="currentColor" stroke-width="16" stroke-linecap="round"/>' +
        '</svg>';
    }
    return '';
  }

  /* ---------- Move Handling ---------- */
  function place(key, fromRemote){
    reqSeq++;
    history.push(clone(S));
    pending = { mover: S.turn, place: key };
    S.cells[key] = S.turn;
    playPlaceSfx();

    var w = lineAt(S.cells, key, S.turn);
    if (w) {
      S.line = w;
      S.over = true;
      if (!hasAwardedWin) {
        hasAwardedWin = true;
        scores[S.turn] = (scores[S.turn] || 0) + 1;
        playWinSfx();
        triggerConfetti();
        showVictoryModal(S.turn);
      }
    } else {
      S.phase = 'grow';
    }
    justAdded = null;
    needAna = true;

    lastPlacedMark = { key: key, turn: S.turn };
    lastGrownSquare = null;
    var moverLabel = (BOT_MODES[mode] && S.turn !== humanColor) ? 'Bot' : (mode === 'human' ? ('Player ' + (S.turn === 'X' ? '1' : '2')) : (S.turn === myColor ? 'You' : 'Opponent'));
    updateLastMoveBadge('Last move: <b>' + moverLabel + ' (' + S.turn + ')</b> marked ' + sq(key));

    if (mode === 'online' && onlineConnected && !fromRemote && window.SprawlOnline) {
      SprawlOnline.sendMove({ t: 'place', k: key });
    }
    draw();
    step();
  }

  function grow(key, fromRemote){
    reqSeq++;
    history.push(clone(S));
    S.cells[key] = null;
    S.phase = 'place';
    S.turn = other(S.turn);
    playGrowSfx();

    if (pending) {
      pending.grow = key;
      lastPlayed = pending;
      pending = null;
    }
    justAdded = key;
    lastGrownSquare = key;
    if (lastPlacedMark) {
      var growMover = (BOT_MODES[mode] && lastPlacedMark.turn !== humanColor) ? 'Bot' : (mode === 'human' ? ('Player ' + (lastPlacedMark.turn === 'X' ? '1' : '2')) : (lastPlacedMark.turn === myColor ? 'You' : 'Opponent'));
      updateLastMoveBadge('Last move: <b>' + growMover + ' (' + lastPlacedMark.turn + ')</b> marked ' + sq(lastPlacedMark.key) + ', grew ' + sq(key));
    }
    needAna = true;

    if (mode === 'online' && onlineConnected && !fromRemote && window.SprawlOnline) {
      SprawlOnline.sendMove({ t: 'grow', k: key });
    }
    draw();
    step();
  }

  function step(){
    if (!BOT_MODES[mode] || S.over || S.turn === humanColor) return;
    setTimeout(function(){
      if (!BOT_MODES[mode] || S.over || S.turn === humanColor) return;
      if (S.phase === 'place') {
        var seq = reqSeq, w = W[mode] || W.hard;
        var doSearch = w.parallel ? searchParallel : searchAsync;
        doSearch(S.cells, S.turn, w.ms, w.depth, w, function(r){
          if (seq !== reqSeq || !BOT_MODES[mode] || S.over || S.turn === humanColor || S.phase !== 'place') return;
          plan = r.best ? { place: r.best.p, grow: r.best.g } : { place: opens(S.cells)[0], grow: slots(S.cells)[0] };
          place(plan.place);
        });
      } else {
        var g = (plan && plan.grow && !(plan.grow in S.cells)) ? plan.grow : growCands(S.cells)[0];
        plan = null;
        grow(g);
      }
    }, 320);
  }

  /* ---------- Board Rendering & UI Sync ---------- */
  function draw(){
    var cand = S.over ? [] : slots(S.cells);
    var xs = [], ys = [], key, p;
    for (key in S.cells) { p = parse(key); xs.push(p[0]); ys.push(p[1]); }
    for (var i = 0; i < cand.length; i++) { p = parse(cand[i]); xs.push(p[0]); ys.push(p[1]); }

    var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    var cols = maxX - minX + 1, rows = maxY - minY + 1;

    var availWidth = Math.min((boardEl.parentElement.clientWidth || 320) - 20, 760);
    var availHeight = Math.max(380, Math.min(window.innerHeight * 0.46, 520));
    var size = Math.max(30, Math.min(88, Math.floor(Math.min((availWidth - 10 * cols) / cols, (availHeight - 10 * rows) / rows))));

    boardEl.style.gridTemplateColumns = 'repeat(' + cols + ',' + size + 'px)';
    boardEl.innerHTML = '';

    var tx = showTh ? threatCells(S.cells, 'X') : [];
    var to = showTh ? threatCells(S.cells, 'O') : [];
    var showSlots = !S.over && S.phase === 'grow';

    var human;
    if (mode === 'online') human = onlineConnected && S.turn === myColor;
    else if (BOT_MODES[mode]) human = S.turn === humanColor;
    else human = true;

    for (var y = minY; y <= maxY; y++) {
      for (var x = minX; x <= maxX; x++) {
        var kk = k(x, y), el;
        if (kk in S.cells) {
          var m = S.cells[kk];
          if (m === null && !S.over && S.phase === 'place' && human) {
            el = document.createElement('button');
            el.className = 'sq open';
            el.type = 'button';
            el.setAttribute('aria-label', 'Place ' + S.turn + ' at ' + x + ', ' + y);
            if (lastGrownSquare && lastGrownSquare === kk) el.classList.add('last-grown');
            el.onclick = (function(t){ return function(){ place(t); }; })(kk);
          } else {
            el = document.createElement('div');
            el.className = 'sq ' + (m ? 'taken' : 'open');
            if (m) {
              el.innerHTML = getMarkSvg(m);
              el.style.color = m === 'X' ? 'var(--x-color)' : 'var(--o-color)';
              if (S.line.indexOf(kk) > -1) el.classList.add('win');
              if (lastPlacedMark && lastPlacedMark.key === kk) el.classList.add('last-placed');
            } else if (lastGrownSquare && lastGrownSquare === kk) {
              el.classList.add('last-grown');
            }
          }

          if (m === null && showTh) {
            var t1 = tx.indexOf(kk) > -1, t2 = to.indexOf(kk) > -1;
            if (t1 || t2) {
              var pip = document.createElement('span');
              pip.className = 'pip';
              pip.style.background = t1 && t2 ? 'var(--accent-green)' : (t1 ? 'var(--x-color)' : 'var(--o-color)');
              el.appendChild(pip);
            }
          }

          if (kk === justAdded) el.classList.add('fresh');
          if (anaOn && hintMove && human && S.phase === 'place' && !S.over && kk === hintMove.p) {
            el.classList.add('hintsq');
          }
        } else if (showSlots && cand.indexOf(kk) > -1 && human) {
          el = document.createElement('button');
          el.className = 'sq slot';
          el.type = 'button';
          el.innerHTML = '<span class="slot-icon">+</span>';
          el.setAttribute('aria-label', 'Expand board at ' + x + ', ' + y);
          if (anaOn && hintMove && hintMove.g === kk) el.classList.add('hintgrow');
          el.onclick = (function(t){ return function(){ grow(t); }; })(kk);
        } else if (showSlots && cand.indexOf(kk) > -1) {
          el = document.createElement('div');
          el.className = 'sq slot';
          el.innerHTML = '<span class="slot-icon">+</span>';
        } else {
          el = document.createElement('div');
          el.className = 'sq void';
        }

        el.style.width = size + 'px';
        el.style.height = size + 'px';
        boardEl.appendChild(el);
      }
    }

    /* Update Status Banner */
    dot.style.background = S.turn === 'X' ? 'var(--x-color)' : 'var(--o-color)';
    dot.style.boxShadow = '0 0 10px ' + (S.turn === 'X' ? 'var(--x-glow)' : 'var(--o-glow)');

    var total = 0;
    for (key in S.cells) total++;
    countEl.textContent = total + ' squares';

    if (scoreXEl) scoreXEl.textContent = scores.X || 0;
    if (scoreOEl) scoreOEl.textContent = scores.O || 0;

    /* Update Player Cards & Turn Pulses */
    if (playerCardX && playerCardO) {
      if (S.over) {
        playerCardX.classList.toggle('active-turn', S.turn === 'X');
        playerCardO.classList.toggle('active-turn', S.turn === 'O');
      } else {
        playerCardX.classList.toggle('active-turn', S.turn === 'X');
        playerCardO.classList.toggle('active-turn', S.turn === 'O');
      }

      if (mode === 'human') {
        nameX.textContent = 'Player 1';
        nameO.textContent = 'Player 2';
        roleX.textContent = 'Local (X)';
        roleO.textContent = 'Local (O)';
      } else if (BOT_MODES[mode]) {
        nameX.textContent = humanColor === 'X' ? 'You' : 'Bot (' + DIFF_LABEL[mode] + ')';
        nameO.textContent = humanColor === 'O' ? 'You' : 'Bot (' + DIFF_LABEL[mode] + ')';
        roleX.textContent = humanColor === 'X' ? 'Human' : 'AI Engine';
        roleO.textContent = humanColor === 'O' ? 'Human' : 'AI Engine';
      } else if (mode === 'online') {
        nameX.textContent = myColor === 'X' ? 'You (Host)' : 'Opponent';
        nameO.textContent = myColor === 'O' ? 'You' : 'Opponent';
        roleX.textContent = onlineConnected ? 'Connected' : 'Waiting';
        roleO.textContent = onlineConnected ? 'Connected' : 'Waiting';
      }
    }

    /* Phase Stepper */
    if (step1 && step2) {
      if (S.over) {
        step1.classList.remove('active');
        step2.classList.remove('active');
      } else {
        step1.classList.toggle('active', S.phase === 'place');
        step2.classList.toggle('active', S.phase === 'grow');
      }
    }

    /* Status Messages */
    if (S.over) {
      whoText.textContent = S.turn + ' Wins the Match!';
      hint.textContent = 'Three in a row aligned! Click "New Game" to play again.';
    } else if (BOT_MODES[mode] && S.turn !== humanColor) {
      whoText.textContent = S.turn + ' is thinking…';
      hint.textContent = DIFF_LABEL[mode] + ' AI evaluating best line';
    } else if (mode === 'online' && !onlineConnected) {
      whoText.textContent = 'Not connected';
      hint.textContent = 'Find a match or share an invite link below.';
    } else if (mode === 'online' && S.turn !== myColor) {
      whoText.textContent = S.turn + ' to move';
      hint.textContent = 'Waiting for opponent’s move…';
    } else {
      whoText.textContent = S.turn + ' to move';
      hint.textContent = S.phase === 'place' ? 'Tap any open square to place your mark' : 'Now grow the board: tap an edge target (+)';
    }

    undoBtn.disabled = history.length === 0 || mode === 'online';

    if (anaOn && !S.over && S.phase === 'place' && needAna) {
      needAna = false;
      clearTimeout(anaTimer);
      anaTimer = setTimeout(runAnalysis, 30);
    }
  }

  /* ---------- Engine Analysis Logic ---------- */
  var anaOn = false, needAna = false, anaTimer = null, hintMove = null, prevEval = null, lastPlayed = null, pending = null, logRows = [];

  function sq(t){ return t ? '(' + t.replace(',', ', ') + ')' : '-'; }
  function scoreText(sPersp, persp){
    if (sPersp >= WIN) return persp + ' wins';
    if (sPersp <= -WIN) return other(persp) + ' wins';
    return (sPersp >= 0 ? '+' : '') + (sPersp / 100).toFixed(2);
  }

  function addLog(mover, mv, delta, mated){
    var cls = 'ok', tag = 'Good';
    if (mated) { cls = 'bad'; tag = 'Blunder'; }
    else if (delta >= 500) { cls = 'bad'; tag = 'Blunder'; }
    else if (delta >= 200) { cls = 'mid'; tag = 'Mistake'; }
    else if (delta >= 90) { cls = 'mid'; tag = 'Inaccuracy'; }
    else if (delta <= 15) { cls = 'ok'; tag = 'Best'; }
    logRows.unshift({ mover: mover, mv: mv, tag: tag, cls: cls, d: delta });
    if (logRows.length > 24) logRows.pop();
  }

  function runAnalysis(){
    if (!anaOn || S.over || S.phase !== 'place') return;
    var me = S.turn, seq = reqSeq, persp = perspective();
    var depthEl = document.getElementById('evaldepth');
    var perspEl = document.getElementById('evalpersp');
    if (depthEl) depthEl.textContent = 'thinking…';
    if (perspEl) perspEl.textContent = 'evaluating for ' + persp;

    searchAsync(S.cells, me, 1400, 6, W.master, function(r){
      if (seq !== reqSeq || !anaOn || S.over || S.phase !== 'place' || S.turn !== me) return;
      if (prevEval && lastPlayed && lastPlayed.mover === prevEval.mover && lastPlayed.seen !== true) {
        lastPlayed.seen = true;
        var mated = (prevEval.best < WIN && r.score >= WIN);
        var delta = prevEval.best + r.score;
        if (delta > 1e5) delta = 1e5;
        addLog(lastPlayed.mover, lastPlayed, delta, mated);
      }
      prevEval = { mover: me, best: r.score };
      hintMove = r.best;

      var sP = (me === persp) ? r.score : -r.score;
      var perspVar = persp === 'X' ? 'var(--x-color)' : 'var(--o-color)';
      var oppVar = persp === 'X' ? 'var(--o-color)' : 'var(--x-color)';

      var evalEl = document.getElementById('evalnum');
      if (evalEl) {
        evalEl.textContent = scoreText(sP, persp);
        evalEl.style.color = sP >= 0 ? perspVar : oppVar;
      }
      if (depthEl) depthEl.textContent = 'depth ' + r.depth;
      var nodesEl = document.getElementById('evalnodes');
      if (nodesEl) nodesEl.textContent = r.nodes.toLocaleString() + ' nodes';
      if (perspEl) perspEl.textContent = 'perspective: ' + persp;

      var pct = Math.abs(sP) >= WIN ? (sP > 0 ? 99 : 1) : Math.max(2, Math.min(98, 50 + 48 * Math.tanh(sP / 400)));
      var barfill = document.getElementById('barfill');
      if (barfill) {
        barfill.style.width = pct + '%';
        barfill.style.background = 'linear-gradient(90deg,' + perspVar + ', ' + oppVar + ')';
        barfill.parentElement.style.background = oppVar;
      }

      var lm = document.getElementById('barLabelMine'), lt = document.getElementById('barLabelTheirs');
      if (lm) { lm.textContent = persp; lm.style.color = perspVar; }
      if (lt) { lt.textContent = other(persp); lt.style.color = oppVar; }

      var bestlineEl = document.getElementById('bestline');
      if (bestlineEl) {
        bestlineEl.innerHTML = r.best ?
          ('Best for ' + me + ': place <b>' + sq(r.best.p) + '</b>' + (r.best.g ? (', grow <b>' + sq(r.best.g) + '</b>') : ' and win')) : '&nbsp;';
      }
      var pv = r.pv.map(function(m){ return m.t + ' ' + sq(m.p) + (m.g ? '+' + sq(m.g) : '#'); }).join('  ');
      var pvlineEl = document.getElementById('pvline');
      if (pvlineEl) pvlineEl.textContent = pv ? 'Engine Line: ' + pv : '';

      var altsEl = document.getElementById('alts');
      if (altsEl) {
        altsEl.innerHTML = '';
        for (var ai = 0; ai < (r.alts || []).length; ai++) {
          var A = r.alts[ai], aP = (me === persp) ? A.score : -A.score;
          var li = document.createElement('li');
          li.innerHTML = '<b>' + (ai + 1) + '.</b> place ' + sq(A.p) + (A.g ? ', grow ' + sq(A.g) : ' (win)') +
            ' <span class="altscore">' + scoreText(aP, persp) + '</span>';
          altsEl.appendChild(li);
        }
      }

      var ul = document.getElementById('log');
      if (ul) {
        ul.innerHTML = '';
        for (var i = 0; i < logRows.length; i++) {
          var L = logRows[i], li2 = document.createElement('li');
          li2.innerHTML = L.mover + ' ' + sq(L.mv.place) + '+' + sq(L.mv.grow) + ' — <span class="' + L.cls + '">' + L.tag + '</span>';
          ul.appendChild(li2);
        }
      }
      draw();
    });
  }

  /* ---------- Reset & Primary Controls ---------- */
  function reset(remote){
    reqSeq++;
    hasAwardedWin = false;
    hideVictoryModal();
    S = fresh();
    history = [];
    justAdded = null;
    lastPlacedMark = null;
    lastGrownSquare = null;
    hideLastMoveBadge();
    plan = null;
    prevEval = null;
    lastPlayed = null;
    pending = null;
    logRows = [];
    hintMove = null;
    needAna = true;

    if (mode === 'online' && onlineConnected && !remote && window.SprawlOnline) {
      SprawlOnline.sendMove({ t: 'reset' });
    }
    draw();
    step();
  }

  if (resetBtn) {
    resetBtn.onclick = function(){
      playBtnClick();
      reset(false);
    };
  }

  if (undoBtn) {
    undoBtn.onclick = function(){
      if (!history.length || mode === 'online') return;
      playBtnClick();
      reqSeq++;
      hasAwardedWin = false;
      S = history.pop();
      if (mode !== 'human') {
        while (history.length && !(S.turn === humanColor && S.phase === 'place' && !S.over)) {
          S = history.pop();
        }
      }
      justAdded = null;
      lastPlacedMark = null;
      lastGrownSquare = null;
      hideLastMoveBadge();
      plan = null;
      draw();
    };
  }

  if (anaBtn) {
    anaBtn.onclick = function(){
      playBtnClick();
      anaOn = !anaOn;
      anaBtn.setAttribute('aria-pressed', anaOn ? 'true' : 'false');
      panel.hidden = !anaOn;
      needAna = true;
      hintMove = null;
      draw();
    };
  }

  if (thBtn) {
    thBtn.onclick = function(){
      playBtnClick();
      showTh = !showTh;
      thBtn.setAttribute('aria-pressed', showTh ? 'true' : 'false');
      draw();
    };
  }

  /* ---------- Opponent Mode & Bot Selectors ---------- */
  var oppButtons = document.querySelectorAll('#oppGrp .seg');
  var diffRow = document.getElementById('diffRow');
  var diffButtons = document.querySelectorAll('#diffRow .seg[data-diff]');
  var colorButtons = document.querySelectorAll('#diffRow .seg[data-color]');
  var onlineRow = document.getElementById('onlineRow');
  var findBtn = document.getElementById('findMatch');
  var hostBtn = document.getElementById('hostLink');
  var cancelBtn = document.getElementById('cancelOnline');
  var onlineStatusEl = document.getElementById('onlineStatus');

  function setOnlineUI(){
    onlineRow.hidden = oppType !== 'online';
    if (oppType !== 'online') return;
    var busy = (onlinePhase === 'searching' || onlinePhase === 'waiting' || onlinePhase === 'connecting');
    findBtn.hidden = busy || onlinePhase === 'connected';
    hostBtn.hidden = busy || onlinePhase === 'connected';
    cancelBtn.hidden = !(busy || onlinePhase === 'connected');
    cancelBtn.textContent = onlinePhase === 'connected' ? 'Leave Online Room' : 'Cancel Search';
  }

  function setOpp(val){
    oppType = val;
    for (var j = 0; j < oppButtons.length; j++) {
      oppButtons[j].setAttribute('aria-pressed', oppButtons[j].getAttribute('data-opp') === val ? 'true' : 'false');
    }
    diffRow.hidden = oppType !== 'bot';
    if (oppType === 'online') {
      mode = 'online';
    } else {
      if (onlinePhase !== 'idle' && window.SprawlOnline) SprawlOnline.cancel();
      onlineConnected = false;
      myColor = null;
      onlinePhase = 'idle';
      mode = oppType === 'bot' ? botDiff : 'human';
    }
    setOnlineUI();
  }

  for (var oi = 0; oi < oppButtons.length; oi++) {
    oppButtons[oi].onclick = (function(b){
      return function(){
        playBtnClick();
        setOpp(b.getAttribute('data-opp'));
        reset(false);
      };
    })(oppButtons[oi]);
  }

  for (var di = 0; di < diffButtons.length; di++) {
    diffButtons[di].onclick = (function(b){
      return function(){
        playBtnClick();
        botDiff = b.getAttribute('data-diff');
        for (var j = 0; j < diffButtons.length; j++) {
          diffButtons[j].setAttribute('aria-pressed', diffButtons[j] === b ? 'true' : 'false');
        }
        if (oppType === 'bot') {
          mode = botDiff;
          reset(false);
        }
      };
    })(diffButtons[di]);
  }

  for (var ci = 0; ci < colorButtons.length; ci++) {
    colorButtons[ci].onclick = (function(b){
      return function(){
        playBtnClick();
        humanColor = b.getAttribute('data-color');
        for (var j = 0; j < colorButtons.length; j++) {
          colorButtons[j].setAttribute('aria-pressed', colorButtons[j] === b ? 'true' : 'false');
        }
        if (oppType === 'bot') reset(false);
      };
    })(colorButtons[ci]);
  }

  /* ---------- Online Play ---------- */
  function startOnlineGame(){ reset(true); }

  function handleOnlineStatus(st){
    onlinePhase = st.state;
    if (st.state === 'connected') {
      onlineConnected = true;
      myColor = st.you;
      onlineStatusEl.textContent = 'Connected! You are playing as ' + myColor + '.';
      showToast('Opponent connected! Game starting.');
      startOnlineGame();
    } else if (st.state === 'waiting') {
      onlineConnected = false;
      onlineStatusEl.innerHTML = 'Share this invite link with a friend: <b>' + st.link + '</b>';
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(st.link).then(function(){
          showToast('Invite link copied to clipboard!');
        }).catch(function(){});
      }
    } else if (st.state === 'connecting') {
      onlineStatusEl.textContent = 'Connecting to peer room…';
    } else if (st.state === 'searching') {
      onlineStatusEl.textContent = 'Searching public lobby for an opponent…';
    } else if (st.state === 'left') {
      onlineConnected = false;
      myColor = null;
      onlineStatusEl.textContent = 'Opponent disconnected.';
      showToast('Opponent left the match.');
    } else if (st.state === 'timeout') {
      onlineStatusEl.textContent = 'No opponent found in lobby. Try creating an invite link!';
    } else if (st.state === 'error') {
      onlineStatusEl.textContent = st.message || 'Connection error encountered.';
    } else if (st.state === 'idle') {
      onlineConnected = false;
      myColor = null;
      onlineStatusEl.textContent = '';
    }
    setOnlineUI();
    draw();
  }

  function handleOnlineMove(data){
    if (!data) return;
    if (data.t === 'reset') startOnlineGame();
    else if (data.t === 'place') place(data.k, true);
    else if (data.t === 'grow') grow(data.k, true);
  }

  if (window.SprawlOnline) {
    SprawlOnline.onStatus(handleOnlineStatus);
    SprawlOnline.onMove(handleOnlineMove);
  }

  if (findBtn) {
    findBtn.onclick = function(){
      playBtnClick();
      if (window.SprawlOnline) SprawlOnline.findMatch();
    };
  }
  if (hostBtn) {
    hostBtn.onclick = function(){
      playBtnClick();
      if (window.SprawlOnline) SprawlOnline.hostLink();
    };
  }
  if (cancelBtn) {
    cancelBtn.onclick = function(){
      playBtnClick();
      if (window.SprawlOnline) SprawlOnline.cancel();
    };
  }

  var roomParam = new URLSearchParams(location.search).get('room');
  if (roomParam) {
    setOpp('online');
    window.history.replaceState(null, '', location.pathname);
    onlineStatusEl.textContent = 'Connecting to shared invite room…';
    if (window.SprawlOnline) SprawlOnline.joinLink(roomParam);
  }

  window.addEventListener('resize', function(){ draw(); });

  /* Engine Global Hook for testing & console access */
  global_hook();
  function global_hook(){
    if (typeof globalThis !== 'undefined') {
      globalThis.__engine = {
        S: function(){ return S; },
        search: search,
        W: W,
        turnMoves: turnMoves,
        evalPos: evalPos,
        growCands: growCands,
        setMode: function(m){ mode = m; },
        place: place,
        grow: grow,
        threats: threatCells,
        scan: scan,
        setDepth: function(d, ms, tier){
          var t = W[tier || 'hard'];
          if (t) { t.depth = d; t.ms = ms; }
        }
      };
    }
  }

  reset(false);
})();
