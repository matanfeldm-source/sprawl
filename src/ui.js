/* Sprawl UI: Modern Board Rendering, Web Audio SFX, Confetti, Themes & Engine Integration */
(function(){
  var R = SprawlRules, E = SprawlEngine;
  var DIRS = R.DIRS, WIN = E.WIN, W = E.WEIGHTS;
  var k = R.k, parse = R.parse, other = R.other, fresh = R.fresh, clone = R.clone;
  var slots = R.slots, opens = R.opens, lineAt = R.lineAt, threatCells = R.threatCells;
  var legalPlacement = R.legalPlacement, legalGrowth = R.legalGrowth;
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
  function searchAsync(cells, turn, ms, maxd, w, cb, mem){
    var id = ++reqId;
    pendingReq[id] = cb;
    worker.postMessage({ id: id, cells: E.copyCells(cells), turn: turn, ms: ms, depth: maxd, w: w, mem: mem });
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
  function searchParallel(cells, turn, ms, maxd, w, cb, mem){
    var workers = ensurePool(), n = workers.length, results = new Array(n), remaining = n;
    for (var i = 0; i < n; i++) {
      (function(slot, idx){
        var id = ++slot.nextId;
        slot.pending[id] = function(r){
          results[idx] = r;
          remaining--;
          if (remaining === 0) combine();
        };
        slot.worker.postMessage({ id: id, cells: E.copyCells(cells), turn: turn, ms: ms, depth: maxd, w: w, part: idx, parts: n, mem: mem });
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
  var ratingBadge = document.getElementById('ratingBadge');
  var historyBtn = document.getElementById('historyBtn');
  var historyModal = document.getElementById('historyModal');
  var closeHistoryBtn = document.getElementById('closeHistoryBtn');
  var historyList = document.getElementById('historyList');
  var clearHistoryBtn = document.getElementById('clearHistoryBtn');
  var primaryToolbar = document.getElementById('primaryToolbar');
  var reviewRow = document.getElementById('reviewRow');
  var reviewStartBtn = document.getElementById('reviewStart');
  var reviewPrevBtn = document.getElementById('reviewPrev');
  var reviewNextBtn = document.getElementById('reviewNext');
  var reviewEndBtn = document.getElementById('reviewEnd');
  var reviewExitBtn = document.getElementById('reviewExit');
  var reviewStepLabel = document.getElementById('reviewStepLabel');
  var reviewMoveList = document.getElementById('reviewMoveList');
  var reviewAccXVal = document.getElementById('reviewAccXVal');
  var reviewAccOVal = document.getElementById('reviewAccOVal');
  var reviewAccXLabel = document.getElementById('reviewAccXLabel');
  var reviewAccOLabel = document.getElementById('reviewAccOLabel');
  var reviewTagCounts = document.getElementById('reviewTagCounts');
  var reviewGraph = document.getElementById('reviewGraph');
  var reviewPlayBtn = document.getElementById('reviewPlay');
  var reviewTagBadge = document.getElementById('reviewTagBadge');
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
    if (reviewing && reviewGame) return reviewGame.myColor;
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

  /* ---------- Rating, History & Engine Self-Learning (this device only) ----------
     Everything here lives in localStorage, never leaves the browser, and only
     covers bot and online games — a local hotseat game has no distinct "you"
     vs. opponent, so there's nothing meaningful to rate or record for it. */
  var RATING_DEFAULT = 1200, RATING_K = 32;
  var BOT_ANCHOR = { easy: 700, medium: 950, hard: 1250, master: 1650, grandmaster: 2000 };
  var rating = parseFloat(localStorage.getItem('sprawl_rating')) || RATING_DEFAULT;
  var botMoveLog = [];
  /* Every completed turn ({turn,place,grow}) of the current game, in
     order — pushed alongside recordGameResult()'s other bookkeeping so a
     finished bot/online game can be replayed later (see Part 2/3 review
     mode). Same shape as test/harness.js's playGame().log. */
  var moveLog = [];

  /* ---------- Game Review (replay a saved game with analysis) ----------
     Reuses the live board renderer (draw()) and Analysis panel
     (runAnalysis()) against a reconstructed position instead of building
     either a second time — see the "reviewing" checks threaded through
     draw()/step()/perspective()/runAnalysis() above. */
  var reviewing = false, reviewGame = null, reviewStep = 0;
  var reviewEvalCache = {}, reviewEvalSeq = 0;

  function loadJSON(key, fallback){
    try {
      var v = JSON.parse(localStorage.getItem(key));
      return v && typeof v === 'object' ? v : fallback;
    } catch (e) { return fallback; }
  }
  function saveJSON(key, val){
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }

  function updateRatingBadge(){
    if (ratingBadge) ratingBadge.textContent = '🏆 ' + Math.round(rating);
    var el = document.getElementById('historyStatsRating');
    if (el) el.textContent = Math.round(rating);
  }
  updateRatingBadge();

  /* Position+move -> {w,l,t} outcome table, read by the engine (via the
     worker) to weight its final move pick among already-equally-good
     candidates — see the `mem` handling in src/engine.js's search(). The
     engine has no localStorage access itself (it runs in a Worker), so
     ui.js owns this table and passes the relevant slice into every bot
     search call. Capped at the 500 most recently-touched entries: on this
     infinite/growing board almost all reused positions are from the first
     few plies of a game anyway, so a small cap is plenty. */
  function loadEngineMemory(){ return loadJSON('sprawl_engine_memory', {}); }
  function updateEngineMemory(botWon){
    if (!botMoveLog.length) return;
    var mem = loadEngineMemory();
    for (var i = 0; i < botMoveLog.length; i++) {
      var mk = botMoveLog[i].hash + '_' + botMoveLog[i].p + '_' + (botMoveLog[i].g || 'x');
      var rec = mem[mk] || { w: 0, l: 0, t: 0 };
      if (botWon) rec.w++; else rec.l++;
      rec.t = Date.now();
      mem[mk] = rec;
    }
    var keys = Object.keys(mem);
    if (keys.length > 500) {
      keys.sort(function(a, b){ return mem[a].t - mem[b].t; });
      for (var j = 0; j < keys.length - 500; j++) delete mem[keys[j]];
    }
    saveJSON('sprawl_engine_memory', mem);
  }

  function renderHistory(){
    if (!historyList) return;
    var list = loadJSON('sprawl_history', []);
    historyList.innerHTML = '';
    for (var i = 0; i < list.length; i++) {
      var g = list[i];
      var canReview = !!(g.moves && g.moves.length);
      var li = document.createElement('li');
      li.className = 'history-item ' + (g.result === 'win' ? 'win' : 'loss') + (canReview ? ' reviewable' : '');
      var d = new Date(g.ts);
      li.innerHTML =
        '<span class="history-result">' + (g.result === 'win' ? 'WIN' : 'LOSS') + '</span>' +
        '<span class="history-opp">' + g.oppLabel + '</span>' +
        '<span class="history-date">' + d.toLocaleDateString() + '</span>' +
        '<span class="history-delta">' + (g.ratingDelta >= 0 ? '+' : '') + Math.round(g.ratingDelta) + '</span>';
      if (canReview) {
        li.title = 'Click to review this game';
        li.onclick = (function(game){ return function(){ enterReview(game); }; })(g);
      }
      historyList.appendChild(li);
    }
  }

  /* The only place a finished bot/online game's outcome gets turned into a
     rating change, a history entry, and (bot games only) an engine-memory
     update — called once per game from the two win-detection sites in
     place() and botPlayTurn(). */
  function recordGameResult(winnerColor){
    var isBotGame = !!BOT_MODES[mode];
    var isOnlineGame = mode === 'online';
    if (!isBotGame && !isOnlineGame) { botMoveLog = []; moveLog = []; return; }

    var myPerspectiveColor = isBotGame ? humanColor : myColor;
    var myWin = winnerColor === myPerspectiveColor;
    /* Bots get a fixed anchor rating standing in for their strength. An
       online opponent's real rating can never be known on a backend-free,
       login-free site, so it's approximated as an even match against the
       player's own current rating — an explicit, documented shortcut, not
       a claim of a real ranked ladder. */
    var oppRating = isBotGame ? (BOT_ANCHOR[mode] || RATING_DEFAULT) : rating;
    var oppLabel = isBotGame ? (DIFF_LABEL[mode] || mode) : 'Online';

    var expected = 1 / (1 + Math.pow(10, (oppRating - rating) / 400));
    var delta = RATING_K * ((myWin ? 1 : 0) - expected);
    rating += delta;
    localStorage.setItem('sprawl_rating', String(rating));
    updateRatingBadge();

    var hist = loadJSON('sprawl_history', []);
    hist.unshift({ ts: Date.now(), mode: isBotGame ? 'bot' : 'online', oppLabel: oppLabel,
      result: myWin ? 'win' : 'loss', myColor: myPerspectiveColor, ratingDelta: delta, ratingAfter: rating,
      moves: moveLog.slice() });
    if (hist.length > 200) hist.length = 200;
    saveJSON('sprawl_history', hist);

    if (isBotGame) updateEngineMemory(!myWin);
    botMoveLog = [];
  }

  if (historyBtn) {
    historyBtn.onclick = function(){
      playBtnClick();
      renderHistory();
      if (historyModal) historyModal.classList.add('open');
    };
  }
  if (closeHistoryBtn) {
    closeHistoryBtn.onclick = function(){
      playBtnClick();
      if (historyModal) historyModal.classList.remove('open');
    };
  }
  if (historyModal) {
    historyModal.onclick = function(e){
      if (e.target === historyModal) historyModal.classList.remove('open');
    };
  }
  if (clearHistoryBtn) {
    var clearArmed = false, clearArmTimer = null;
    var clearHistoryLabel = clearHistoryBtn.textContent;
    clearHistoryBtn.onclick = function(){
      playBtnClick();
      if (!clearArmed) {
        clearArmed = true;
        clearHistoryBtn.textContent = 'Click again to confirm';
        clearHistoryBtn.classList.add('danger');
        clearArmTimer = setTimeout(function(){
          clearArmed = false;
          clearHistoryBtn.textContent = clearHistoryLabel;
          clearHistoryBtn.classList.remove('danger');
        }, 3000);
        return;
      }
      clearTimeout(clearArmTimer);
      clearArmed = false;
      clearHistoryBtn.textContent = clearHistoryLabel;
      clearHistoryBtn.classList.remove('danger');
      localStorage.removeItem('sprawl_history');
      localStorage.removeItem('sprawl_engine_memory');
      localStorage.removeItem('sprawl_rating');
      rating = RATING_DEFAULT;
      updateRatingBadge();
      renderHistory();
      showToast('Local history, rating, and engine memory cleared.');
    };
  }

  /* ---------- Game Review ----------
     Reconstructs S from a saved move sequence (never through place()/
     grow(), which have live-only side effects: sound, confetti, network
     send, undo-stack push) and reuses the live board renderer and
     Analysis panel against it — see the `reviewing` checks threaded
     through draw()/step()/perspective()/runAnalysis() above. */
  function reviewCellsAt(step){
    var cells = fresh().cells;
    for (var i = 0; i < step; i++) {
      var mv = reviewGame.moves[i];
      cells[mv.place] = mv.turn;
      if (mv.grow) cells[mv.grow] = null;
    }
    return cells;
  }

  function renderReviewStep(){
    reqSeq++; // invalidate any in-flight live-analysis search from a previous step
    var moves = reviewGame.moves;
    S = fresh();
    S.cells = reviewCellsAt(reviewStep);
    if (reviewStep < moves.length) {
      S.turn = moves[reviewStep].turn;
      S.over = false;
      S.line = [];
    } else {
      var last = moves[moves.length - 1];
      S.turn = last.turn;
      S.line = lineAt(S.cells, last.place, last.turn) || [];
      S.over = true;
    }
    S.phase = 'place';
    justAdded = null;
    lastPlacedMark = reviewStep > 0 ? { key: moves[reviewStep - 1].place, turn: moves[reviewStep - 1].turn } : null;
    lastGrownSquare = reviewStep > 0 ? moves[reviewStep - 1].grow : null;
    hintMove = null;

    if (reviewStepLabel) reviewStepLabel.textContent = reviewStep + ' / ' + moves.length;
    if (reviewStartBtn) reviewStartBtn.disabled = reviewStep === 0;
    if (reviewPrevBtn) reviewPrevBtn.disabled = reviewStep === 0;
    if (reviewNextBtn) reviewNextBtn.disabled = reviewStep === moves.length;
    if (reviewEndBtn) reviewEndBtn.disabled = reviewStep === moves.length;

    renderReviewTagBadge();

    needAna = true;
    draw();
    renderReviewMoveList();
    renderReviewSummary();
    renderReviewGraph();
  }

  /* Win-probability curve (chess.com's published centipawn->win% formula,
     reused as-is against this engine's score scale — the existing
     Blunder/Mistake/Inaccuracy thresholds below were already tuned to
     roughly chess-like centipawn deltas, so no rescaling is needed).
     Saturates cleanly even at WINV-sized (1e6) forced-win scores. */
  function winPct(score){
    var v = Math.max(-1e6, Math.min(1e6, score));
    return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * v)) - 1);
  }
  /* Per-move accuracy: how much the mover's own win% dropped by playing
     this move instead of the engine's best. `afterOppScore` is the
     opponent's search score at the resulting position (their own
     perspective), so it's negated to read as the mover's perspective. */
  function moveAccuracy(beforeScore, afterOppScore){
    var before = winPct(beforeScore), after = winPct(-afterOppScore);
    var drop = before - after;
    if (drop <= 0) return 100;
    var acc = 103.1668 * Math.exp(-0.04354 * drop) - 3.1669;
    return Math.max(0, Math.min(100, acc));
  }

  /* Move i's quality tag needs both the position before it and the
     position after it evaluated (from each side's own perspective) —
     exactly the same delta/threshold logic addLog() already uses for
     live play, reused here rather than reinvented. The move that ends
     the game is always the winning move by definition, so it's tagged
     directly without needing a search. Beyond the original four tiers,
     this also flags: Miss (had a large edge and threw it away), and
     Great Move/Brilliant (the engine's clear top pick by a wide margin
     over its next-best alternative — using the top-3 `alts` search
     already returns, not a second search). */
  function reviewMoveTag(i){
    var moves = reviewGame.moves;
    if (i === moves.length - 1) return { tag: 'Win', cls: 'tag-best', acc: 100 };
    var beforeR = reviewEvalCache[i], afterR = reviewEvalCache[i + 1];
    if (!beforeR || !afterR) return null;
    var delta = beforeR.score + afterR.score;
    if (delta > 1e5) delta = 1e5;
    var acc = moveAccuracy(beforeR.score, afterR.score);
    var hadBigEdge = beforeR.score >= 400;

    if (hadBigEdge && delta >= 200) return { tag: 'Miss', cls: 'tag-blunder', acc: acc };
    if (delta >= 500) return { tag: 'Blunder', cls: 'tag-blunder', acc: acc };
    if (delta >= 200) return { tag: 'Mistake', cls: 'tag-mistake', acc: acc };
    if (delta >= 90) return { tag: 'Inaccuracy', cls: 'tag-inaccuracy', acc: acc };

    var alts = beforeR.alts || [];
    var isTop = alts.length && alts[0].p === moves[i].place;
    var gap = alts.length > 1 ? alts[0].score - alts[1].score : 0;
    if (isTop && gap >= 300 && Math.abs(beforeR.score) < 300) {
      return { tag: 'Brilliant', cls: 'tag-brilliant', acc: acc };
    }
    if (isTop && gap >= 150) return { tag: 'Great Move', cls: 'tag-great', acc: acc };
    if (delta <= 15) return { tag: 'Best', cls: 'tag-best', acc: acc };
    if (delta <= 40) return { tag: 'Excellent', cls: 'tag-excellent', acc: acc };
    return { tag: 'Good', cls: '', acc: acc };
  }

  function renderReviewTagBadge(){
    if (!reviewTagBadge || !reviewGame) return;
    var curTag = reviewStep > 0 ? reviewMoveTag(reviewStep - 1) : null;
    if (curTag) {
      reviewTagBadge.className = 'quality-badge ' + curTag.cls;
      reviewTagBadge.innerHTML = '<span>' + curTag.tag + '</span>';
      reviewTagBadge.removeAttribute('hidden');
    } else {
      reviewTagBadge.setAttribute('hidden', '');
    }
  }

  function renderReviewMoveList(){
    if (!reviewMoveList || !reviewGame) return;
    reviewMoveList.innerHTML = '';
    var moves = reviewGame.moves;
    for (var i = 0; i < moves.length; i++) {
      var mv = moves[i], t = reviewMoveTag(i);
      var li = document.createElement('li');
      li.className = 'review-move-item' + (i + 1 === reviewStep ? ' current' : '') + (t ? ' ' + t.cls : '');
      li.textContent = (i + 1) + '. ' + mv.turn + ' ' + sq(mv.place) + ' — ' + (t ? t.tag : '…');
      li.onclick = (function(step){ return function(){ reviewStep = step; stopReviewPlay(); renderReviewStep(); }; })(i + 1);
      reviewMoveList.appendChild(li);
    }
  }

  var TAG_ORDER = ['Brilliant', 'Great Move', 'Best', 'Excellent', 'Good', 'Inaccuracy', 'Mistake', 'Miss', 'Blunder'];
  var TAG_SLUG = { 'Brilliant': 'brilliant', 'Great Move': 'great', 'Best': 'best', 'Excellent': 'excellent',
    'Good': 'good', 'Inaccuracy': 'inaccuracy', 'Mistake': 'mistake', 'Miss': 'miss', 'Blunder': 'blunder' };

  /* "You" for the reviewer's own color, the actual opponent name otherwise
     — reused from the same {mode, oppLabel, myColor} shape recordGameResult()
     already saves into history, rather than showing bare X/O letters. */
  function reviewSideLabel(color){
    if (!reviewGame) return color;
    if (reviewGame.myColor === color) return 'You';
    return reviewGame.mode === 'bot' ? (reviewGame.oppLabel || 'Bot') : 'Opponent';
  }

  function renderReviewSummary(){
    if (!reviewGame) return;
    var moves = reviewGame.moves;
    var accSum = { X: 0, O: 0 }, accN = { X: 0, O: 0 };
    var tagN = { X: {}, O: {} };
    for (var i = 0; i < moves.length; i++) {
      var t = reviewMoveTag(i);
      if (!t) continue;
      var side = moves[i].turn;
      accSum[side] += t.acc;
      accN[side]++;
      tagN[side][t.tag] = (tagN[side][t.tag] || 0) + 1;
    }
    if (reviewAccXLabel) reviewAccXLabel.textContent = reviewSideLabel('X');
    if (reviewAccOLabel) reviewAccOLabel.textContent = reviewSideLabel('O');
    if (reviewAccXVal) reviewAccXVal.textContent = accN.X ? (accSum.X / accN.X).toFixed(1) + '%' : '–';
    if (reviewAccOVal) reviewAccOVal.textContent = accN.O ? (accSum.O / accN.O).toFixed(1) + '%' : '–';

    if (reviewTagCounts) {
      reviewTagCounts.innerHTML = '';
      for (var j = 0; j < TAG_ORDER.length; j++) {
        var tag = TAG_ORDER[j];
        var cx = tagN.X[tag] || 0, co = tagN.O[tag] || 0;
        if (!cx && !co) continue;
        var li = document.createElement('li');
        li.className = 'tc-' + TAG_SLUG[tag];
        li.textContent = tag + ': ';
        var span = document.createElement('span');
        span.className = 'n';
        span.textContent = 'X ' + cx + ' · O ' + co;
        li.appendChild(span);
        reviewTagCounts.appendChild(li);
      }
    }
  }

  /* A small win%-over-time chart, always drawn from X's perspective (O's
     scores are negated) so the fill sits consistently above/below the
     50% midline. Each vertex is a real SVG element so clicks map straight
     to a review step without separate hit-testing math. */
  function renderReviewGraph(){
    if (!reviewGraph || !reviewGame) return;
    var moves = reviewGame.moves, n = moves.length;
    var pts = [];
    for (var i = 0; i <= n; i++) {
      var r = reviewEvalCache[i];
      var pct;
      if (i < n && r) {
        pct = moves[i].turn === 'X' ? winPct(r.score) : 100 - winPct(r.score);
      } else if (i === n) {
        var lastTurn = moves[n - 1].turn;
        pct = lastTurn === 'X' ? 100 : 0;
      } else {
        pct = null;
      }
      pts.push(pct);
    }
    reviewGraph.innerHTML = '';
    var NS = 'http://www.w3.org/2000/svg';
    var W_ = 100, H_ = 36;
    function xAt(i){ return n ? (i / n) * W_ : 0; }
    function yAt(pct){ return H_ - (pct / 100) * H_; }

    var mid = document.createElementNS(NS, 'line');
    mid.setAttribute('class', 'rg-mid');
    mid.setAttribute('x1', 0); mid.setAttribute('x2', W_);
    mid.setAttribute('y1', H_ / 2); mid.setAttribute('y2', H_ / 2);
    reviewGraph.appendChild(mid);

    var known = [];
    for (var k = 0; k < pts.length; k++) if (pts[k] != null) known.push(k);
    if (known.length > 1) {
      var linePts = known.map(function(k2){ return xAt(k2) + ',' + yAt(pts[k2]); }).join(' ');
      var fillTop = known.map(function(k2){ return xAt(k2) + ',' + yAt(Math.max(50, pts[k2])); }).join(' ');
      var fillBot = known.slice().reverse().map(function(k2){ return xAt(k2) + ',' + Math.min(H_, yAt(50)); }).join(' ');
      var polyX = document.createElementNS(NS, 'polygon');
      polyX.setAttribute('class', 'rg-fill-x');
      polyX.setAttribute('points', fillTop + ' ' + fillBot);
      reviewGraph.appendChild(polyX);

      var fillTopO = known.map(function(k2){ return xAt(k2) + ',' + yAt(50); }).join(' ');
      var fillBotO = known.slice().reverse().map(function(k2){ return xAt(k2) + ',' + yAt(Math.min(50, pts[k2])); }).join(' ');
      var polyO = document.createElementNS(NS, 'polygon');
      polyO.setAttribute('class', 'rg-fill-o');
      polyO.setAttribute('points', fillTopO + ' ' + fillBotO);
      reviewGraph.appendChild(polyO);

      var line = document.createElementNS(NS, 'polyline');
      line.setAttribute('class', 'rg-line');
      line.setAttribute('points', linePts);
      reviewGraph.appendChild(line);
    }

    if (reviewStep >= 0 && reviewStep <= n) {
      var cursor = document.createElementNS(NS, 'line');
      cursor.setAttribute('class', 'rg-cursor');
      cursor.setAttribute('x1', xAt(reviewStep)); cursor.setAttribute('x2', xAt(reviewStep));
      cursor.setAttribute('y1', 0); cursor.setAttribute('y2', H_);
      reviewGraph.appendChild(cursor);
    }

    for (var h = 0; h <= n; h++) {
      var hit = document.createElementNS(NS, 'rect');
      hit.setAttribute('class', 'rg-hit');
      var slotW = n ? W_ / n : W_;
      hit.setAttribute('x', xAt(h) - slotW / 2);
      hit.setAttribute('y', 0);
      hit.setAttribute('width', slotW);
      hit.setAttribute('height', H_);
      hit.onclick = (function(step){ return function(){ reviewStep = step; stopReviewPlay(); renderReviewStep(); }; })(h);
      reviewGraph.appendChild(hit);
    }
  }

  function prefetchReviewEvals(){
    var seq = reviewEvalSeq, moves = reviewGame.moves, i = 0;
    function next(){
      if (seq !== reviewEvalSeq || i >= moves.length) return;
      searchAsync(reviewCellsAt(i), moves[i].turn, 1400, 6, W.master, function(r){
        if (seq !== reviewEvalSeq) return;
        reviewEvalCache[i] = r;
        renderReviewMoveList();
        renderReviewSummary();
        renderReviewGraph();
        renderReviewTagBadge();
        i++;
        next();
      });
    }
    next();
  }

  function enterReview(game){
    if (!game || !game.moves || !game.moves.length) return;
    if (mode === 'online' && onlineConnected) {
      showToast('Finish or leave your current online game before reviewing past games.');
      return;
    }
    if (historyModal) historyModal.classList.remove('open');
    hideVictoryModal();
    reviewing = true;
    reviewGame = game;
    reviewStep = game.moves.length;
    reviewEvalCache = {};
    reviewEvalSeq++;

    if (primaryToolbar) primaryToolbar.hidden = true;
    if (diffRow) diffRow.hidden = true;
    if (onlineRow) onlineRow.hidden = true;
    if (reviewRow) reviewRow.hidden = false;
    anaOn = true;
    if (anaBtn) anaBtn.setAttribute('aria-pressed', 'true');
    if (panel) panel.hidden = false;

    renderReviewStep();
    prefetchReviewEvals();
  }

  function exitReview(){
    stopReviewPlay();
    reviewing = false;
    reviewGame = null;
    reviewEvalSeq++;
    reviewEvalCache = {};
    if (reviewRow) reviewRow.hidden = true;
    if (primaryToolbar) primaryToolbar.hidden = false;
    if (diffRow) diffRow.hidden = oppType !== 'bot';
    if (onlineRow) onlineRow.hidden = oppType !== 'online';
    reset(false);
  }

  var reviewPlayTimer = null;
  function stopReviewPlay(){
    if (reviewPlayTimer) { clearInterval(reviewPlayTimer); reviewPlayTimer = null; }
    if (reviewPlayBtn) reviewPlayBtn.textContent = '▶';
  }
  function toggleReviewPlay(){
    if (reviewPlayTimer) { stopReviewPlay(); return; }
    if (!reviewGame || reviewStep >= reviewGame.moves.length) reviewStep = 0;
    if (reviewPlayBtn) reviewPlayBtn.textContent = '⏸';
    reviewPlayTimer = setInterval(function(){
      if (!reviewGame || reviewStep >= reviewGame.moves.length) { stopReviewPlay(); return; }
      reviewStep++;
      renderReviewStep();
    }, 900);
  }

  if (reviewStartBtn) reviewStartBtn.onclick = function(){ playBtnClick(); stopReviewPlay(); reviewStep = 0; renderReviewStep(); };
  if (reviewPrevBtn) reviewPrevBtn.onclick = function(){ playBtnClick(); stopReviewPlay(); if (reviewStep > 0) { reviewStep--; renderReviewStep(); } };
  if (reviewNextBtn) reviewNextBtn.onclick = function(){ playBtnClick(); stopReviewPlay(); if (reviewGame && reviewStep < reviewGame.moves.length) { reviewStep++; renderReviewStep(); } };
  if (reviewEndBtn) reviewEndBtn.onclick = function(){ playBtnClick(); stopReviewPlay(); if (reviewGame) { reviewStep = reviewGame.moves.length; renderReviewStep(); } };
  if (reviewPlayBtn) reviewPlayBtn.onclick = function(){ playBtnClick(); toggleReviewPlay(); };
  if (reviewExitBtn) reviewExitBtn.onclick = function(){ playBtnClick(); stopReviewPlay(); exitReview(); };

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
    if (victoryTitle) victoryTitle.textContent = winnerName + (winnerName === 'You' ? ' Win!' : ' Wins!');
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
      moveLog.push({ turn: pending.mover, place: pending.place, grow: null });
      if (!hasAwardedWin) {
        hasAwardedWin = true;
        scores[S.turn] = (scores[S.turn] || 0) + 1;
        recordGameResult(S.turn);
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
      moveLog.push({ turn: lastPlayed.mover, place: lastPlayed.place, grow: lastPlayed.grow });
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

  function botPlayTurn(placeKey, growKey){
    reqSeq++;
    history.push(clone(S));
    var botTurn = S.turn;
    pending = { mover: botTurn, place: placeKey };
    S.cells[placeKey] = botTurn;
    playPlaceSfx();

    var w = lineAt(S.cells, placeKey, botTurn);
    if (w) {
      S.line = w;
      S.over = true;
      moveLog.push({ turn: pending.mover, place: pending.place, grow: null });
      if (!hasAwardedWin) {
        hasAwardedWin = true;
        scores[botTurn] = (scores[botTurn] || 0) + 1;
        recordGameResult(botTurn);
        playWinSfx();
        triggerConfetti();
        showVictoryModal(botTurn);
      }
      justAdded = null;
      lastPlacedMark = { key: placeKey, turn: botTurn };
      lastGrownSquare = null;
      updateLastMoveBadge('Last move: <b>Bot (' + botTurn + ')</b> marked ' + sq(placeKey) + ' (Win!)');
      needAna = true;
      draw();
      return;
    }

    // Complete bot turn seamlessly with board growth
    var validGrow = (growKey && !(growKey in S.cells)) ? growKey : growCands(S.cells)[0];
    pending.grow = validGrow;
    lastPlayed = pending;
    moveLog.push({ turn: lastPlayed.mover, place: lastPlayed.place, grow: lastPlayed.grow });
    pending = null;

    S.cells[validGrow] = null;
    S.phase = 'place';
    S.turn = other(botTurn);

    setTimeout(playGrowSfx, 90);

    justAdded = validGrow;
    lastPlacedMark = { key: placeKey, turn: botTurn };
    lastGrownSquare = validGrow;
    updateLastMoveBadge('Last move: <b>Bot (' + botTurn + ')</b> marked ' + sq(placeKey) + ', grew ' + sq(validGrow));
    needAna = true;
    draw();
  }

  function step(){
    if (reviewing || !BOT_MODES[mode] || S.over || S.turn === humanColor) return;
    setTimeout(function(){
      if (!BOT_MODES[mode] || S.over || S.turn === humanColor) return;
      var seq = reqSeq, w = W[mode] || W.hard;
      var doSearch = w.parallel ? searchParallel : searchAsync;
      doSearch(S.cells, S.turn, w.ms, w.depth, w, function(r){
        if (seq !== reqSeq || !BOT_MODES[mode] || S.over || S.turn === humanColor || S.phase !== 'place') return;
        if (r.hash && r.best) botMoveLog.push({ hash: r.hash, p: r.best.p, g: r.best.g });
        var p = r.best ? r.best.p : opens(S.cells)[0];
        var g = r.best ? r.best.g : slots(S.cells)[0];
        botPlayTurn(p, g);
      }, loadEngineMemory());
    }, 280);
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
    var human;
    if (reviewing) human = true;
    else if (mode === 'online') human = onlineConnected && S.turn === myColor;
    else if (BOT_MODES[mode]) human = S.turn === humanColor;
    else human = true;

    var showSlots = !S.over && S.phase === 'grow' && human;

    for (var y = minY; y <= maxY; y++) {
      for (var x = minX; x <= maxX; x++) {
        var kk = k(x, y), el;
        if (kk in S.cells) {
          var m = S.cells[kk];
          if (m === null && !S.over && S.phase === 'place' && human && !reviewing) {
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
        } else if (showSlots && cand.indexOf(kk) > -1 && human && !reviewing) {
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

      if (reviewing && reviewGame) {
        var revOppName = reviewGame.mode === 'online' ? 'Opponent' : ('Bot (' + reviewGame.oppLabel + ')');
        nameX.textContent = reviewGame.myColor === 'X' ? 'You' : revOppName;
        nameO.textContent = reviewGame.myColor === 'O' ? 'You' : revOppName;
        roleX.textContent = 'Review';
        roleO.textContent = 'Review';
      } else if (mode === 'human') {
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
      if (S.over || (BOT_MODES[mode] && S.turn !== humanColor)) {
        step1.classList.remove('active');
        step2.classList.remove('active');
      } else {
        step1.classList.toggle('active', S.phase === 'place');
        step2.classList.toggle('active', S.phase === 'grow');
      }
    }

    /* Status Messages */
    if (reviewing) {
      whoText.textContent = 'Reviewing move ' + reviewStep + ' of ' + reviewGame.moves.length;
      hint.textContent = reviewStep === 0 ? 'Start of game' : (S.over ? (S.turn + ' won this game') : 'Step through with the controls below');
    } else if (S.over) {
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

    undoBtn.disabled = reviewing || history.length === 0 || mode === 'online';

    if (anaOn && !S.over && S.phase === 'place' && needAna) {
      needAna = false;
      clearTimeout(anaTimer);
      anaTimer = setTimeout(runAnalysis, 30);
    }
  }

  /* ---------- Engine Analysis Logic ---------- */
  var anaOn = false, needAna = false, anaTimer = null, hintMove = null, prevEval = null, lastPlayed = null, pending = null, logRows = [];

  /* Online moves' cell keys originate from a remote peer (invite-link
     partner or random-match stranger) and are validated before they ever
     reach place()/grow() (see handleOnlineMove) — but this is a second,
     independent layer: sq()'s output goes straight into innerHTML in a
     few places, so escaping it here means even an unvalidated or
     malformed key can never inject markup, regardless of whether every
     call site upstream got the validation right. */
  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, function(c){
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function sq(t){ return t ? '(' + escapeHtml(t).replace(',', ', ') + ')' : '-'; }
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
      if (!reviewing && prevEval && lastPlayed && lastPlayed.mover === prevEval.mover && lastPlayed.seen !== true) {
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
    botMoveLog = [];
    moveLog = [];

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

  /* The peer on the other end of an online game (invite-link partner or a
     random-match stranger) is not trusted: nothing stops a modified client
     from sending an arbitrary payload instead of a real move, or from
     sending a real-looking move out of turn to hijack pacing/sequence.
     Two checks before anything touches S.cells or the DOM: the move must
     be legal against the current shared board, AND it must actually be
     the sender's turn (S.turn is always the mark whose full turn — place
     then grow — is in progress; a peer only ever gets to act when it's
     the color that isn't ours). Anything else is dropped, never applied. */
  function handleOnlineMove(data){
    if (!data || typeof data.k !== 'string') return;
    if (data.t === 'reset') { startOnlineGame(); return; }
    if (mode === 'online' && myColor && S.turn !== other(myColor)) return;
    if (data.t === 'place') { if (legalPlacement(S.cells, data.k)) place(data.k, true); }
    else if (data.t === 'grow') { if (legalGrowth(S.cells, data.k)) grow(data.k, true); }
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
