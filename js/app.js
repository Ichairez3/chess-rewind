(() => {
  const CHESS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.10.3/chess.min.js';
  const SEARCH_OPTIONS = {
    maxSolutions: 3,
    maxPly: 200,
    maxStall: 30,
    attempts: [
      { beamWidth: 300, noise: 0.5 },
      { beamWidth: 300, noise: 1.5 },
      { beamWidth: 1000, noise: 0.8 },
      { beamWidth: 3000, noise: 1 },
    ],
  };

  const $ = id => document.getElementById(id);

  // ================= Step 1: image =================
  let image = null;      // HTMLImageElement
  let corners = null;    // [{x,y}] TL, TR, BR, BL in image pixels
  const canvas = $('imageCanvas');
  const wrap = $('imageWrap');
  const handles = [];

  function loadFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => setImage(img);
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  function setImage(img) {
    image = img;
    const scale = Math.min(1, 1400 / img.naturalWidth);
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    $('drop').hidden = true;
    $('imageStage').hidden = false;
    Recognizer.resetTeaching();
    clearResults();
    detectBoard();
    readPieces(null);
  }

  function detectBoard() {
    const res = Recognizer.autoDetect(image);
    corners = res.corners;
    drawImage();
    if (res.confidence < 1.2) {
      setMsg('Could not find the board clearly. Drag the corner dots onto the board corners, then press "Read pieces".', 'error');
    }
  }

  function drawImage() {
    const ctx = canvas.getContext('2d');
    const k = canvas.width / image.naturalWidth;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    if (!corners) return;
    const H = Recognizer.homography(corners);
    ctx.strokeStyle = 'rgba(60, 220, 110, 0.9)';
    ctx.lineWidth = Math.max(1.5, canvas.width / 400);
    ctx.beginPath();
    for (let i = 0; i <= 8; i++) {
      const a = H(i, 0), b = H(i, 8), c = H(0, i), d = H(8, i);
      ctx.moveTo(a[0] * k, a[1] * k); ctx.lineTo(b[0] * k, b[1] * k);
      ctx.moveTo(c[0] * k, c[1] * k); ctx.lineTo(d[0] * k, d[1] * k);
    }
    ctx.stroke();
    corners.forEach((p, i) => {
      handles[i].style.left = (p.x / image.naturalWidth * 100) + '%';
      handles[i].style.top = (p.y / image.naturalHeight * 100) + '%';
    });
  }

  for (let i = 0; i < 4; i++) {
    const h = document.createElement('div');
    h.className = 'handle';
    h.addEventListener('pointerdown', e => {
      e.preventDefault();
      h.setPointerCapture(e.pointerId);
      const move = ev => {
        const r = wrap.getBoundingClientRect();
        corners[i] = {
          x: Math.min(Math.max((ev.clientX - r.left) / r.width, 0), 1) * image.naturalWidth,
          y: Math.min(Math.max((ev.clientY - r.top) / r.height, 0), 1) * image.naturalHeight,
        };
        drawImage();
      };
      const up = () => {
        h.removeEventListener('pointermove', move);
        h.removeEventListener('pointerup', up);
      };
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up);
    });
    wrap.appendChild(h);
    handles.push(h);
  }

  function readPieces(flippedOverride) {
    const res = Recognizer.read(image, corners, flippedOverride);
    $('flippedCheck').checked = res.flipped;
    manualEdits = {};
    setEditorPosition(res.position);
    $('rereadBtn').disabled = true;
    $('rereadBtn').textContent = 'Re-read using my fixes';
    setMsg('Pieces read from the image. Check every square and fix any mistakes; after a few fixes, "Re-read using my fixes" can correct similar squares.', 'ok');
    $('editorCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  const drop = $('drop');
  $('fileInput').addEventListener('change', e => loadFile(e.target.files[0]));
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); loadFile(e.dataTransfer.files[0]); });
  window.addEventListener('paste', e => {
    const item = Array.from(e.clipboardData.items).find(it => it.type.startsWith('image/'));
    if (item) loadFile(item.getAsFile());
  });
  $('detectBtn').addEventListener('click', () => { detectBoard(); readPieces(null); });
  $('readBtn').addEventListener('click', () => readPieces(null));
  $('flippedCheck').addEventListener('change', e => {
    if (!Recognizer.hasRead()) return;
    const res = Recognizer.reread(e.target.checked);
    manualEdits = {};
    setEditorPosition(res.position);
  });
  $('newImageBtn').addEventListener('click', () => {
    $('imageStage').hidden = true;
    $('drop').hidden = false;
    $('fileInput').value = '';
  });

  // ================= Step 2: editor =================
  let manualEdits = {};      // idx -> piece set by the user (kept when re-reading)
  let selectedPiece = 'P';
  const editor = createBoard($('editorBoard'), { onSquare: onEditorSquare });

  const palette = $('palette');
  ['K', 'Q', 'R', 'B', 'N', 'P', 'k', 'q', 'r', 'b', 'n', 'p', ''].forEach(p => {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = p ? pieceHtml(p) : '&#x2715;';
    b.title = p ? (p === p.toUpperCase() ? 'White ' : 'Black ') + { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' }[p.toLowerCase()] : 'Eraser';
    b.addEventListener('click', () => {
      selectedPiece = p;
      palette.querySelectorAll('button').forEach(x => x.classList.toggle('sel', x === b));
    });
    if (p === selectedPiece) b.classList.add('sel');
    palette.appendChild(b);
  });

  function onEditorSquare(idx, button) {
    const pos = editor.getPosition();
    let piece = button === 'right' ? '' : selectedPiece;
    if (button === 'left' && pos[idx] === piece) piece = '';
    pos[idx] = piece;
    manualEdits[idx] = piece;
    if (piece) Recognizer.teach(idx, piece);
    if (Recognizer.hasRead() && Recognizer.taughtCount()) {
      $('rereadBtn').disabled = false;
      $('rereadBtn').textContent = `Re-read using my fixes (${Recognizer.taughtCount()})`;
    }
    setEditorPosition(pos);
  }

  function setEditorPosition(pos) {
    editor.setPosition(pos);
    $('fenInput').value = positionToFen(pos, getTurn());
    const problem = validatePosition(pos, getTurn());
    if (problem) setMsg(problem, 'error');
    else if ($('editorMsg').classList.contains('error')) setMsg('', '');
  }

  function getTurn() {
    return document.querySelector('input[name="turn"]:checked').value;
  }

  document.querySelectorAll('input[name="turn"]').forEach(r => r.addEventListener('change', () => setEditorPosition(editor.getPosition())));
  $('rereadBtn').addEventListener('click', () => {
    const res = Recognizer.reread($('flippedCheck').checked);
    const pos = res.position;
    for (const idx in manualEdits) pos[idx] = manualEdits[idx];
    setEditorPosition(pos);
    setMsg('Re-read the image using your corrections.', 'ok');
  });
  $('startPosBtn').addEventListener('click', () => { manualEdits = {}; setEditorPosition(START_POSITION); });
  $('clearBtn').addEventListener('click', () => { manualEdits = {}; setEditorPosition(new Array(64).fill('')); });
  $('fenLoadBtn').addEventListener('click', () => {
    const parts = $('fenInput').value.trim().split(/\s+/);
    const pos = placementToPosition(parts[0] || '');
    if (!pos) { setMsg('That FEN could not be read.', 'error'); return; }
    if (parts[1] === 'w' || parts[1] === 'b') document.querySelector(`input[name="turn"][value="${parts[1]}"]`).checked = true;
    manualEdits = {};
    setEditorPosition(pos);
  });

  function setMsg(text, kind) {
    const m = $('editorMsg');
    m.textContent = text;
    m.className = 'message ' + (kind || '');
  }

  // Returns a human-readable problem, or null if the position could be legal.
  function validatePosition(pos, turn) {
    const count = ch => pos.filter(p => p === ch).length;
    for (const [K, name] of [['K', 'White'], ['k', 'Black']]) {
      if (count(K) !== 1) return `${name} must have exactly one king (found ${count(K)}).`;
    }
    for (const side of [['PNBRQ', 'White'], ['pnbrq', 'Black']]) {
      const [chars, name] = side;
      const pawns = count(chars[0]);
      if (pawns > 8) return `${name} has more than 8 pawns.`;
      const extra = Math.max(0, count(chars[1]) - 2) + Math.max(0, count(chars[2]) - 2) + Math.max(0, count(chars[3]) - 2) + Math.max(0, count(chars[4]) - 1);
      if (pawns + extra > 8) return `${name} has too many pieces to be possible (extra pieces come from promoted pawns).`;
    }
    const isPawn = p => p === 'P' || p === 'p';
    for (let i = 0; i < 8; i++) {
      if (isPawn(pos[i]) || isPawn(pos[56 + i])) return 'Pawns cannot stand on the first or last rank.';
    }
    const other = new Chess();
    if (other.load(positionToFen(pos, turn === 'w' ? 'b' : 'w')) && other.in_check()) {
      return `${turn === 'w' ? 'Black' : 'White'} is in check but it is ${turn === 'w' ? 'White' : 'Black'}'s turn, which is impossible. Check the side to move.`;
    }
    return null;
  }

  // ================= Step 3: search =================
  let worker = null;
  let solutions = [];       // [{moves, fens, closest?}]
  let solutionIdx = 0;
  let startBest = null;

  function clearResults() {
    stopPlay();
    finishSearch();
    solutions = [];
    renderSolutions();
    $('replay').hidden = true;
    setStatus('');
  }

  function startSearch() {
    const pos = editor.getPosition();
    const turn = getTurn();
    const problem = validatePosition(pos, turn);
    if (problem) { setMsg(problem, 'error'); $('editorCard').scrollIntoView({ behavior: 'smooth' }); return; }
    clearResults();
    const fen = positionToFen(pos, turn);
    const code = `importScripts('${CHESS_URL}');
const searchCoreFactory = ${searchCoreFactory.toString()};
const core = searchCoreFactory(Chess);
onmessage = e => {
  let last = 0;
  const res = core.solve(e.data.fen, e.data.opts, {
    progress: p => { const now = Date.now(); if (now - last > 120) { last = now; postMessage({ type: 'progress', p }); } },
    solution: path => postMessage({ type: 'solution', path }),
  });
  postMessage({ type: 'done', res });
};`;
    worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })));
    worker.onmessage = e => onWorkerMessage(e.data);
    worker.onerror = e => { setStatus('Search failed: ' + (e.message || 'unknown error')); finishSearch(); };
    worker.postMessage({ fen, opts: SEARCH_OPTIONS });
    startBest = null;
    $('solveBtn').disabled = true;
    $('cancelBtn').hidden = false;
    $('progress').hidden = false;
    $('progressBar').style.width = '0';
    setStatus('Searching for a move sequence…');
  }

  function onWorkerMessage(msg) {
    if (msg.type === 'progress') {
      const p = msg.p;
      if (startBest === null || p.ply === 1) startBest = Math.max(1, p.best + 1);
      const frac = Math.min(1, Math.max(0, 1 - p.best / startBest));
      $('progressBar').style.width = (((p.attempt - 1) + frac) / p.attempts * 100) + '%';
      setStatus(`Try ${p.attempt} of ${p.attempts} · ${p.ply} half-moves in · about ${p.best} steps from your position` +
        (solutions.length ? ` · ${solutions.length} found so far` : ''));
    } else if (msg.type === 'solution') {
      solutions.push(msg.path);
      renderSolutions();
      if (solutions.length === 1) showSolution(0);
    } else if (msg.type === 'done') {
      finishSearch();
      const res = msg.res;
      if (solutions.length) {
        setStatus(`Found ${solutions.length} way${solutions.length > 1 ? 's' : ''} to reach this position.`);
      } else if (res.closest) {
        res.closest.closest = true;
        solutions.push(res.closest);
        renderSolutions();
        showSolution(0);
        setStatus(`Could not reach the exact position (it may be from a long game, or a square may be wrong). Showing the closest line found, ${res.closest.distance} steps away.`);
      } else {
        setStatus(res.reason === 'unreachable'
          ? 'This position cannot be reached from the normal start (check the pieces, e.g. a pawn that could never get there).'
          : 'No move sequence found. Check the position and side to move, then try again.');
      }
    }
  }

  function stopSearch() {
    if (worker) { worker.terminate(); worker = null; }
  }

  function finishSearch() {
    stopSearch();
    $('solveBtn').disabled = false;
    $('cancelBtn').hidden = true;
    $('progress').hidden = true;
  }

  function setStatus(t) { $('solveStatus').textContent = t; }

  $('solveBtn').addEventListener('click', startSearch);
  $('cancelBtn').addEventListener('click', () => {
    finishSearch();
    setStatus(solutions.length ? `Stopped. ${solutions.length} found.` : 'Stopped.');
  });

  function renderSolutions() {
    const el = $('solutions');
    el.innerHTML = '';
    solutions.forEach((s, i) => {
      const b = document.createElement('button');
      b.className = 'btn' + (i === solutionIdx ? ' sel' : '');
      const n = Math.ceil(s.moves.length / 2);
      b.textContent = s.closest ? `Closest try (${n} moves)` : `Way ${i + 1} · ${n} move${n === 1 ? '' : 's'}`;
      b.addEventListener('click', () => showSolution(i));
      el.appendChild(b);
    });
  }

  // ================= Replay =================
  const replayBoard = createBoard($('replayBoard'));
  let ply = 0;
  let playTimer = null;

  function showSolution(i) {
    solutionIdx = i;
    renderSolutions();
    $('replay').hidden = false;
    renderMoveList();
    goTo(0);
  }

  function renderMoveList() {
    const list = $('moveList');
    list.innerHTML = '';
    const moves = solutions[solutionIdx].moves;
    for (let i = 0; i < moves.length; i += 2) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="num">${i / 2 + 1}.</span>`;
      for (const j of [i, i + 1]) {
        const span = document.createElement('span');
        span.className = 'mv';
        if (moves[j]) {
          span.textContent = moves[j].san;
          span.dataset.ply = j + 1;
          span.addEventListener('click', () => { stopPlay(); goTo(j + 1); });
        }
        li.appendChild(span);
      }
      list.appendChild(li);
    }
  }

  function goTo(n) {
    const sol = solutions[solutionIdx];
    ply = Math.max(0, Math.min(n, sol.moves.length));
    const fen = sol.fens[ply];
    replayBoard.setPosition(placementToPosition(fen));
    const mv = sol.moves[ply - 1];
    replayBoard.setHighlights(mv ? [squareIndex(mv.from), squareIndex(mv.to)] : []);

    let info;
    if (ply === 0) info = 'Starting position';
    else info = `${Math.ceil(ply / 2)}. ${ply % 2 ? 'White' : 'Black'} plays ${mv.san}`;
    if (ply === sol.moves.length) info += sol.closest ? '  (closest found)' : '  ✓ your position';
    $('moveInfo').textContent = info;

    document.querySelectorAll('#moveList .mv').forEach(s => s.classList.toggle('cur', +s.dataset.ply === ply));
    const cur = document.querySelector('#moveList .mv.cur');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
    $('nextBtn').disabled = ply >= sol.moves.length;
    $('prevBtn').disabled = ply === 0;
    evaluate(fen);
  }

  function squareIndex(name) {
    return (8 - +name[1]) * 8 + (name.charCodeAt(0) - 97);
  }

  $('firstBtn').addEventListener('click', () => { stopPlay(); goTo(0); });
  $('prevBtn').addEventListener('click', () => { stopPlay(); goTo(ply - 1); });
  $('nextBtn').addEventListener('click', () => { stopPlay(); goTo(ply + 1); });
  $('lastBtn').addEventListener('click', () => { stopPlay(); goTo(Infinity); });
  $('flipBtn').addEventListener('click', () => {
    replayBoard.setFlipped(!replayBoard.isFlipped());
    $('evalBar').classList.toggle('flipped', replayBoard.isFlipped());
  });
  $('playBtn').addEventListener('click', () => {
    if (playTimer) { stopPlay(); return; }
    if (ply >= solutions[solutionIdx].moves.length) goTo(0);
    $('playBtn').textContent = 'Pause';
    playTimer = setInterval(() => {
      if (ply >= solutions[solutionIdx].moves.length) { stopPlay(); return; }
      goTo(ply + 1);
    }, 1100);
  });
  function stopPlay() {
    clearInterval(playTimer);
    playTimer = null;
    $('playBtn').textContent = 'Auto-play';
  }

  document.addEventListener('keydown', e => {
    if ($('replay').hidden || e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowRight') { stopPlay(); goTo(ply + 1); }
    else if (e.key === 'ArrowLeft') { stopPlay(); goTo(ply - 1); }
    else if (e.key === 'Home') { stopPlay(); goTo(0); }
    else if (e.key === 'End') { stopPlay(); goTo(Infinity); }
    else return;
    e.preventDefault();
  });

  // ================= Evaluation bar =================
  function evaluate(fen) {
    const chess = new Chess(fen);
    if (chess.in_checkmate()) {
      setEval({ mate: chess.turn() === 'w' ? -0 : 0, mated: chess.turn() });
      $('engineLine').textContent = 'Checkmate';
      return;
    }
    if (chess.in_draw() || chess.in_stalemate()) {
      setEval({ cp: 0 });
      $('engineLine').textContent = 'Draw';
      return;
    }
    $('engineLine').textContent = 'Stockfish is thinking…';
    const ok = Engine.evaluate(fen, info => {
      setEval(info);
      let best = '';
      if (info.bestMove) {
        const c = new Chess(fen);
        const m = c.move({ from: info.bestMove.slice(0, 2), to: info.bestMove.slice(2, 4), promotion: info.bestMove[4] });
        if (m) best = ` · best move here: ${m.san}`;
      }
      $('engineLine').textContent = `Stockfish depth ${info.depth}${best}`;
    });
    if (!ok) $('engineLine').textContent = 'Evaluation unavailable (Stockfish could not load).';
  }

  function setEval(info) {
    let whitePct, text;
    if (info.mated) {
      whitePct = info.mated === 'w' ? 0 : 100;
      text = '#';
    } else if (info.mate !== null && info.mate !== undefined) {
      whitePct = info.mate > 0 ? 100 : 0;
      text = 'M' + Math.abs(info.mate);
    } else {
      const cp = info.cp;
      whitePct = 50 + 50 * (2 / (1 + Math.exp(-0.004 * cp)) - 1);
      text = (Math.abs(cp) / 100).toFixed(1);
    }
    $('evalWhite').style.height = whitePct + '%';
    $('evalText').textContent = text;
    $('evalBar').classList.toggle('black-better', whitePct < 50);
    $('evalBar').title = whitePct >= 50 ? `White is better (${text})` : `Black is better (${text})`;
  }

  // Initial state: an empty editor with the starting position.
  setEditorPosition(START_POSITION);
})();
