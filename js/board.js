// A simple chess board drawn with HTML squares and chess-font glyphs.
// Positions are arrays of 64 strings, index 0 = a8 ... 63 = h1; 'K' white king, 'p' black pawn, '' empty.
const PIECE_GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };

function pieceHtml(p) {
  if (!p) return '';
  const white = p === p.toUpperCase();
  return `<span class="piece ${white ? 'white' : 'black'}">${PIECE_GLYPH[p.toLowerCase()]}︎</span>`;
}

function squareName(idx) {
  return String.fromCharCode(97 + (idx & 7)) + (8 - (idx >> 3));
}

function createBoard(el, opts = {}) {
  let position = new Array(64).fill('');
  let flipped = false;
  let highlights = [];
  el.classList.add('board');
  el.addEventListener('contextmenu', e => e.preventDefault());

  function render() {
    el.innerHTML = '';
    for (let view = 0; view < 64; view++) {
      const idx = flipped ? 63 - view : view;
      const r = idx >> 3, f = idx & 7;
      const sq = document.createElement('div');
      sq.className = 'sq ' + ((r + f) % 2 ? 'dark' : 'light');
      if (highlights.includes(idx)) sq.classList.add('hl');
      sq.innerHTML = pieceHtml(position[idx]);
      const viewRow = view >> 3, viewCol = view & 7;
      if (viewCol === 0) sq.insertAdjacentHTML('beforeend', `<span class="coord rank">${8 - r}</span>`);
      if (viewRow === 7) sq.insertAdjacentHTML('beforeend', `<span class="coord file">${'abcdefgh'[f]}</span>`);
      sq.title = squareName(idx);
      if (opts.onSquare) {
        sq.addEventListener('mousedown', e => {
          e.preventDefault();
          opts.onSquare(idx, e.button === 2 ? 'right' : 'left');
        });
      }
      el.appendChild(sq);
    }
  }

  render();
  return {
    setPosition(p) { position = p.slice(); render(); },
    getPosition() { return position.slice(); },
    setFlipped(v) { flipped = !!v; render(); },
    isFlipped() { return flipped; },
    setHighlights(list) { highlights = list || []; render(); },
  };
}

// ---------- FEN helpers ----------
function positionToPlacement(pos) {
  let out = '';
  for (let r = 0; r < 8; r++) {
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const p = pos[r * 8 + f];
      if (!p) { empty++; continue; }
      if (empty) { out += empty; empty = 0; }
      out += p;
    }
    if (empty) out += empty;
    if (r < 7) out += '/';
  }
  return out;
}

function placementToPosition(placement) {
  const pos = new Array(64).fill('');
  const rows = placement.trim().split(' ')[0].split('/');
  if (rows.length !== 8) return null;
  for (let r = 0; r < 8; r++) {
    let f = 0;
    for (const ch of rows[r]) {
      if (ch >= '1' && ch <= '8') f += +ch;
      else if ('pnbrqkPNBRQK'.includes(ch) && f < 8) pos[r * 8 + f++] = ch;
      else return null;
    }
    if (f !== 8) return null;
  }
  return pos;
}

// Castling rights are only possible when king and rook are still on their home squares.
function guessCastling(pos) {
  let c = '';
  if (pos[60] === 'K') { if (pos[63] === 'R') c += 'K'; if (pos[56] === 'R') c += 'Q'; }
  if (pos[4] === 'k') { if (pos[7] === 'r') c += 'k'; if (pos[0] === 'r') c += 'q'; }
  return c || '-';
}

function positionToFen(pos, turn) {
  return `${positionToPlacement(pos)} ${turn} ${guessCastling(pos)} - 0 1`;
}

const START_POSITION = placementToPosition('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR');
