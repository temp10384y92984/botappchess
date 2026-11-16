# BotApp Chess 

**Real-time kinda-dinky Stockfish on Lichess w/o API delay.**

Violentmonkey / Tampermonkey userscript that reads the board, runs Stockfish in the browser, and draws candidate moves on the actual Lichess board.

> Engine use in **rated** games violates Lichess ToS and can get accounts banned!!! User is responsible for what is done on their account. This is intended for unrated and bot use only.

---

## Features

| | |
|---|---|
| **Live analysis** | Moves update the moment they appear on the page |
| **Ranked lines** | Up to 5 engine candidates with eval scores |
| **Board arrows** | Best move in green; near-best alternatives in blue / purple |

---

## Install

1. Install **[Violentmonkey](https://violentmonkey.github.io/)** (or Tampermonkey)
2. Create a new script → paste the contents of `BotApp-Lichess-Overlay.user.js`
3. Save
4. Open any Lichess game and hard-refresh (**Ctrl+Shift+R**)

The panel appears on the right. Drag the header to move; corner grip to resize.

---

## Usage

- Play or watch a game on [lichess.org](https://lichess.org)
- Lines and arrows refresh after each move settles
- **Alt+B** to show / hide the panel
- Open the browser console (F12) for `[BotApp]` diagnostics if something looks wrong

---

## How it works

```
Lichess page DOM
      │
      ▼
userscript    MutationObserver + piece fingerprint
      │
      ▼
chess.js      rebuild FEN from move list (preferred) or pieces
      │
      ▼
Stockfish     WASM worker 
      │
      ▼
SVG arrows + floating panel
```

---

## Files

| File | Role |
|------|------|
| `BotApp-Lichess-Overlay.user.js` | The userscript (install this) |
| `README.md` | You are here |

---

## Limitations

- **CSP / network** — first load fetches Stockfish from a CDN; Violentmonkey must allow `cdnjs.cloudflare.com` / `cdn.jsdelivr.net`
- **Move list parsing** — relies on Lichess DOM structure; rare UI changes can desync until refresh
- **General jank** — ... but it ain't broke 

---

## License

Use and modify freely for personal practice.  
Stockfish is GPL; chess.js is BSD. Respect upstream licenses if you redistribute.
