# Chess Rewind

Upload a picture of a chess board and the app finds a legal sequence of moves from the
starting position that reaches it. You can then replay the moves one at a time, with a
Stockfish evaluation bar showing who is winning.

> This project was created using [Claude Code](https://claude.com/claude-code), Anthropic's AI coding tool.

## Running it

Double-click `start.bat` (needs [Node.js](https://nodejs.org)). It starts a local web server and
opens http://localhost:8080. An internet connection is needed the first time, because chess.js
and Stockfish are loaded from a CDN.

## How to use

1. **Board image**: choose, drag in, or paste (Ctrl+V) a screenshot or photo. Screenshots are
   found automatically. For photos taken at an angle, drag the 4 green dots onto the board's corners
   and press **Read pieces**. Tick **Black at bottom** if the board is seen from Black's side.
2. **Check the position**: fix any wrong squares with the piece palette (right-click clears).
   After fixing one of each piece type, **Re-read using my fixes** usually corrects the rest.
   Set whose turn it is.
3. **Find the moves**: the search shows up to 3 different ways to reach the position. Use
   **Next move**, the arrow keys or **Auto-play** to step through them.

## How it works

| File | What it does |
| --- | --- |
| `js/recognize.js` | Finds the board (checkerboard pattern + grid-line alignment), warps each square with a perspective transform, cuts out the piece silhouette, guesses colour from brightness and type from shape. Squares you correct become examples for re-reading. |
| `js/search-core.js` | Beam search from the start position. Each position is scored by how many moves the pieces still need to reach their target squares (Hungarian matching per piece type) plus the captures still required. Runs in a Web Worker so the page stays responsive. |
| `js/engine.js` | Stockfish 10 (JavaScript build) in a Web Worker for the evaluation bar. |
| `js/board.js` | Board drawing and FEN helpers. |
| `js/app.js` | Page logic: image step, editor, search, replay. |

## Limitations

- Piece types are guessed from shape features without a trained AI model. Common screenshot piece
  styles read well; unusual styles and photos may need a few corrections on the first read.
- `test-images/` holds a sample screenshot used to check recognition after changes.
- The move sequence is *a* possible game, not necessarily the real one. Positions from long games
  with many captures and promotions may not be solved exactly; the app then shows the closest line it found.
