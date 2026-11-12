// Puzzle generator + difficulty grader.
// Everything lives inside sudokuGen() so the page can run it in a Web Worker
// (built from this function's own source) without a separate worker file.
function sudokuGen() {
  const R = [], C = [], B = [];
  for (let i = 0; i < 81; i++) {
    R[i] = Math.floor(i / 9);
    C[i] = i % 9;
    B[i] = Math.floor(R[i] / 3) * 3 + Math.floor(C[i] / 3);
  }
  // 27 units: rows 0-8, cols 9-17, boxes 18-26
  const UNITS = [];
  for (let k = 0; k < 9; k++) {
    UNITS.push([...Array(81).keys()].filter(i => R[i] === k));
  }
  for (let k = 0; k < 9; k++) {
    UNITS.push([...Array(81).keys()].filter(i => C[i] === k));
  }
  for (let k = 0; k < 9; k++) {
    UNITS.push([...Array(81).keys()].filter(i => B[i] === k));
  }
  const PEERS = [];
  for (let i = 0; i < 81; i++) {
    const s = new Set();
    for (let j = 0; j < 81; j++) {
      if (j !== i && (R[j] === R[i] || C[j] === C[i] || B[j] === B[i])) s.add(j);
    }
    PEERS[i] = [...s];
  }
  const ALL = 0x3fe; // bits 1..9

  function pop(m) {
    let c = 0;
    while (m) { m &= m - 1; c++; }
    return c;
  }
  function digitsOf(m) {
    const out = [];
    for (let d = 1; d <= 9; d++) if (m & (1 << d)) out.push(d);
    return out;
  }
  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Backtracking with bitmasks. Returns number of solutions found (stops at limit).
  // If `out` is given, the first solution found is copied into it.
  function solveCount(g, limit, randomize, out) {
    const grid = g.slice();
    const rm = new Array(9).fill(0), cm = new Array(9).fill(0), bm = new Array(9).fill(0);
    for (let i = 0; i < 81; i++) {
      const v = grid[i];
      if (v) {
        const bit = 1 << v;
        if ((rm[R[i]] | cm[C[i]] | bm[B[i]]) & bit) return 0;
        rm[R[i]] |= bit; cm[C[i]] |= bit; bm[B[i]] |= bit;
      }
    }
    let count = 0;
    function rec() {
      let best = -1, bestMask = 0, bestN = 10;
      for (let i = 0; i < 81; i++) {
        if (grid[i]) continue;
        const m = ALL & ~(rm[R[i]] | cm[C[i]] | bm[B[i]]);
        const n = pop(m);
        if (n < bestN) {
          bestN = n; best = i; bestMask = m;
          if (n <= 1) break;
        }
      }
      if (best < 0) {
        count++;
        if (out && count === 1) for (let i = 0; i < 81; i++) out[i] = grid[i];
        return count >= limit;
      }
      if (bestN === 0) return false;
      let ds = digitsOf(bestMask);
      if (randomize) shuffle(ds);
      for (const d of ds) {
        const bit = 1 << d;
        grid[best] = d;
        rm[R[best]] |= bit; cm[C[best]] |= bit; bm[B[best]] |= bit;
        if (rec()) return true;
        rm[R[best]] &= ~bit; cm[C[best]] &= ~bit; bm[B[best]] &= ~bit;
      }
      grid[best] = 0;
      return false;
    }
    rec();
    return count;
  }

  // ---- Logical solver used for grading ----
  // Returns { solved, steps: { singles, locked, pairs, triples, xwing } }
  function grade(puzzle) {
    const val = puzzle.slice();
    const cand = new Array(81).fill(0);
    const steps = { singles: 0, locked: 0, subsets: 0, xwing: 0 };
    for (let i = 0; i < 81; i++) {
      if (!val[i]) {
        let m = ALL;
        for (const p of PEERS[i]) if (val[p]) m &= ~(1 << val[p]);
        cand[i] = m;
      }
    }
    function place(i, d) {
      val[i] = d; cand[i] = 0;
      for (const p of PEERS[i]) cand[p] &= ~(1 << d);
    }
    function nakedSingle() {
      for (let i = 0; i < 81; i++) {
        if (!val[i] && pop(cand[i]) === 1) {
          place(i, digitsOf(cand[i])[0]);
          return true;
        }
      }
      return false;
    }
    function hiddenSingle() {
      for (const u of UNITS) {
        for (let d = 1; d <= 9; d++) {
          const bit = 1 << d;
          let where = -1, n = 0;
          for (const i of u) if (cand[i] & bit) { n++; where = i; }
          if (n === 1) { place(where, d); return true; }
        }
      }
      return false;
    }
    function lockedCandidates() {
      // pointing: box -> line
      for (let b = 0; b < 9; b++) {
        const box = UNITS[18 + b];
        for (let d = 1; d <= 9; d++) {
          const bit = 1 << d;
          const cells = box.filter(i => cand[i] & bit);
          if (cells.length < 2) continue;
          for (const [arr, line] of [[R, 0], [C, 9]]) {
            const k = arr[cells[0]];
            if (cells.every(i => arr[i] === k)) {
              let changed = false;
              for (const i of UNITS[line + k]) {
                if (B[i] !== b && (cand[i] & bit)) { cand[i] &= ~bit; changed = true; }
              }
              if (changed) return true;
            }
          }
        }
      }
      // claiming: line -> box
      for (let u = 0; u < 18; u++) {
        for (let d = 1; d <= 9; d++) {
          const bit = 1 << d;
          const cells = UNITS[u].filter(i => cand[i] & bit);
          if (cells.length < 2) continue;
          const b = B[cells[0]];
          if (cells.every(i => B[i] === b)) {
            let changed = false;
            const lineSet = new Set(UNITS[u]);
            for (const i of UNITS[18 + b]) {
              if (!lineSet.has(i) && (cand[i] & bit)) { cand[i] &= ~bit; changed = true; }
            }
            if (changed) return true;
          }
        }
      }
      return false;
    }
    function combos(arr, n, start = 0, acc = [], out = []) {
      if (acc.length === n) { out.push(acc.slice()); return out; }
      for (let i = start; i < arr.length; i++) {
        acc.push(arr[i]); combos(arr, n, i + 1, acc, out); acc.pop();
      }
      return out;
    }
    function nakedSubset(n) {
      for (const u of UNITS) {
        const open = u.filter(i => !val[i] && pop(cand[i]) >= 2 && pop(cand[i]) <= n);
        for (const set of combos(open, n)) {
          let m = 0;
          for (const i of set) m |= cand[i];
          if (pop(m) !== n) continue;
          let changed = false;
          for (const i of u) {
            if (!val[i] && !set.includes(i) && (cand[i] & m)) { cand[i] &= ~m; changed = true; }
          }
          if (changed) return true;
        }
      }
      return false;
    }
    function hiddenSubset(n) {
      for (const u of UNITS) {
        const ds = [];
        for (let d = 1; d <= 9; d++) {
          const c = u.filter(i => cand[i] & (1 << d)).length;
          if (c >= 2 && c <= n) ds.push(d);
        }
        for (const set of combos(ds, n)) {
          let m = 0;
          for (const d of set) m |= 1 << d;
          const cells = u.filter(i => cand[i] & m);
          if (cells.length !== n) continue;
          let changed = false;
          for (const i of cells) {
            if (cand[i] & ~m) { cand[i] &= m; changed = true; }
          }
          if (changed) return true;
        }
      }
      return false;
    }
    function xWing() {
      for (const [base, cross] of [[0, 9], [9, 0]]) {
        for (let d = 1; d <= 9; d++) {
          const bit = 1 << d;
          const pos = [];
          for (let k = 0; k < 9; k++) {
            pos.push(UNITS[base + k].filter(i => cand[i] & bit).map(i => (base === 0 ? C[i] : R[i])));
          }
          for (let a = 0; a < 9; a++) {
            if (pos[a].length !== 2) continue;
            for (let b2 = a + 1; b2 < 9; b2++) {
              if (pos[b2].length !== 2 || pos[b2][0] !== pos[a][0] || pos[b2][1] !== pos[a][1]) continue;
              let changed = false;
              for (const x of pos[a]) {
                for (const i of UNITS[cross + x]) {
                  const line = base === 0 ? R[i] : C[i];
                  if (line !== a && line !== b2 && (cand[i] & bit)) { cand[i] &= ~bit; changed = true; }
                }
              }
              if (changed) return true;
            }
          }
        }
      }
      return false;
    }

    for (;;) {
      if (val.every(v => v)) return { solved: true, steps };
      for (let i = 0; i < 81; i++) if (!val[i] && cand[i] === 0) return { solved: false, steps };
      if (nakedSingle() || hiddenSingle()) { steps.singles++; continue; }
      if (lockedCandidates()) { steps.locked++; continue; }
      if (nakedSubset(2) || hiddenSubset(2) || nakedSubset(3) || hiddenSubset(3)) { steps.subsets++; continue; }
      if (xWing()) { steps.xwing++; continue; }
      return { solved: false, steps };
    }
  }

  function makeFull() {
    const out = new Array(81).fill(0);
    solveCount(new Array(81).fill(0), 1, true, out);
    return out;
  }

  function makeMinimal(solution) {
    const puzzle = solution.slice();
    for (const i of shuffle([...Array(81).keys()])) {
      const keep = puzzle[i];
      puzzle[i] = 0;
      if (solveCount(puzzle, 2, false) !== 1) puzzle[i] = keep;
    }
    return puzzle;
  }

  function isHard(g) {
    if (!g.solved) return false;
    const adv = g.steps.locked + g.steps.subsets + g.steps.xwing;
    // Needs several non-single deductions, at least one beyond pointing/claiming.
    return adv >= 4 && (g.steps.subsets + g.steps.xwing) >= 1;
  }

  function generateHard(maxTries = 400) {
    let fallback = null;
    for (let t = 0; t < maxTries; t++) {
      const solution = makeFull();
      const puzzle = makeMinimal(solution);
      const g = grade(puzzle);
      if (isHard(g)) return { puzzle, solution, steps: g.steps, tries: t + 1 };
      if (g.solved && (g.steps.locked + g.steps.subsets + g.steps.xwing) >= 1 && !fallback) {
        fallback = { puzzle, solution, steps: g.steps, tries: t + 1 };
      }
    }
    return fallback;
  }

  const api = { generateHard, grade, solveCount, isHard };
  if (typeof self !== 'undefined' && typeof window === 'undefined' && typeof self.postMessage === 'function') {
    self.onmessage = () => self.postMessage(generateHard());
  }
  return api;
}

if (typeof module !== 'undefined') module.exports = sudokuGen;
