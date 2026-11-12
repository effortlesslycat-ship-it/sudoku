(() => {
  'use strict';

  // ---------- helpers ----------
  const $ = id => document.getElementById(id);
  const R = i => Math.floor(i / 9), C = i => i % 9;
  const B = i => Math.floor(R(i) / 3) * 3 + Math.floor(C(i) / 3);
  const PEERS = [];
  for (let i = 0; i < 81; i++) {
    PEERS[i] = [];
    for (let j = 0; j < 81; j++) if (j !== i && (R(j) === R(i) || C(j) === C(i) || B(j) === B(i))) PEERS[i].push(j);
  }
  const store = {
    get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  const KEY = { game: 'sudoku.game.v1', stats: 'sudoku.stats.v1', next: 'sudoku.next.v1' };

  function fmt(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  }
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // ---------- state ----------
  let game = store.get(KEY.game, null);
  let stats = store.get(KEY.stats, { solves: [], abandoned: 0 });
  let next = store.get(KEY.next, null);
  let sel = -1;
  let mode = 'normal';
  let paused = false;
  let history = [];
  let lastTick = performance.now();

  const save = () => store.set(KEY.game, game);
  const saveStats = () => store.set(KEY.stats, stats);

  function freshGame(p) {
    return {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      puzzle: p.puzzle, solution: p.solution,
      values: p.puzzle.slice(),
      notes: new Array(81).fill(0),
      checks: new Array(81).fill(0), // 0 none, 1 correct, 2 wrong
      elapsed: 0, assisted: false, done: false,
      started: new Date().toISOString(),
    };
  }
  const isGiven = i => game && game.puzzle[i] !== 0;

  // ---------- generator worker ----------
  let worker = null, waiting = null;
  function startWorker() {
    try {
      const src = '(' + sudokuGen.toString() + ')()';
      worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      worker.onmessage = e => {
        if (waiting) { const cb = waiting; waiting = null; cb(e.data); requestNext(); }
        else { next = e.data; store.set(KEY.next, next); }
      };
    } catch { worker = null; }
  }
  function requestNext() {
    if (worker) worker.postMessage('go');
    else setTimeout(() => { next = sudokuGen().generateHard(); store.set(KEY.next, next); }, 50);
  }
  function getPuzzle(cb) {
    if (next) { const p = next; next = null; store.set(KEY.next, null); cb(p); requestNext(); return; }
    $('loading').classList.add('show');
    const done = p => { $('loading').classList.remove('show'); cb(p); };
    if (worker) { waiting = done; worker.postMessage('go'); }
    else setTimeout(() => done(sudokuGen().generateHard()), 30);
  }

  // ---------- board DOM ----------
  const cells = [];
  (function buildBoard() {
    const board = $('board');
    const boxes = [];
    for (let b = 0; b < 9; b++) { const el = document.createElement('div'); el.className = 'box'; board.appendChild(el); boxes.push(el); }
    for (let i = 0; i < 81; i++) {
      const el = document.createElement('div');
      el.className = 'cell';
      el.innerHTML = '<span class="digit"></span><div class="notes">' + '<span></span>'.repeat(9) + '</div>';
      el.addEventListener('click', () => select(i));
      cells[i] = { el, digit: el.firstChild, notes: [...el.lastChild.children], notesBox: el.lastChild };
    }
    // append in box order so the DOM nests by box
    for (let b = 0; b < 9; b++) {
      for (let i = 0; i < 81; i++) if (B(i) === b) boxes[b].appendChild(cells[i].el);
    }
  })();

  function conflicts() {
    const out = new Set();
    for (let i = 0; i < 81; i++) {
      const v = game.values[i];
      if (!v) continue;
      for (const p of PEERS[i]) if (game.values[p] === v) { out.add(i); break; }
    }
    return out;
  }

  function render() {
    if (!game) return;
    const bad = conflicts();
    const sv = sel >= 0 ? game.values[sel] : 0;
    for (let i = 0; i < 81; i++) {
      const c = cells[i], v = game.values[i], given = isGiven(i);
      const cl = c.el.classList;
      cl.toggle('given', given);
      cl.toggle('sel', i === sel);
      cl.toggle('line', sel >= 0 && i !== sel && (R(i) === R(sel) || C(i) === C(sel)));
      cl.toggle('same', sel >= 0 && i !== sel && sv !== 0 && v === sv);
      cl.toggle('conflict', bad.has(i));
      cl.toggle('wrong', !given && v !== 0 && game.checks[i] === 2);
      c.digit.textContent = v || '';
      c.digit.classList.toggle('correct', !given && v !== 0 && game.checks[i] === 1);
      const n = v ? 0 : game.notes[i];
      for (let d = 1; d <= 9; d++) c.notes[d - 1].textContent = (n & (1 << d)) ? d : '';
    }
    // grey out a digit once it's on the board nine times (right or wrong — no hints)
    const counts = new Array(10).fill(0);
    for (const v of game.values) counts[v]++;
    document.querySelectorAll('#pad [data-d]').forEach(b => b.classList.toggle('used', counts[+b.dataset.d] >= 9));
    $('undoBtn').disabled = history.length === 0;
    $('modeNormal').classList.toggle('on', mode === 'normal');
    $('modeCand').classList.toggle('on', mode === 'candidate');
    $('pad').classList.toggle('small', mode === 'candidate');
    $('paused').classList.toggle('show', paused && !game.done);
    $('timer').classList.toggle('hidden-time', false);
    $('time').textContent = fmt(game.elapsed);
  }

  // ---------- actions ----------
  function snapshot() {
    history.push({ values: game.values.slice(), notes: game.notes.slice(), checks: game.checks.slice() });
    if (history.length > 300) history.shift();
  }
  function select(i) {
    if (!game || paused || game.done) return;
    sel = i;
    render();
  }
  function input(d) {
    if (!game || paused || game.done || sel < 0 || isGiven(sel)) return;
    if (mode === 'candidate') {
      snapshot();
      if (game.values[sel]) {
        // candidate over an entry: lift the entry, bring back its notes, add this one
        game.values[sel] = 0;
        game.checks[sel] = 0;
        game.notes[sel] |= (1 << d);
      } else {
        game.notes[sel] ^= (1 << d);
      }
    } else {
      if (game.values[sel] === d) return;
      snapshot();
      game.values[sel] = d;
      game.checks[sel] = 0;
    }
    save(); render();
    if (mode === 'normal') checkFinished();
  }
  function erase() {
    if (!game || paused || game.done || sel < 0 || isGiven(sel)) return;
    if (game.values[sel]) { snapshot(); game.values[sel] = 0; game.checks[sel] = 0; }
    else if (game.notes[sel]) { snapshot(); game.notes[sel] = 0; }
    else return;
    save(); render();
  }
  function undo() {
    if (!history.length || paused || game.done) return;
    const h = history.pop();
    game.values = h.values; game.notes = h.notes; game.checks = h.checks;
    save(); render();
  }
  function checkCell() {
    if (sel < 0 || isGiven(sel) || !game.values[sel]) { toast('Select one of your entries to check.'); return; }
    game.assisted = true;
    game.checks[sel] = game.values[sel] === game.solution[sel] ? 1 : 2;
    save(); render();
  }
  function checkPuzzle() {
    let any = false;
    for (let i = 0; i < 81; i++) {
      if (!isGiven(i) && game.values[i]) { any = true; game.checks[i] = game.values[i] === game.solution[i] ? 1 : 2; }
    }
    if (!any) { toast('Nothing to check yet.'); return; }
    game.assisted = true;
    save(); render();
  }
  function resetPuzzle() {
    if (!confirm('Clear all your entries and notes? The timer keeps running.')) return;
    game.values = game.puzzle.slice();
    game.notes = new Array(81).fill(0);
    game.checks = new Array(81).fill(0);
    history = [];
    save(); render();
  }
  function hasProgress() {
    return game && !game.done && game.values.some((v, i) => v && !isGiven(i));
  }
  function newPuzzle(skipConfirm) {
    if (!skipConfirm && hasProgress()) {
      if (!confirm('Abandon this puzzle and start a new one? It will count as abandoned.')) return;
      stats.abandoned = (stats.abandoned || 0) + 1; saveStats();
    }
    getPuzzle(p => {
      game = freshGame(p); sel = -1; history = []; paused = false; lastTick = performance.now();
      save(); render();
    });
  }
  function checkFinished() {
    if (game.values.some(v => !v)) return;
    if (game.values.every((v, i) => v === game.solution[i])) win();
    else toast("Every cell's filled, but something's off.");
  }

  // ---------- win ----------
  const QUIPS = [
    'All nine accounted for.',
    'No duplicates in the records.',
    'Case closed.',
    'Every row reconciled.',
    'Fully indexed.',
    'Not a single conflicting source.',
    'Sources cited, conclusion sound.',
  ];
  function win() {
    game.done = true; sel = -1;
    const prior = stats.solves.filter(s => !s.assisted).map(s => s.ms);
    const best = prior.length ? Math.min(...prior) : null;
    const avg = prior.length ? prior.reduce((a, b) => a + b, 0) / prior.length : null;
    stats.solves.push({ id: game.id, date: new Date().toISOString(), ms: game.elapsed, assisted: game.assisted });
    saveStats(); save(); render();
    let sub;
    if (game.assisted) sub = 'Logged as assisted, since you used Check.';
    else if (best === null) sub = 'Your first one on the books.';
    else if (game.elapsed < best) sub = `New best — previous was ${fmt(best)}.`;
    else sub = `Your average: ${fmt(avg)} · best ${fmt(best)}`;
    $('winBody').innerHTML = `
      <h2>Solved${game.assisted ? '<span class="tag">assisted</span>' : ''}</h2>
      <p class="win-time">${fmt(game.elapsed)}</p>
      <p class="win-sub">${sub}</p>
      <p class="win-quip">${QUIPS[Math.floor(Math.random() * QUIPS.length)]}</p>
      <div class="btnrow"><button class="btn primary" id="winNew">New puzzle</button><button class="btn" id="winStats">Stats</button></div>`;
    $('winSheet').classList.add('show');
    $('winNew').onclick = () => { $('winSheet').classList.remove('show'); newPuzzle(true); };
    $('winStats').onclick = () => { $('winSheet').classList.remove('show'); openStats(); };
  }

  // ---------- stats ----------
  function openStats() { renderStats(); $('statsSheet').classList.add('show'); }
  function renderStats() {
    const only = $('unassistedOnly').checked;
    const all = stats.solves;
    const list = only ? all.filter(s => !s.assisted) : all;
    const times = list.map(s => s.ms);
    const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
    const last10 = times.slice(-10), prev10 = times.slice(-20, -10);
    const recent = avg(last10), before = avg(prev10);
    let trend = '';
    if (recent !== null && before !== null) {
      const diff = recent - before;
      trend = diff < 0 ? `<em class="good">▼ ${fmt(-diff)}</em>` : diff > 0 ? `<em class="meh">▲ ${fmt(diff)}</em>` : '';
    }
    const box = (val, label) => `<div class="stat"><b>${val}</b><span>${label}</span></div>`;
    let html = '<div class="grid2">' +
      box(list.length, only ? 'Unassisted solves' : 'Solved') +
      box(times.length ? fmt(Math.min(...times)) : '—', 'Best time') +
      box(times.length ? fmt(avg(times)) : '—', 'Average') +
      `<div class="stat"><b>${recent !== null ? fmt(recent) : '—'}${trend}</b><span>Last 10 average${before !== null ? ' vs. the 10 before' : ''}</span></div>` +
      box(all.filter(s => s.assisted).length, 'Assisted') +
      box(stats.abandoned || 0, 'Abandoned') +
      '</div>';
    html += list.length >= 2
      ? `<div class="chartbox">${chart(list)}<div class="legend"><span><i style="background:var(--accent)"></i>Solve time</span>${only ? '' : '<span><i style="border:1.5px solid #9a9a9a"></i>Assisted</span>'}<span><i style="background:#9db6f2;border-radius:2px;height:3px"></i>5-solve average</span></div></div>`
      : '<p class="fine" style="margin:0 0 16px">The trend chart appears after your second solve.</p>';
    $('statsBody').innerHTML = html;
  }
  function chart(list) {
    const W = 320, H = 170, L = 34, Rt = 8, T = 10, Bt = 22;
    const ms = list.map(s => s.ms);
    const maxMin = Math.max(5, Math.ceil(Math.max(...ms) / 60000 / 5) * 5);
    const x = k => L + (list.length === 1 ? 0 : k * (W - L - Rt) / (list.length - 1));
    const y = m => T + (H - T - Bt) * (1 - m / 60000 / maxMin);
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Solve times over time">`;
    const step = maxMin <= 20 ? 5 : maxMin <= 60 ? 10 : 30;
    for (let m = 0; m <= maxMin; m += step) {
      const yy = y(m * 60000).toFixed(1);
      s += `<line x1="${L}" x2="${W - Rt}" y1="${yy}" y2="${yy}" stroke="#333" stroke-width="1"/>`;
      s += `<text x="${L - 6}" y="${+yy + 4}" fill="#8a8a8a" font-size="10" text-anchor="end">${m}m</text>`;
    }
    s += `<text x="${L}" y="${H - 6}" fill="#8a8a8a" font-size="10">first</text><text x="${W - Rt}" y="${H - 6}" fill="#8a8a8a" font-size="10" text-anchor="end">latest</text>`;
    // rolling average
    const pts = ms.map((_, k) => {
      const win = ms.slice(Math.max(0, k - 4), k + 1);
      return `${x(k).toFixed(1)},${y(win.reduce((a, b) => a + b, 0) / win.length).toFixed(1)}`;
    });
    s += `<polyline points="${pts.join(' ')}" fill="none" stroke="#9db6f2" stroke-width="2" stroke-linejoin="round"/>`;
    list.forEach((it, k) => {
      const cx = x(k).toFixed(1), cy = y(it.ms).toFixed(1);
      s += it.assisted
        ? `<circle cx="${cx}" cy="${cy}" r="3.6" fill="#1c1c1c" stroke="#9a9a9a" stroke-width="1.5"/>`
        : `<circle cx="${cx}" cy="${cy}" r="3.6" fill="#eba13c"/>`;
    });
    return s + '</svg>';
  }
  async function exportStats() {
    const data = JSON.stringify({ app: 'sudoku', version: 1, exported: new Date().toISOString(), ...stats }, null, 2);
    const name = `sudoku-stats-${new Date().toISOString().slice(0, 10)}.json`;
    try {
      const file = new File([data], name, { type: 'application/json' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'Sudoku stats' }); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
  }
  function importStats(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const d = JSON.parse(reader.result);
        if (!d || !Array.isArray(d.solves)) throw new Error('bad');
        const have = new Set(stats.solves.map(s => s.id));
        let added = 0;
        for (const s of d.solves) {
          if (s && s.id && typeof s.ms === 'number' && !have.has(s.id)) { stats.solves.push({ id: s.id, date: s.date, ms: s.ms, assisted: !!s.assisted }); added++; }
        }
        stats.solves.sort((a, b) => String(a.date).localeCompare(String(b.date)));
        stats.abandoned = Math.max(stats.abandoned || 0, d.abandoned || 0);
        saveStats(); renderStats();
        toast(added ? `Imported ${added} solve${added === 1 ? '' : 's'}.` : 'Nothing new in that file.');
      } catch { toast("That file doesn't look like a sudoku stats export."); }
    };
    reader.readAsText(file);
  }

  // ---------- timer & pause ----------
  function setPaused(p) {
    if (!game || game.done) return;
    paused = p; lastTick = performance.now(); save(); render();
  }
  setInterval(() => {
    const now = performance.now();
    if (game && !game.done && !paused && document.visibilityState === 'visible') {
      game.elapsed += now - lastTick;
      $('time').textContent = fmt(game.elapsed);
      if (Math.floor(game.elapsed / 1000) % 5 === 0) save();
    }
    lastTick = now;
  }, 250);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { if (game && !game.done) { paused = true; save(); render(); } }
    else lastTick = performance.now();
  });
  window.addEventListener('pagehide', save);

  // ---------- wiring ----------
  $('pad').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.d) input(+b.dataset.d); else if (b.id === 'eraseBtn') erase();
  });
  $('modeNormal').onclick = () => { mode = 'normal'; render(); };
  $('modeCand').onclick = () => { mode = 'candidate'; render(); };
  $('undoBtn').onclick = undo;
  $('timer').onclick = () => setPaused(!paused);
  $('resumeBtn').onclick = () => setPaused(false);

  const closeMenu = () => { $('menu').classList.remove('show'); $('scrim').classList.remove('show'); };
  $('menuBtn').onclick = () => { $('menu').classList.add('show'); $('scrim').classList.add('show'); };
  $('scrim').onclick = closeMenu;
  $('menu').addEventListener('click', e => {
    const act = e.target.dataset.act; if (!act) return;
    closeMenu();
    if (act === 'newPuzzle') return newPuzzle(false);
    if (!game || game.done || paused) return;
    ({ checkCell, checkPuzzle, reset: resetPuzzle })[act]();
  });

  $('statsBtn').onclick = openStats;
  $('unassistedOnly').onchange = renderStats;
  $('exportBtn').onclick = exportStats;
  $('importBtn').onclick = () => $('importFile').click();
  $('importFile').onchange = e => { const f = e.target.files[0]; if (f) importStats(f); e.target.value = ''; };
  document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => b.closest('.sheet-bg').classList.remove('show'));
  document.querySelectorAll('.sheet-bg').forEach(bg => bg.addEventListener('click', e => { if (e.target === bg) bg.classList.remove('show'); }));

  // keyboard (for testing on a computer)
  document.addEventListener('keydown', e => {
    if (e.key >= '1' && e.key <= '9') input(+e.key);
    else if (e.key === 'Backspace' || e.key === 'Delete' || e.key === '0') erase();
    else if (e.key === 'n' || e.key === 'N') { mode = mode === 'normal' ? 'candidate' : 'normal'; render(); }
    else if ((e.metaKey || e.ctrlKey) && e.key === 'z') undo();
    else if (e.key.startsWith('Arrow') && game) {
      if (sel < 0) sel = 0;
      const r = R(sel), c = C(sel);
      const m = { ArrowUp: [r + 8, c], ArrowDown: [r + 1, c], ArrowLeft: [r, c + 8], ArrowRight: [r, c + 1] }[e.key];
      select((m[0] % 9) * 9 + (m[1] % 9)); e.preventDefault();
    }
  });

  // ---------- start ----------
  startWorker();
  if (game && !game.done) {
    if (game.elapsed > 0) paused = true; // resuming: show the pause screen, tap to continue
    render();
    if (!next) requestNext();
  } else {
    newPuzzle(true);
  }

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
