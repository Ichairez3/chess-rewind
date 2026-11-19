// Reads a chess position from an image, entirely in the browser (no AI service).
//
//  1. Find the board: automatic for screenshots (search for an 8x8 checker pattern),
//     or the user drags the 4 corners (needed for angled photos).
//  2. Warp each of the 64 squares into a small patch using a perspective transform.
//  3. For every patch, separate the piece from the square colour, fill the outline into
//     a silhouette, and decide: empty or occupied, white or black (brightness).
//  4. Guess the piece type from shape features (width profile, spikes on top, asymmetry)
//     compared with typical values for each piece. When the user corrects a square, that square becomes a new reference
//     ("teaching"), so re-reading gets much better after a few fixes.
const Recognizer = (() => {
  const PATCH = 56;       // pixels per square patch
  const TYPES = ['k', 'q', 'r', 'b', 'n', 'p'];
  const GLYPHS = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };

  let refShapes = null;   // example features for each piece type
  let taught = [];        // features + {type, color} of squares the user corrected
  let lastRead = null;    // features of the last image read, per board square

  // ---------- image helpers ----------
  function imageData(img, maxSide) {
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    return { data: ctx.getImageData(0, 0, w, h).data, w, h, scale };
  }

  // ---------- 1. automatic board detection (axis-aligned boards) ----------
  // Integral image of brightness, for constant-time rectangle averages.
  function brightnessIntegral(img) {
    const { w, h, data } = img;
    const W = w + 1;
    const integ = new Float64Array(W * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        row += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        integ[(y + 1) * W + x + 1] = integ[y * W + x + 1] + row;
      }
    }
    return (x0, y0, x1, y1) => {
      x0 = Math.max(0, Math.min(w, Math.round(x0))); x1 = Math.max(x0 + 1, Math.min(w, Math.round(x1)));
      y0 = Math.max(0, Math.min(h, Math.round(y0))); y1 = Math.max(y0 + 1, Math.min(h, Math.round(y1)));
      return (integ[y1 * W + x1] - integ[y0 * W + x1] - integ[y1 * W + x0] + integ[y0 * W + x0]) / ((x1 - x0) * (y1 - y0));
    };
  }

  // How much a candidate square region looks like an 8x8 checkerboard.
  // Each square is sampled at its 4 corners (pieces are usually in the middle) and the
  // median is used, so coordinate labels or a piece in one corner don't matter.
  function checkerScore(mean, x, y, s) {
    const sq = s / 8, p = 0.18 * sq;
    let sumA = 0, sumB = 0, sqA = 0, sqB = 0;
    const lo = 0.06 * sq, hi = 0.76 * sq;
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const x0 = x + f * sq, y0 = y + r * sq;
        const a = mean(x0 + lo, y0 + lo, x0 + lo + p, y0 + lo + p);
        const b = mean(x0 + hi, y0 + lo, x0 + hi + p, y0 + lo + p);
        const c = mean(x0 + lo, y0 + hi, x0 + lo + p, y0 + hi + p);
        const d = mean(x0 + hi, y0 + hi, x0 + hi + p, y0 + hi + p);
        // Median of the four corner samples.
        const m = (a + b + c + d - Math.min(a, b, c, d) - Math.max(a, b, c, d)) / 2;
        if ((r + f) & 1) { sumB += m; sqB += m * m; } else { sumA += m; sqA += m * m; }
      }
    }
    const mA = sumA / 32, mB = sumB / 32;
    const sA = Math.sqrt(Math.max(0, sqA / 32 - mA * mA)), sB = Math.sqrt(Math.max(0, sqB / 32 - mB * mB));
    return Math.abs(mA - mB) / (sA + sB + 4);
  }

  // Sharpness of the 7 inner grid lines in each direction: brightness should jump across them.
  function edgeScore(mean, x, y, s) {
    const sq = s / 8, t = Math.max(1, sq * 0.06), len = sq * 0.15;
    let total = 0;
    for (let i = 1; i < 8; i++) {
      const lx = x + i * sq, ly = y + i * sq;
      for (let j = 0; j < 8; j++) {
        for (const o of [0.05, 0.8]) {
          const a = y + (j + o) * sq, b = x + (j + o) * sq;
          total += Math.abs(mean(lx - t, a, lx, a + len) - mean(lx, a, lx + t, a + len));
          total += Math.abs(mean(b, ly - t, b + len, ly) - mean(b, ly, b + len, ly + t));
        }
      }
    }
    return total / (7 * 8 * 2 * 2);
  }

  function autoDetect(img) {
    // Coarse search on a small copy of the image.
    const small = imageData(img, 160);
    const meanS = brightnessIntegral(small);
    const minSide = Math.min(small.w, small.h);
    let best = { score: -1 };
    for (let s = Math.floor(minSide * 0.3); s <= minSide; s += 2) {
      for (let y = 0; y + s <= small.h; y += 2) {
        for (let x = 0; x + s <= small.w; x += 2) {
          // Tiny preference for bigger boards so a 7x7 sub-grid never wins over the full board.
          const sc = checkerScore(meanS, x, y, s) * (1 + s / minSide * 0.05);
          if (sc > best.score) best = { score: sc, x, y, s };
        }
      }
    }
    const confidence = best.score;

    // Fine search on a larger copy: line up the grid lines exactly.
    const big = imageData(img, 900);
    const meanB = brightnessIntegral(big);
    const k = big.scale / small.scale;
    let bx = best.x * k, by = best.y * k, bs = best.s * k;
    let bestFine = -1;
    for (const step of [4, 2, 1]) {
      const cx = bx, cy = by, cs = bs;
      for (let ds = -3 * step; ds <= 3 * step; ds += step) {
        for (let dy = -3 * step; dy <= 3 * step; dy += step) {
          for (let dx = -3 * step; dx <= 3 * step; dx += step) {
            const s = cs + ds, x = cx + dx, y = cy + dy;
            if (s < 32 || x < -1 || y < -1 || x + s > big.w + 1 || y + s > big.h + 1) continue;
            const sc = edgeScore(meanB, x, y, s) * checkerScore(meanB, x, y, s);
            if (sc > bestFine) { bestFine = sc; bx = x; by = y; bs = s; }
          }
        }
      }
    }
    const x0 = bx / big.scale, y0 = by / big.scale, side = bs / big.scale;
    return {
      corners: [{ x: x0, y: y0 }, { x: x0 + side, y: y0 }, { x: x0 + side, y: y0 + side }, { x: x0, y: y0 + side }],
      confidence,
    };
  }

  // ---------- 2. perspective transform ----------
  // Homography mapping board coords (u,v in 0..8) to image pixels, from 4 corners (TL, TR, BR, BL).
  function homography(corners) {
    const src = [[0, 0], [8, 0], [8, 8], [0, 8]];
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [u, v] = src[i], { x, y } = corners[i];
      A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
      A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
    }
    const hvec = solveLinear(A, b);
    return (u, v) => {
      const d = hvec[6] * u + hvec[7] * v + 1;
      return [(hvec[0] * u + hvec[1] * v + hvec[2]) / d, (hvec[3] * u + hvec[4] * v + hvec[5]) / d];
    };
  }

  function solveLinear(A, b) {
    const n = b.length;
    const M = A.map((row, i) => row.concat([b[i]]));
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      [M[c], M[piv]] = [M[piv], M[c]];
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c] / M[c][c];
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    return M.map((row, i) => row[n] / row[i]);
  }

  function samplePatches(img, corners) {
    const src = imageData(img, 1600);
    const k = src.scale;
    const H = homography(corners.map(p => ({ x: p.x * k, y: p.y * k })));
    const patches = [];
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const px = new Float32Array(PATCH * PATCH * 3);
        for (let y = 0; y < PATCH; y++) {
          for (let x = 0; x < PATCH; x++) {
            const [ix, iy] = H(f + (x + 0.5) / PATCH, r + (y + 0.5) / PATCH);
            const rgb = bilinear(src, ix, iy);
            const o = (y * PATCH + x) * 3;
            px[o] = rgb[0]; px[o + 1] = rgb[1]; px[o + 2] = rgb[2];
          }
        }
        patches.push(px);
      }
    }
    return patches;
  }

  function bilinear(img, x, y) {
    const { w, h, data } = img;
    x = Math.min(Math.max(x - 0.5, 0), w - 1.001);
    y = Math.min(Math.max(y - 0.5, 0), h - 1.001);
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const out = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const a = data[(y0 * w + x0) * 4 + c], b = data[(y0 * w + x0 + 1) * 4 + c];
      const d = data[((y0 + 1) * w + x0) * 4 + c], e = data[((y0 + 1) * w + x0 + 1) * 4 + c];
      out[c] = (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
    }
    return out;
  }

  // ---------- 3. silhouette per square ----------
  function median(values) {
    const s = Array.from(values).sort((a, b) => a - b);
    return s[s.length >> 1];
  }

  function analysePatch(px) {
    const N = PATCH, ring = 3;
    const R = [], G = [], B = [];
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        if (x >= ring && x < N - ring && y >= ring && y < N - ring) continue;
        const o = (y * N + x) * 3;
        R.push(px[o]); G.push(px[o + 1]); B.push(px[o + 2]);
      }
    }
    const bg = [median(R), median(G), median(B)];
    const dist = new Float32Array(N * N);
    const ringDist = [];
    for (let i = 0; i < N * N; i++) {
      const dr = px[i * 3] - bg[0], dg = px[i * 3 + 1] - bg[1], db = px[i * 3 + 2] - bg[2];
      dist[i] = Math.sqrt(dr * dr + dg * dg + db * db);
      const x = i % N, y = (i / N) | 0;
      if (!(x >= ring && x < N - ring && y >= ring && y < N - ring)) ringDist.push(dist[i]);
    }
    // Threshold adapts to how noisy (textured) the square itself is.
    const mad = median(ringDist);
    const thr = Math.max(38, mad * 3 + 18);
    // The outermost pixels often contain a sliver of the neighbouring square; ignore them.
    const margin = 2;
    const mask = new Uint8Array(N * N);
    for (let i = 0; i < N * N; i++) {
      const x = i % N, y = (i / N) | 0;
      const edge = x < margin || y < margin || x >= N - margin || y >= N - margin;
      // Board coordinates are printed in the top-left and bottom-right corners of squares.
      const label = (x < N * 0.2 && y < N * 0.24) || (x > N * 0.8 && y > N * 0.76);
      mask[i] = !edge && !label && dist[i] > thr ? 1 : 0;
    }

    // Fill: everything not reachable from the border through background is the piece.
    const outside = new Uint8Array(N * N);
    const stack = [];
    for (let i = 0; i < N; i++) {
      for (const p of [i, (N - 1) * N + i, i * N, i * N + N - 1]) {
        if (!mask[p] && !outside[p]) { outside[p] = 1; stack.push(p); }
      }
    }
    while (stack.length) {
      const p = stack.pop(), x = p % N, y = (p / N) | 0;
      for (const q of [x > 0 ? p - 1 : -1, x < N - 1 ? p + 1 : -1, y > 0 ? p - N : -1, y < N - 1 ? p + N : -1]) {
        if (q >= 0 && !mask[q] && !outside[q]) { outside[q] = 1; stack.push(q); }
      }
    }
    const sil = new Uint8Array(N * N);
    for (let i = 0; i < N * N; i++) sil[i] = outside[i] ? 0 : 1;
    const comp = largestComponent(sil, N);

    let area = 0, central = 0, x0 = N, y0 = N, x1 = -1, y1 = -1;
    const lums = [];
    for (let i = 0; i < N * N; i++) {
      if (!comp[i]) continue;
      area++;
      const x = i % N, y = (i / N) | 0;
      if (x > N * 0.2 && x < N * 0.8 && y > N * 0.2 && y < N * 0.8) central++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      lums.push(0.299 * px[i * 3] + 0.587 * px[i * 3 + 1] + 0.114 * px[i * 3 + 2]);
    }
    const occupied = area / (N * N) > 0.07 && central / ((N * 0.6) ** 2) > 0.12 && (y1 - y0) > N * 0.3;
    if (!occupied) return { occupied: false };
    return {
      occupied: true,
      bright: lums.filter(l => l > 190).length / lums.length,
      ...shapeFeatures(comp, N, [x0, y0, x1, y1]),
    };
  }

  function largestComponent(sil, N) {
    const label = new Int32Array(N * N);
    let best = 0, bestSize = 0, next = 1;
    for (let s = 0; s < N * N; s++) {
      if (!sil[s] || label[s]) continue;
      let size = 0;
      const stack = [s];
      label[s] = next;
      while (stack.length) {
        const p = stack.pop(), x = p % N, y = (p / N) | 0;
        size++;
        for (const q of [x > 0 ? p - 1 : -1, x < N - 1 ? p + 1 : -1, y > 0 ? p - N : -1, y < N - 1 ? p + N : -1]) {
          if (q >= 0 && sil[q] && !label[q]) { label[q] = next; stack.push(q); }
        }
      }
      if (size > bestSize) { bestSize = size; best = next; }
      next++;
    }
    const out = new Uint8Array(N * N);
    for (let i = 0; i < N * N; i++) out[i] = label[i] === best && best ? 1 : 0;
    return out;
  }

  // ---------- 4. piece type ----------
  // Shape features that mean the same thing across piece styles: aspect (width / height),
  // the silhouette's width at 8 heights from top to bottom, how many separate spikes stick
  // up at the top (rook battlements, queen crown), left/right asymmetry (only the knight is
  // lopsided) and how much of the bounding box is filled.
  const PROFILE_AT = [0.04, 0.1, 0.2, 0.3, 0.45, 0.6, 0.75, 0.9];

  // Typical values measured from a common screenshot piece style. Shapes measured from the
  // chess font glyphs are added as a second example of each type.
  const PROTOTYPES = [
    { type: 'p', aspect: 0.72, profile: [0.35, 0.4, 0.38, 0.6, 0.59, 0.66, 0.93, 1], spikes: 1, asym: 0.01, fill: 0.67 },
    { type: 'r', aspect: 0.85, profile: [0.9, 0.9, 0.88, 0.66, 0.6, 0.6, 0.8, 1], spikes: 3, asym: 0.01, fill: 0.77 },
    { type: 'n', aspect: 1.0, profile: [0.33, 0.35, 0.6, 0.72, 0.88, 0.97, 0.95, 0.7], spikes: 2, asym: 0.18, fill: 0.7 },
    { type: 'b', aspect: 0.93, profile: [0.21, 0.21, 0.32, 0.54, 0.61, 0.44, 0.42, 0.99], spikes: 1, asym: 0.01, fill: 0.5 },
    { type: 'q', aspect: 1.03, profile: [0.3, 0.66, 0.98, 0.95, 0.83, 0.76, 0.56, 0.62], spikes: 3.5, asym: 0.04, fill: 0.6 },
    { type: 'k', aspect: 0.91, profile: [0.11, 0.22, 0.16, 0.71, 1, 0.9, 0.71, 0.66], spikes: 1, asym: 0.01, fill: 0.6 },
  ];

  function shapeFeatures(mask, N, box) {
    const [x0, y0, x1, y1] = box;
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const row = y => {
      let a = -1, b = -1, runs = 0, prev = 0;
      for (let x = x0; x <= x1; x++) {
        const v = mask[y * N + x];
        if (v) { if (a < 0) a = x; b = x; if (!prev) runs++; }
        prev = v;
      }
      return { width: a < 0 ? 0 : (b - a + 1) / w, runs };
    };
    const profile = PROFILE_AT.map(t => row(y0 + Math.round(t * (h - 1))).width);
    let spikes = 0;
    for (let t = 0; t < 0.12; t += 0.02) spikes = Math.max(spikes, row(y0 + Math.round(t * (h - 1))).runs);
    let diff = 0, area = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const v = mask[y * N + x];
        area += v;
        diff += Math.abs(v - mask[y * N + (x0 + x1 - x)]);
      }
    }
    return { aspect: w / h, profile, spikes: Math.min(spikes, 5), asym: diff / 2 / Math.max(1, area), fill: area / (w * h) };
  }

  function buildRefShapes() {
    const N = PATCH;
    const c = document.createElement('canvas');
    c.width = N; c.height = N;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    refShapes = PROTOTYPES.slice();
    for (const t of TYPES) {
      ctx.clearRect(0, 0, N, N);
      ctx.fillStyle = '#000';
      ctx.font = `${Math.round(N * 0.9)}px "Segoe UI Symbol", "Noto Sans Symbols 2", "DejaVu Sans", serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // Pieces on real boards have an outline, so draw one here too.
      ctx.strokeStyle = '#000';
      ctx.lineWidth = N * 0.06;
      ctx.strokeText(GLYPHS[t] + '︎', N / 2, N / 2);
      ctx.fillText(GLYPHS[t] + '︎', N / 2, N / 2);
      const d = ctx.getImageData(0, 0, N, N).data;
      const sil = new Uint8Array(N * N);
      let x0 = N, y0 = N, x1 = -1, y1 = -1;
      for (let i = 0; i < N * N; i++) {
        if (d[i * 4 + 3] > 100) {
          sil[i] = 1;
          const x = i % N, y = (i / N) | 0;
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
      if (x1 < 0) continue;
      refShapes.push(Object.assign({ type: t }, shapeFeatures(sil, N, [x0, y0, x1, y1])));
    }
  }

  function featureDistance(a, b) {
    let d = 0;
    for (let i = 0; i < a.profile.length; i++) d += (a.profile[i] - b.profile[i]) ** 2;
    d += (a.aspect - b.aspect) ** 2;
    d += ((a.spikes - b.spikes) * 0.35) ** 2;
    d += ((a.asym - b.asym) * 4) ** 2;
    d += 2 * (a.fill - b.fill) ** 2;
    return Math.sqrt(d);
  }

  function typeScores(feat) {
    const scores = {};
    TYPES.forEach(t => { scores[t] = -Infinity; });
    for (const ref of refShapes) scores[ref.type] = Math.max(scores[ref.type], -featureDistance(feat, ref));
    // User-taught examples come from this very piece set: pieces of the same type look almost
    // identical to them, so a close match wins outright. Loose matches are ignored.
    for (const ex of taught) {
      const d = featureDistance(feat, ex);
      if (d < 0.15) scores[ex.type] = Math.max(scores[ex.type], 1 - d);
    }
    return scores;
  }

  // White pieces have a large share of bright pixels; black pieces only small highlights.
  // (Median brightness fails for sets where white pieces have thick black outlines.)
  function classifyColors(feats) {
    const occ = feats.filter(f => f && f.occupied);
    const tw = taught.filter(t => t.color === 'w'), tb = taught.filter(t => t.color === 'b');
    if (tw.length && tb.length) {
      const mw = tw.reduce((s, t) => s + t.bright, 0) / tw.length;
      const mb = tb.reduce((s, t) => s + t.bright, 0) / tb.length;
      occ.forEach(f => { f.color = Math.abs(f.bright - mw) < Math.abs(f.bright - mb) ? 'w' : 'b'; });
      return;
    }
    const vals = occ.map(f => f.bright).sort((a, b) => a - b);
    // Split at the widest gap between the sorted values (white and black form two groups).
    let split = 0.2, gap = 0;
    for (let i = 1; i < vals.length; i++) {
      if (vals[i] - vals[i - 1] > gap) { gap = vals[i] - vals[i - 1]; split = (vals[i] + vals[i - 1]) / 2; }
    }
    if (gap < 0.06) split = 0.2;   // no clear gap: all pieces may be one colour
    occ.forEach(f => { f.color = f.bright >= split ? 'w' : 'b'; });
  }

  // Board square index (0 = a8) for image square (row, col) given orientation.
  const toBoardIdx = (imgIdx, flipped) => (flipped ? 63 - imgIdx : imgIdx);

  function classifyAll(feats, flippedOverride) {
    const occ = feats.filter(f => f.occupied);
    classifyColors(feats);
    occ.forEach(f => { f.scores = typeScores(f); });

    // Orientation: white pieces usually start near the bottom of the picture.
    let flipped = flippedOverride;
    if (flipped === undefined || flipped === null) {
      let wRow = 0, wN = 0, bRow = 0, bN = 0;
      feats.forEach((f, i) => {
        if (!f.occupied) return;
        if (f.color === 'w') { wRow += i >> 3; wN++; } else { bRow += i >> 3; bN++; }
      });
      flipped = wN && bN ? wRow / wN < bRow / bN : false;
    }

    // Assign types greedily, most confident first, never giving a side more pieces of a type
    // than a normal game has (1 king, 1 queen, 2 rooks/bishops/knights, 8 pawns).
    // Squares the user corrected keep their label. Pawns can't stand on the first/last rank.
    const LIMIT = { k: 1, q: 1, r: 2, b: 2, n: 2, p: 8 };
    const position = new Array(64).fill('');
    const pawnAllowed = idx => idx >= 8 && idx < 56;
    for (const color of ['w', 'b']) {
      const label = t => (color === 'w' ? t.toUpperCase() : t);
      const used = { k: 0, q: 0, r: 0, b: 0, n: 0, p: 0 };
      const options = [], pending = new Set();
      feats.forEach((f, i) => {
        if (!f.occupied || f.color !== color) return;
        const idx = toBoardIdx(i, flipped);
        const ex = taught.find(t => t.imgIdx === i);
        if (ex) { position[idx] = label(ex.type); used[ex.type]++; return; }
        pending.add(i);
        for (const t of TYPES) {
          if (t !== 'p' || pawnAllowed(idx)) options.push({ i, idx, t, s: f.scores[t] });
        }
      });
      options.sort((a, b) => b.s - a.s);
      for (const o of options) {
        if (!pending.has(o.i) || used[o.t] >= LIMIT[o.t]) continue;
        position[o.idx] = label(o.t);
        used[o.t]++;
        pending.delete(o.i);
      }
      // More pieces than the limits allow (promotions): best guess that isn't a second king.
      for (const i of pending) {
        const o = options.find(o => o.i === i && o.t !== 'k');
        position[o.idx] = label(o.t);
      }
    }
    return { position, flipped };
  }

  // ---------- public API ----------
  function read(img, corners, flippedOverride) {
    if (!refShapes) buildRefShapes();
    const patches = samplePatches(img, corners);
    const feats = patches.map(analysePatch);
    const res = classifyAll(feats, flippedOverride);
    lastRead = { feats, flipped: res.flipped };
    return res;
  }

  // Re-run classification on the last image using the user's corrections as examples.
  function reread(flippedOverride) {
    if (!lastRead) return null;
    const res = classifyAll(lastRead.feats, flippedOverride === undefined ? lastRead.flipped : flippedOverride);
    lastRead.flipped = res.flipped;
    return res;
  }

  // The user set board square `idx` to `piece` ('' for empty). Remember it as an example.
  function teach(idx, piece) {
    if (!lastRead || !piece) return;
    const imgIdx = lastRead.flipped ? 63 - idx : idx;
    const f = lastRead.feats[imgIdx];
    if (!f || !f.occupied) return;
    taught = taught.filter(t => t.imgIdx !== imgIdx);
    taught.push(Object.assign({}, f, { imgIdx, type: piece.toLowerCase(), color: piece === piece.toUpperCase() ? 'w' : 'b' }));
  }

  function resetTeaching() { taught = []; }
  function taughtCount() { return taught.length; }
  function hasRead() { return !!lastRead; }

  return { autoDetect, read, reread, teach, resetTeaching, taughtCount, hasRead, homography };
})();
