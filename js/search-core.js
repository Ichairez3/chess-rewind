// Finds a legal sequence of moves from the starting position to a target position.
//
// It is a beam search: each ply we expand every kept position, score the children by
// how far they still are from the target, and keep only the best few hundred.
// The score is an estimate: for every piece type we match the pieces on the board to
// the target squares (Hungarian algorithm) using how many moves each piece needs to
// get there, plus the captures each side still has to make.
//
// This file is written as one self-contained factory function so it can run inside a
// Web Worker (it is stringified into a Blob) and also be loaded in Node for testing.
function searchCoreFactory(Chess) {
  const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const INF = 1e9;
  const BIG = 99;
  const CHARS = 'PNBRQKpnbrqk';
  const PROMOTION_COST = 6;

  // Knight distance table (64 x 64) via BFS.
  const KNIGHT = new Int8Array(64 * 64).fill(-1);
  const JUMPS = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
  for (let s = 0; s < 64; s++) {
    const queue = [s];
    KNIGHT[s * 64 + s] = 0;
    while (queue.length) {
      const c = queue.shift();
      const r = c >> 3, f = c & 7;
      for (const [dr, df] of JUMPS) {
        const nr = r + dr, nf = f + df;
        if (nr < 0 || nr > 7 || nf < 0 || nf > 7) continue;
        const n = nr * 8 + nf;
        if (KNIGHT[s * 64 + n] === -1) {
          KNIGHT[s * 64 + n] = KNIGHT[s * 64 + c] + 1;
          queue.push(n);
        }
      }
    }
  }

  // Square index: 0 = a8, 7 = h8, 56 = a1 (same order as chess.js board()).
  function arrFromFen(fen) {
    const arr = new Array(64).fill(null);
    const rows = fen.split(' ')[0].split('/');
    for (let r = 0; r < 8; r++) {
      let f = 0;
      for (const ch of rows[r]) {
        if (ch >= '1' && ch <= '8') f += +ch;
        else arr[r * 8 + f++] = ch;
      }
    }
    return arr;
  }

  function placementKey(arr) {
    let s = '';
    for (let i = 0; i < 64; i++) s += arr[i] || '.';
    return s;
  }

  function nameOf(i) {
    return String.fromCharCode(97 + (i & 7)) + (8 - (i >> 3));
  }

  // ---- Fast legal move generator (chess.js is far too slow for the inner loop) ----
  // Castling rights bitmask: 1 = K, 2 = Q, 4 = k, 8 = q.
  const KING_STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const isWhite = p => p < 'a';

  function attacked(arr, sq, byWhite) {
    const r = sq >> 3, f = sq & 7;
    // Pawns: a white pawn attacks upward (towards lower row index).
    const pr = byWhite ? r + 1 : r - 1, pawn = byWhite ? 'P' : 'p';
    if (pr >= 0 && pr < 8) {
      if (f > 0 && arr[pr * 8 + f - 1] === pawn) return true;
      if (f < 7 && arr[pr * 8 + f + 1] === pawn) return true;
    }
    const knight = byWhite ? 'N' : 'n', king = byWhite ? 'K' : 'k';
    for (const [dr, df] of JUMPS) {
      const nr = r + dr, nf = f + df;
      if (nr >= 0 && nr < 8 && nf >= 0 && nf < 8 && arr[nr * 8 + nf] === knight) return true;
    }
    for (const [dr, df] of KING_STEPS) {
      const nr = r + dr, nf = f + df;
      if (nr >= 0 && nr < 8 && nf >= 0 && nf < 8 && arr[nr * 8 + nf] === king) return true;
    }
    const rook = byWhite ? 'R' : 'r', bishop = byWhite ? 'B' : 'b', queen = byWhite ? 'Q' : 'q';
    for (const [dr, df] of ROOK_DIRS) {
      let nr = r + dr, nf = f + df;
      while (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) {
        const p = arr[nr * 8 + nf];
        if (p) { if (p === rook || p === queen) return true; break; }
        nr += dr; nf += df;
      }
    }
    for (const [dr, df] of BISHOP_DIRS) {
      let nr = r + dr, nf = f + df;
      while (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) {
        const p = arr[nr * 8 + nf];
        if (p) { if (p === bishop || p === queen) return true; break; }
        nr += dr; nf += df;
      }
    }
    return false;
  }

  function pseudoMoves(arr, white, castling, ep) {
    const moves = [];
    const add = (from, to, flag, promo) => moves.push({ from, to, piece: arr[from], captured: flag === 'ep' ? (white ? 'p' : 'P') : arr[to], promo: promo || null, flag: flag || '' });
    const enemy = p => p && isWhite(p) !== white;
    for (let sq = 0; sq < 64; sq++) {
      const p = arr[sq];
      if (!p || isWhite(p) !== white) continue;
      const r = sq >> 3, f = sq & 7, t = p.toLowerCase();
      if (t === 'p') {
        const dir = white ? -1 : 1, nr = r + dir;
        const lastRow = white ? 0 : 7, startRow = white ? 6 : 1;
        const pushTo = (to, flag) => {
          if (nr === lastRow) for (const q of 'qrbn') add(sq, to, flag, white ? q.toUpperCase() : q);
          else add(sq, to, flag);
        };
        if (!arr[nr * 8 + f]) {
          pushTo(nr * 8 + f);
          if (r === startRow && !arr[(nr + dir) * 8 + f]) add(sq, (nr + dir) * 8 + f, 'double');
        }
        for (const df of [-1, 1]) {
          const nf = f + df;
          if (nf < 0 || nf > 7) continue;
          const to = nr * 8 + nf;
          if (enemy(arr[to])) pushTo(to);
          else if (to === ep) add(sq, to, 'ep');
        }
      } else if (t === 'n' || t === 'k') {
        for (const [dr, df] of (t === 'n' ? JUMPS : KING_STEPS)) {
          const nr = r + dr, nf = f + df;
          if (nr < 0 || nr > 7 || nf < 0 || nf > 7) continue;
          const to = nr * 8 + nf;
          if (!arr[to] || enemy(arr[to])) add(sq, to);
        }
      } else {
        const dirs = t === 'r' ? ROOK_DIRS : t === 'b' ? BISHOP_DIRS : KING_STEPS;
        for (const [dr, df] of dirs) {
          let nr = r + dr, nf = f + df;
          while (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) {
            const to = nr * 8 + nf;
            if (arr[to]) { if (enemy(arr[to])) add(sq, to); break; }
            add(sq, to);
            nr += dr; nf += df;
          }
        }
      }
    }
    // Castling (king on e1/e8 with rights, empty path, not through check).
    const home = white ? 60 : 4, K = white ? 'K' : 'k', R = white ? 'R' : 'r';
    if (arr[home] === K && !attacked(arr, home, !white)) {
      if ((castling & (white ? 1 : 4)) && arr[home + 3] === R && !arr[home + 1] && !arr[home + 2] && !attacked(arr, home + 1, !white)) add(home, home + 2, 'k');
      if ((castling & (white ? 2 : 8)) && arr[home - 4] === R && !arr[home - 1] && !arr[home - 2] && !arr[home - 3] && !attacked(arr, home - 1, !white)) add(home, home - 2, 'q');
    }
    return moves;
  }

  // Squares whose rook/king leaving or being captured removes castling rights.
  const CASTLE_MASK = { 60: 3, 56: 2, 63: 1, 4: 12, 0: 8, 7: 4 };

  function applyMove(arr, m) {
    const a = arr.slice();
    a[m.from] = null;
    if (m.flag === 'ep') a[(m.from & 56) + (m.to & 7)] = null;
    a[m.to] = m.promo || m.piece;
    if (m.flag === 'k') { a[m.to - 1] = a[m.to + 1]; a[m.to + 1] = null; }
    if (m.flag === 'q') { a[m.to + 1] = a[m.to - 2]; a[m.to - 2] = null; }
    return a;
  }

  // Legal moves for a node: returns [{move, arr, castling, ep}].
  function legalChildren(node) {
    const white = node.turn === 'w';
    const out = [];
    for (const m of pseudoMoves(node.arr, white, node.castling, node.ep)) {
      const a = applyMove(node.arr, m);
      const kingSq = a.indexOf(white ? 'K' : 'k');
      if (attacked(a, kingSq, !white)) continue;
      const castling = node.castling & ~(CASTLE_MASK[m.from] || 0) & ~(CASTLE_MASK[m.to] || 0);
      const ep = m.flag === 'double' ? (m.from + m.to) >> 1 : -1;
      out.push({ move: m, arr: a, castling, ep });
    }
    return out;
  }

  // Estimated number of moves for a piece to travel between two squares (ignoring blockers).
  function pieceDistance(type, white, from, to) {
    const fr = from >> 3, ff = from & 7, tr = to >> 3, tf = to & 7;
    const dr = Math.abs(fr - tr), df = Math.abs(ff - tf);
    switch (type) {
      case 'k': return Math.max(dr, df);
      case 'n': return KNIGHT[from * 64 + to];
      case 'b':
        if (((fr + ff) & 1) !== ((tr + tf) & 1)) return BIG;
        return from === to ? 0 : (dr === df ? 1 : 2);
      case 'r': return from === to ? 0 : (fr === tr || ff === tf ? 1 : 2);
      case 'q': return from === to ? 0 : (fr === tr || ff === tf || dr === df ? 1 : 2);
      case 'p': {
        const advance = white ? fr - tr : tr - fr;
        if (advance < 0 || df > advance) return BIG;
        const onStart = fr === (white ? 6 : 1);
        return onStart && advance - df >= 2 ? advance - 1 : advance;
      }
    }
    return BIG;
  }

  // Minimum-cost assignment for a square cost matrix (n x n), Hungarian algorithm.
  function hungarian(a, n) {
    const u = new Array(n + 1).fill(0), v = new Array(n + 1).fill(0);
    const p = new Array(n + 1).fill(0), way = new Array(n + 1).fill(0);
    for (let i = 1; i <= n; i++) {
      p[0] = i;
      let j0 = 0;
      const minv = new Array(n + 1).fill(Infinity);
      const used = new Array(n + 1).fill(false);
      do {
        used[j0] = true;
        const i0 = p[j0];
        let delta = Infinity, j1 = 0;
        for (let j = 1; j <= n; j++) {
          if (used[j]) continue;
          const cur = a[i0 - 1][j - 1] - u[i0] - v[j];
          if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
          if (minv[j] < delta) { delta = minv[j]; j1 = j; }
        }
        for (let j = 0; j <= n; j++) {
          if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
        }
        j0 = j1;
      } while (p[j0] !== 0);
      do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
    }
    let cost = 0;
    for (let j = 1; j <= n; j++) cost += a[p[j] - 1][j - 1];
    return cost;
  }

  function createProblem(targetFen) {
    const targetArr = arrFromFen(targetFen);
    const targetTurn = targetFen.split(' ')[1] || 'w';
    const tgt = {}, tgtCount = {};
    for (const ch of CHARS) { tgt[ch] = []; }
    targetArr.forEach((p, i) => { if (p) tgt[p].push(i); });
    for (const ch of CHARS) tgtCount[ch] = tgt[ch].length;
    const tgtTotal = { w: 0, b: 0 };
    for (const ch of CHARS) tgtTotal[ch < 'a' ? 'w' : 'b'] += tgtCount[ch];

    // Cost of moving all pieces of one kind (e.g. white knights) to their target squares.
    function charCost(arr, ch) {
      const cur = [];
      for (let i = 0; i < 64; i++) if (arr[i] === ch) cur.push(i);
      const targets = tgt[ch];
      const n = Math.max(cur.length, targets.length);
      if (n === 0) return 0;
      const type = ch.toLowerCase(), white = ch < 'a';
      if (cur.length === 1 && targets.length === 1) return pieceDistance(type, white, cur[0], targets[0]);
      const m = [];
      for (let i = 0; i < n; i++) {
        const row = [];
        for (let j = 0; j < n; j++) {
          if (i >= cur.length) row.push(PROMOTION_COST);   // target piece must come from a promotion
          else if (j >= targets.length) row.push(0);      // extra piece: will be captured
          else row.push(pieceDistance(type, white, cur[i], targets[j]));
        }
        m.push(row);
      }
      return hungarian(m, n);
    }

    function feasible(counts) {
      for (const color of ['w', 'b']) {
        const up = color === 'w';
        const P = up ? 'P' : 'p';
        const surplus = counts[P] - tgtCount[P];
        if (surplus < 0) return false;
        let deficit = 0, total = 0;
        for (const ch of (up ? 'PNBRQK' : 'pnbrqk')) {
          total += counts[ch];
          if (ch !== P) deficit += Math.max(0, tgtCount[ch] - counts[ch]);
        }
        if (deficit > surplus) return false;
        if (total < tgtTotal[color]) return false;
      }
      return true;
    }

    function score(node) {
      if (!feasible(node.counts)) return INF;
      let h = 0;
      for (const ch of CHARS) {
        if (node.costs[ch] >= BIG) return INF;
        h += node.costs[ch];
      }
      let totalW = 0, totalB = 0;
      for (const ch of CHARS) { if (ch < 'a') totalW += node.counts[ch]; else totalB += node.counts[ch]; }
      // Remaining captures: each costs the capturing side the detour needed to take a victim.
      if (totalB > tgtTotal.b) h += captureCost(node, true);
      if (totalW > tgtTotal.w) h += captureCost(node, false);
      return h;
    }

    function minDistToTargets(ch, sq) {
      const targets = tgt[ch];
      if (!targets.length) return 0; // this piece has nowhere to be; it will be captured itself
      const type = ch.toLowerCase(), white = ch < 'a';
      let best = BIG;
      for (const t of targets) { const d = pieceDistance(type, white, sq, t); if (d < best) best = d; }
      return best;
    }

    // For each kind of enemy piece that must still be captured, add the cheapest detours:
    // attacker goes to the victim, then on to its own target, minus the trip it needs anyway.
    function captureCost(node, byWhite) {
      const arr = node.arr;
      const attackers = [];
      for (let i = 0; i < 64; i++) {
        const p = arr[i];
        if (p && isWhite(p) === byWhite) attackers.push({ sq: i, ch: p, base: minDistToTargets(p, i) });
      }
      let sum = 0;
      for (const vch of (byWhite ? 'pnbrq' : 'PNBRQ')) {
        const surplus = node.counts[vch] - tgtCount[vch];
        if (surplus <= 0) continue;
        const d = [];
        for (let v = 0; v < 64; v++) {
          if (arr[v] !== vch) continue;
          let best = BIG;
          for (const a of attackers) {
            const t = a.ch.toLowerCase();
            let reach;
            if (t === 'p') {
              const adv = byWhite ? (a.sq >> 3) - (v >> 3) : (v >> 3) - (a.sq >> 3);
              reach = adv >= 1 && Math.abs((a.sq & 7) - (v & 7)) <= adv ? adv : BIG;
            } else if (t === 'k') {
              reach = pieceDistance('k', byWhite, a.sq, v);
            } else reach = pieceDistance(t, byWhite, a.sq, v);
            if (reach >= BIG) continue;
            const detour = Math.max(1, reach) + minDistToTargets(a.ch, v) - a.base;
            if (detour < best) best = detour;
          }
          d.push(Math.max(1, Math.min(best, 10)));
        }
        d.sort((x, y) => x - y);
        for (let i = 0; i < surplus; i++) sum += i < d.length ? d[i] : 10;
      }
      return sum;
    }

    function rootNode() {
      const arr = arrFromFen(START_FEN);
      const costs = {}, counts = {};
      for (const ch of CHARS) { costs[ch] = charCost(arr, ch); counts[ch] = 0; }
      arr.forEach(p => { if (p) counts[p]++; });
      const node = { arr, costs, counts, turn: 'w', castling: 15, ep: -1, parent: null, move: null };
      node.h = score(node);
      return node;
    }

    function childNode(parent, c) {
      const m = c.move;
      const costs = Object.assign({}, parent.costs);
      const counts = Object.assign({}, parent.counts);
      const affected = [m.piece];
      if (m.promo) {
        counts[m.piece]--; counts[m.promo]++;
        affected.push(m.promo);
      }
      if (m.captured) {
        counts[m.captured]--;
        affected.push(m.captured);
      }
      if (m.flag === 'k' || m.flag === 'q') affected.push(parent.turn === 'w' ? 'R' : 'r');
      for (const ch of affected) costs[ch] = charCost(c.arr, ch);
      const node = {
        arr: c.arr, costs, counts, turn: parent.turn === 'w' ? 'b' : 'w',
        castling: c.castling, ep: c.ep, parent, move: m,
      };
      node.h = score(node);
      return node;
    }

    return { targetArr, targetKey: placementKey(targetArr) + targetTurn, rootNode, childNode };
  }

  function nodeKey(node) {
    return placementKey(node.arr) + node.turn;
  }

  // Replays the found line with chess.js to double-check legality and get move names (SAN).
  function pathOf(node) {
    const moves = [];
    for (let n = node; n.parent; n = n.parent) moves.push(n.move);
    moves.reverse();
    const chess = new Chess();
    const fens = [chess.fen()];
    const line = [];
    for (const m of moves) {
      const done = chess.move({ from: nameOf(m.from), to: nameOf(m.to), promotion: m.promo ? m.promo.toLowerCase() : undefined });
      if (!done) throw new Error('Internal error: illegal move in found line');
      line.push({ san: done.san, from: done.from, to: done.to });
      fens.push(chess.fen());
    }
    return { moves: line, fens };
  }

  // One beam-search attempt. Returns the solution node or null.
  function beamSearch(problem, opts, onProgress) {
    const beam = opts.beamWidth;
    const noise = opts.noise || 0;
    const rand = mulberry32(opts.seed || 1);
    const root = problem.rootNode();
    if (root.h >= INF) return { node: null, reason: 'unreachable' };
    let layer = [root];
    const seen = new Set([nodeKey(root)]);
    let bestEver = root.h, stall = 0, closest = root;

    for (let ply = 0; ply <= opts.maxPly; ply++) {
      for (const node of layer) {
        if (node.h === 0 && nodeKey(node) === problem.targetKey) return { node };
      }
      if (ply === opts.maxPly) break;
      if (opts.shouldStop && opts.shouldStop()) return { node: null, reason: 'cancelled', closest };

      const candidates = new Map();
      for (const node of layer) {
        for (const c of legalChildren(node)) {
          const child = problem.childNode(node, c);
          if (child.h >= INF) continue;
          const key = nodeKey(child);
          if (seen.has(key)) continue;
          child.rank = child.h + rand() * noise;
          const prev = candidates.get(key);
          if (!prev || child.rank < prev.rank) candidates.set(key, child);
        }
      }
      if (!candidates.size) return { node: null, reason: 'dead-end', closest };

      // Keep the best children, but at most a few per parent first so the beam stays varied.
      const sorted = Array.from(candidates.entries()).sort((a, b) => a[1].rank - b[1].rank);
      const perParent = new Map();
      const keep = [], overflow = [];
      for (const entry of sorted) {
        const n = perParent.get(entry[1].parent) || 0;
        if (n < opts.perParent) { perParent.set(entry[1].parent, n + 1); keep.push(entry); }
        else overflow.push(entry);
        if (keep.length >= beam) break;
      }
      for (let i = 0; keep.length < beam && i < overflow.length; i++) keep.push(overflow[i]);
      keep.sort((a, b) => a[1].rank - b[1].rank);
      layer = [];
      for (const [key, child] of keep) {
        seen.add(key);
        layer.push(child);
      }

      const best = layer[0].h;
      if (best < bestEver) { bestEver = best; closest = layer[0]; stall = 0; } else stall++;
      if (onProgress) onProgress({ ply: ply + 1, best });
      if (stall > opts.maxStall) return { node: null, reason: 'stalled', closest };
    }
    return { node: null, reason: 'too-long', closest };
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // Runs several differently-randomised attempts to collect distinct move sequences.
  function solve(targetFen, opts, callbacks) {
    const problem = createProblem(targetFen);
    const attempts = opts.attempts;
    const found = [];
    const seenLines = new Set();
    let lastReason = null, closest = null;
    for (let i = 0; i < attempts.length && found.length < opts.maxSolutions; i++) {
      const a = attempts[i];
      const res = beamSearch(problem, {
        beamWidth: a.beamWidth, noise: a.noise, seed: i * 7919 + 13, perParent: a.perParent || 4,
        maxPly: opts.maxPly, maxStall: opts.maxStall, shouldStop: opts.shouldStop,
      }, p => callbacks.progress && callbacks.progress(Object.assign({ attempt: i + 1, attempts: attempts.length }, p)));
      if (!res.node) {
        lastReason = res.reason;
        if (res.closest && (!closest || res.closest.h < closest.h)) closest = res.closest;
        if (res.reason === 'unreachable' || res.reason === 'cancelled') break;
        continue;
      }
      const path = pathOf(res.node);
      const sig = path.moves.map(m => m.san).join(' ');
      if (seenLines.has(sig)) continue;
      seenLines.add(sig);
      found.push(path);
      if (callbacks.solution) callbacks.solution(path, found.length);
    }
    const result = { solutions: found, reason: found.length ? null : lastReason };
    if (!found.length && closest && closest.parent) {
      result.closest = pathOf(closest);
      result.closest.distance = closest.h;
    }
    return result;
  }

  return { solve, START_FEN };
}

if (typeof module !== 'undefined') module.exports = searchCoreFactory;
