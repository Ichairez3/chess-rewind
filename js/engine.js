// Stockfish (compiled to JavaScript) running in a Web Worker, used for the evaluation bar.
const Engine = (() => {
  const STOCKFISH_URL = 'https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js';
  const DEPTH = 16;
  let worker = null;
  let busy = false;          // a "go" is running
  let pending = null;        // next request waiting for the current search to stop
  let current = null;        // { fen, onUpdate }

  function start() {
    if (worker) return true;
    try {
      // Workers can't be created straight from another domain, so wrap it in a tiny local script.
      const blob = new Blob([`importScripts('${STOCKFISH_URL}');`], { type: 'application/javascript' });
      worker = new Worker(URL.createObjectURL(blob));
      worker.onmessage = e => handleLine(String(e.data));
      worker.onerror = () => { worker = null; };
      worker.postMessage('uci');
      worker.postMessage('isready');
      return true;
    } catch (err) {
      console.warn('Stockfish could not start', err);
      worker = null;
      return false;
    }
  }

  function handleLine(line) {
    if (line.startsWith('bestmove')) {
      busy = false;
      if (pending) { const p = pending; pending = null; run(p); }
      return;
    }
    if (!current || !line.startsWith('info') || line.indexOf(' score ') === -1) return;
    const depth = +(/ depth (\d+)/.exec(line) || [])[1];
    const m = / score (cp|mate) (-?\d+)/.exec(line);
    if (!m) return;
    const pv = (/ pv (.+)$/.exec(line) || [])[1];
    // Stockfish reports the score for the side to move; convert to White's point of view.
    const sign = current.fen.split(' ')[1] === 'w' ? 1 : -1;
    const value = +m[2] * sign;
    current.onUpdate({
      depth,
      cp: m[1] === 'cp' ? value : null,
      mate: m[1] === 'mate' ? value : null,
      bestMove: pv ? pv.split(' ')[0] : null,
    });
  }

  function run(req) {
    current = req;
    busy = true;
    worker.postMessage('position fen ' + req.fen);
    worker.postMessage('go depth ' + DEPTH);
  }

  // Evaluate a position; onUpdate is called repeatedly as the engine searches deeper.
  function evaluate(fen, onUpdate) {
    if (!start()) return false;
    const req = { fen, onUpdate };
    if (busy) {
      pending = req;
      current = null;   // ignore output of the search being stopped
      worker.postMessage('stop');
    } else run(req);
    return true;
  }

  return { evaluate };
})();
