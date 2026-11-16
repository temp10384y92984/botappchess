// ==UserScript==
// @name         BotApp Chess — Live Overlay
// @namespace    botapp-chess
// @match        https://lichess.org/*
// @grant        GM_xmlhttpRequest
// @connect      cdnjs.cloudflare.com
// @connect      cdn.jsdelivr.net
// @version      1.7.0
// @author       BotApp
// @description  Live Stockfish overlay — think timer + throw-risk lines.
// @require      https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.10.3/chess.min.js
// ==/UserScript==

/*
  WARNING: Engine use in RATED games is a bannable offense on Lichess.
*/

(function () {
  'use strict';

  const CFG = {
    lines: 5,          // need extra lines for throw detection
    movetime: 700,
    colors: ['#3fa34d', '#3b82c4', '#d4a017', '#8a63d2', '#c8503c'],
    // throw band: centipawns worse than best, white-POV absolute gap
    throwMinCp: 50,    // at least ~0.5 pawn worse (not "equal")
    throwMaxCp: 180,   // at most ~1.8 — beyond this is a clear blunder, hide
  };

  const LS_POS = 'botapp_panel_pos';
  const LS_SIZE = 'botapp_panel_size';

  let worker = null;
  let ready = false;
  let searching = false;
  let lastKey = '';
  let lastFen = '';
  let panel = null;
  let evalBar = null;
  let lines = {};
  let lastLines = null;
  let emitTimer = null;
  let lastAnalyzeAt = 0;
  let stableFen = null;
  let tc = null; // { initial, inc } seconds
  let clocks = { w: null, b: null, ts: 0 };
  let thinkDeadline = 0; // Date.now() when suggested think ends
  let thinkTargetSec = 0;
  let thinkTickTimer = null;

  function getChess() {
    return (typeof Chess !== 'undefined' && Chess) || window.Chess || null;
  }

  const log = (...a) => console.log('[BotApp]', ...a);
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  function getWrap() {
    return $('.cg-wrap');
  }

  function isFlipped() {
    const w = getWrap();
    return !!(w && w.classList.contains('orientation-black'));
  }

  function isRealPiece(p) {
    const cls = (p.className && p.className.baseVal) || p.className || '';
    if (/\bghost\b|\bfading\b|\bdragging\b/.test(cls)) return false;
    if (/\banim\b/.test(cls) && !(p.cgKey || p.getAttribute('cgKey'))) return false;
    try {
      const r = p.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
    } catch (_) {}
    return true;
  }

  function pieceRoleColor(p) {
    const cls = (p.className && p.className.baseVal) || p.className || '';
    const color = /\bwhite\b/.test(cls) ? 'w' : /\bblack\b/.test(cls) ? 'b' : null;
    let role = null;
    if (/\bking\b/.test(cls)) role = 'k';
    else if (/\bqueen\b/.test(cls)) role = 'q';
    else if (/\brook\b/.test(cls)) role = 'r';
    else if (/\bbishop\b/.test(cls)) role = 'b';
    else if (/\bknight\b/.test(cls)) role = 'n';
    else if (/\bpawn\b/.test(cls)) role = 'p';
    return { color, role };
  }

  function visualToAlgebraic(vx, vy, flipped) {
    const file = flipped ? 7 - vx : vx;
    const rank = flipped ? vy : 7 - vy;
    if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
    return 'abcdefgh'[file] + (rank + 1);
  }

  function pieceSquare(p, boardEl, flipped) {
    let sq = p.cgKey || p.getAttribute('cgKey') || p.getAttribute('data-key') || '';
    if (sq && /^[a-h][1-8]$/.test(sq)) return sq;
    const tr = (p.style && p.style.transform) || '';
    const m = tr.match(/translate\(\s*([-\d.]+)(%|px)?\s*,\s*([-\d.]+)(%|px)?/);
    if (!m) return null;
    let x = parseFloat(m[1]), y = parseFloat(m[3]);
    const unit = m[2] || m[4] || '';
    if (unit === '%' || (unit === '' && x <= 100 && y <= 100)) {
      x = x / 12.5; y = y / 12.5;
    } else {
      const br = boardEl.getBoundingClientRect();
      if (br.width <= 0) return null;
      x = (x / br.width) * 8; y = (y / br.height) * 8;
    }
    if (Math.abs(x - Math.round(x)) > 0.2 || Math.abs(y - Math.round(y)) > 0.2) return null;
    return visualToAlgebraic(Math.max(0, Math.min(7, Math.round(x))), Math.max(0, Math.min(7, Math.round(y))), flipped);
  }

  function gameResult() {
    const status =
      ($('.status') && $('.status').innerText) ||
      ($('.result') && $('.result').innerText) || '';
    const t = (status || '').toLowerCase();
    if (!t) return null;
    if (/black won|black is victorious|0-1/.test(t)) return 'black';
    if (/white won|white is victorious|1-0/.test(t)) return 'white';
    if (/draw|½|1\/2|stalemate/.test(t)) return 'draw';
    return null;
  }

  function boardFingerprint() {
    const board = $('cg-board') || getWrap();
    if (!board) return '';
    const flipped = isFlipped();
    const parts = [];
    for (const p of $$('piece', board)) {
      if (!isRealPiece(p)) continue;
      const { color, role } = pieceRoleColor(p);
      if (!color || !role) continue;
      const sq = pieceSquare(p, board, flipped);
      if (sq) parts.push(color + role + sq);
    }
    parts.sort();
    const seen = new Set();
    const uniq = [];
    for (const x of parts) {
      const sq = x.slice(2);
      if (seen.has(sq)) continue;
      seen.add(sq);
      uniq.push(x);
    }
    const bottomRun = !!$('.rclock-bottom.running, .clock--bottom.running');
    const topRun = !!$('.rclock-top.running, .clock--top.running');
    const turn = bottomRun ? 'B' : topRun ? 'T' : '-';
    const lm = $$('cg-board square.last-move, .cg-wrap square.last-move').length;
    const res = gameResult() || '-';
    return uniq.join(',') + '|' + turn + '|' + lm + '|' + (flipped ? 'b' : 'w') + '|' + res + '|' + countMovesInDom();
  }

  function countMovesInDom() {
    let n = 0;
    for (const root of [$('l4x'), $('.moves'), $('rm6'), $('.tview2')].filter(Boolean)) {
      const nodes = $$('kwdb, move, .san, san, i5z', root);
      if (nodes.length > n) n = nodes.length;
    }
    return n;
  }

  function fenFromMovesList() {
    const Chess = getChess();
    if (!Chess) return null;
    const c = new Chess();
    let sans = [];
    const absorb = (root) => {
      if (!root) return;
      const nodes = $$('kwdb, move, i5z, san, .san, u8t', root);
      const got = nodes.map(n => n.textContent.trim()).filter(t => t && !/^\d+\.?$/.test(t) && t !== '...' && t !== '…');
      if (got.length > sans.length) sans = got;
    };
    absorb($('l4x')); absorb($('.moves')); absorb($('rm6')); absorb($('.tview2')); absorb($('.analyse__moves'));
    if (!sans.length) {
      for (const block of $$('l4x, .moves, rm6, .tview2, .tview2-column')) {
        const raw = block.innerText || '';
        const tokens = raw.replace(/\d+\.(\.\.)?/g, ' ').replace(/[+#]!?/g, '').split(/\s+/)
          .filter(t => /^[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](=[QRBN])?$|^O-O(-O)?$/i.test(t));
        if (tokens.length > sans.length) sans = tokens;
      }
    }
    for (const san of sans) {
      try {
        if (!c.move(san, { sloppy: true })) return c.history().length ? c.fen() : null;
      } catch (_) { return c.history().length ? c.fen() : null; }
    }
    return c.history().length ? c.fen() : null;
  }

  function sideToMoveFromClocks() {
    const bottomRun = !!$('.rclock-bottom.running, .clock--bottom.running');
    const topRun = !!$('.rclock-top.running, .clock--top.running');
    const flipped = isFlipped();
    if (bottomRun && !topRun) return flipped ? 'b' : 'w';
    if (topRun && !bottomRun) return flipped ? 'w' : 'b';
    return null;
  }

  function fenFromPieces() {
    const board = $('cg-board') || getWrap();
    if (!board) return null;
    const flipped = isFlipped();
    const grid = Array.from({ length: 8 }, () => Array(8).fill(null));
    let found = 0;
    const occupied = new Set();
    for (const p of $$('piece', board)) {
      if (!isRealPiece(p)) continue;
      const { color, role } = pieceRoleColor(p);
      if (!color || !role) continue;
      const sq = pieceSquare(p, board, flipped);
      if (!sq || occupied.has(sq)) continue;
      occupied.add(sq);
      const file = sq.charCodeAt(0) - 97, rank = +sq[1] - 1;
      grid[7 - rank][file] = color === 'w' ? role.toUpperCase() : role;
      found++;
    }
    if (found < 2) return null;
    const flat = grid.flat().join('');
    if (!flat.includes('K') || !flat.includes('k')) return null;
    let placement = '';
    for (let r = 0; r < 8; r++) {
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const ch = grid[r][f];
        if (!ch) empty++;
        else { if (empty) { placement += empty; empty = 0; } placement += ch; }
      }
      if (empty) placement += empty;
      if (r < 7) placement += '/';
    }
    const res = gameResult();
    let turn = sideToMoveFromClocks();
    if (!turn) {
      if (res === 'black' || res === 'white') turn = res === 'black' ? 'w' : 'b';
      else if (stableFen) turn = stableFen.split(' ')[1] || 'w';
      else turn = 'w';
    }
    return placement + ' ' + turn + ' - - 0 1';
  }

  function validateFen(fen) {
    const Chess = getChess();
    if (!Chess || !fen) return false;
    try {
      const f = new Chess(fen).fen();
      return !!f && f.includes('k') && f.includes('K');
    } catch (_) { return false; }
  }

  function currentFen() {
    const fromMoves = fenFromMovesList();
    if (fromMoves && validateFen(fromMoves)) { stableFen = fromMoves; return fromMoves; }
    const fromPieces = fenFromPieces();
    if (fromPieces && validateFen(fromPieces)) { stableFen = fromPieces; return fromPieces; }
    if (stableFen && validateFen(stableFen)) return stableFen;
    return 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  }

  // ---------- clocks ----------
  function parseClockText(t) {
    if (!t) return null;
    t = t.trim().replace(/\s+/g, '');
    const m = t.match(/^(\d+):(\d{2})(?:\.(\d))?$/);
    if (m) return +m[1] * 60 + +m[2] + (m[3] ? +m[3] / 10 : 0);
    if (/^\d+$/.test(t)) return +t;
    return null;
  }

  function readClocks() {
    const topTime = $('.rclock-top .time') || $('.clock--top .time');
    const botTime = $('.rclock-bottom .time') || $('.clock--bottom .time');
    const topSec = parseClockText(topTime && topTime.textContent);
    const botSec = parseClockText(botTime && botTime.textContent);
    const flipped = isFlipped();
    if (botSec != null) clocks[flipped ? 'b' : 'w'] = botSec;
    if (topSec != null) clocks[flipped ? 'w' : 'b'] = topSec;
    clocks.ts = Date.now();
    if (!tc) {
      const setup = ($('.setup') && $('.setup').textContent) ||
        ($('.game__meta') && $('.game__meta').textContent) || '';
      const m = String(setup).match(/(\d+)\+(\d+)/) ||
        (document.body.innerText.match(/\b(\d+)\+(\d+)\b/) || null);
      if (m) tc = { initial: +m[1] * 60, inc: +m[2] };
      else if (botSec != null || topSec != null) {
        tc = { initial: Math.max(botSec || 0, topSec || 0, 60), inc: 0 };
      }
    }
  }

  // ---------- think timer (non-uniform, TC-aware) ----------
  function fmtS(s) {
    s = Math.max(0, s);
    const t = Math.round(s);
    if (t < 60) return t + 's';
    return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
  }

  function expectedMovesLeft(fullmove) {
    // Rough remaining moves for this side (not total plies)
    if (fullmove <= 12) return 28;
    if (fullmove <= 25) return 20;
    if (fullmove <= 40) return 14;
    return 8;
  }

  function computeThinkSeconds(list) {
    readClocks();
    if (!tc) return null;
    const fen = lastFen || currentFen();
    const parts = fen.split(' ');
    const side = parts[1] || 'w';
    const remaining = clocks[side];
    if (remaining == null) return null;
    const fullmove = +parts[5] || 1;
    const movesLeft = expectedMovesLeft(fullmove);
    const inc = tc.inc || 0;

    // Base share of clock for this move (bank + increment)
    let base = remaining / movesLeft + inc * 0.85;

    // Non-uniform weight from how many near-best moves exist
    // Many equal options → spend a bit more; one only-move → spend less
    let weight = 1;
    if (list && list.length >= 2) {
      const best = scoreCp(list[0]);
      const near = list.filter(l => Math.abs(scoreCp(l) - best) <= 40).length;
      const gap = Math.abs(scoreCp(list[0]) - scoreCp(list[1]));
      if (gap >= 200) weight = 0.55;          // only move — don't burn time
      else if (gap >= 100) weight = 0.75;
      else if (near >= 3) weight = 1.35;      // branchy — take a little longer
      else if (near === 2) weight = 1.15;
    }

    // Low time: clamp harder so we don't flag
    if (remaining < 15) weight *= 0.5;
    else if (remaining < 30) weight *= 0.7;

    let sec = base * weight;
    // Floor / ceiling by TC scale
    const floor = Math.max(0.5, Math.min(3, inc * 0.4 + 0.5));
    const ceil = Math.max(floor + 1, remaining * 0.35);
    sec = Math.min(ceil, Math.max(floor, sec));
    return { sec, side, remaining, weight, movesLeft };
  }

  function startThinkTimer(list) {
    const t = computeThinkSeconds(list);
    if (!t) {
      thinkDeadline = 0;
      thinkTargetSec = 0;
      updateThinkUI(null);
      return;
    }
    thinkTargetSec = t.sec;
    thinkDeadline = Date.now() + t.sec * 1000;
    updateThinkUI(t);
    if (thinkTickTimer) clearInterval(thinkTickTimer);
    thinkTickTimer = setInterval(() => updateThinkUI(t), 200);
  }

  function updateThinkUI(info) {
    if (!panel) return;
    const el = panel.querySelector('.ba-think');
    if (!el) return;
    if (!thinkDeadline) {
      el.innerHTML = '<div class="ba-bmuted">No clock</div>';
      return;
    }
    const left = Math.max(0, (thinkDeadline - Date.now()) / 1000);
    const pct = thinkTargetSec > 0 ? Math.min(100, (left / thinkTargetSec) * 100) : 0;
    const side = info ? (info.side === 'w' ? 'White' : 'Black') : '';
    const urgent = left <= 2;
    el.innerHTML = `
      <div class="ba-brow"><span>Think</span><b class="${urgent ? 'ba-urgent' : ''}">${fmtS(left)}</b></div>
      <div class="ba-bar"><i style="width:${pct.toFixed(1)}%"></i></div>
      <div class="ba-bmuted">${side} · target ${fmtS(thinkTargetSec)}${info ? ` · ~${info.movesLeft} moves left` : ''}</div>
    `;
  }

  function scoreCp(l) {
    // white POV numeric for comparisons
    if (l.mate != null) return l.mate > 0 ? 10000 - l.mate * 10 : -10000 - l.mate * 10;
    return l.cp || 0;
  }

  // Soft-throw lines: worse than best by throwMin..throwMax cp (not equal, not blunder)
  function throwLines(list) {
    if (!list || list.length < 2) return [];
    const best = scoreCp(list[0]);
    const fen = lastFen || currentFen();
    const turn = (fen.split(' ')[1] || 'w');
    // gap from side-to-move perspective: how much STM loses by playing this
    // white-POV best for white to move is higher = better for white
    // For STM, "worse" means moving evaluation against STM
    const out = [];
    for (let i = 1; i < list.length; i++) {
      const l = list[i];
      const gap = turn === 'w' ? best - scoreCp(l) : scoreCp(l) - best;
      // gap > 0 means worse for the side to move
      if (gap >= CFG.throwMinCp && gap <= CFG.throwMaxCp) {
        out.push({ line: l, gap, san: pvSan(l.pv) });
      }
    }
    return out;
  }

  function renderThrows(list) {
    if (!panel) return;
    const box = panel.querySelector('.ba-throws');
    if (!box) return;
    const throws = throwLines(list);
    if (!throws.length) {
      box.innerHTML = '<div class="ba-bmuted">No soft-throw lines in band (0.5–1.8 pawns)</div>';
      return;
    }
    box.innerHTML = throws.map((t, i) => {
      const loss = (t.gap / 100).toFixed(2);
      return `<div class="ba-throw"><b>−${loss}</b><span>${t.san || (t.line.pv[0] || '')}</span></div>`;
    }).join('');
  }

  // ---------- engine ----------
  function loadEngine() {
    setStatus('Loading engine…');
    const urls = [
      'https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js',
      'https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/stockfish.js',
    ];
    const tryUrl = (i) => {
      if (i >= urls.length) { setStatus('Engine failed — see console'); return; }
      const url = urls[i];
      const boot = (text) => {
        try {
          worker = new Worker(URL.createObjectURL(new Blob([text], { type: 'application/javascript' })));
          worker.onmessage = onWorkerMsg;
          worker.onerror = (e) => log('Worker error', e);
          worker.postMessage('uci');
        } catch (e) { log(e); tryUrl(i + 1); }
      };
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'GET', url,
          onload: (res) => (res.status >= 200 && res.status < 300 ? boot(res.responseText) : tryUrl(i + 1)),
          onerror: () => tryUrl(i + 1),
        });
      } else {
        fetch(url).then(r => r.text()).then(boot).catch(() => tryUrl(i + 1));
      }
    };
    tryUrl(0);
  }

  function onWorkerMsg(e) {
    const line = String(e.data);
    if (line === 'uciok') {
      ready = true;
      setStatus('Engine ready');
      forceAnalyze();
    } else if (line.startsWith('bestmove')) {
      searching = false;
    } else if (searching && line.startsWith('info ') && line.includes(' pv ')) {
      onInfo(line);
    }
  }

  function forceAnalyze() {
    if (!ready || !worker) return;
    const res = gameResult();
    if (res) {
      lastKey = boardFingerprint();
      lastFen = currentFen();
      searching = false;
      clearArrows();
      thinkDeadline = 0;
      if (res === 'black') renderTerminal('0-1', 'Black won');
      else if (res === 'white') renderTerminal('1-0', 'White won');
      else renderTerminal('½-½', 'Draw');
      return;
    }
    const fen = currentFen();
    const key = fen.split(' ').slice(0, 4).join(' ');
    const prevKey = (lastFen || '').split(' ').slice(0, 4).join(' ');
    if (key === prevKey && searching) {
      lastKey = boardFingerprint();
      return;
    }
    lastFen = fen;
    lastKey = boardFingerprint();
    lines = {};
    lastLines = null;
    searching = true;
    lastAnalyzeAt = Date.now();
    setStatus('Analyzing…');
    clearArrows();
    // reset think timer until we have lines
    thinkDeadline = 0;
    log('Analyze', fen);
    try {
      worker.postMessage('stop');
      worker.postMessage('setoption name MultiPV value ' + CFG.lines);
      worker.postMessage('position fen ' + fen);
      worker.postMessage('go movetime ' + CFG.movetime);
    } catch (e) { log(e); searching = false; }
  }

  function renderTerminal(score, label) {
    ensureUI();
    if (panel) {
      panel.querySelector('.ba-score').textContent = score;
      panel.querySelector('.ba-meta').textContent = label;
      panel.querySelector('.ba-pvs').innerHTML = '';
      const th = panel.querySelector('.ba-throws');
      if (th) th.innerHTML = '';
      const tk = panel.querySelector('.ba-think');
      if (tk) tk.innerHTML = '<div class="ba-bmuted">Game over</div>';
      setStatus('Game over');
    }
    positionBar();
  }

  function onInfo(line) {
    const depth = +(line.match(/ depth (\d+)/) || [])[1];
    const mpv = +(line.match(/ multipv (\d+)/) || [, 1])[1];
    const score = line.match(/score (cp|mate) (-?\d+)/);
    if (!depth || !score) return;
    const fen = lastFen || currentFen();
    const turn = fen.split(' ')[1] || 'w';
    const raw = +score[2];
    const whitePov = turn === 'w' ? raw : -raw;
    lines[mpv] = {
      multipv: mpv, depth,
      cp: score[1] === 'cp' ? whitePov : null,
      mate: score[1] === 'mate' ? whitePov : null,
      pv: line.split(' pv ')[1].trim().split(/\s+/),
    };
    if (!emitTimer) {
      emitTimer = setTimeout(() => {
        emitTimer = null;
        lastLines = Object.values(lines).sort((a, b) => a.multipv - b.multipv);
        render(lastLines);
        renderThrows(lastLines);
        startThinkTimer(lastLines);
      }, 40);
    }
  }

  function scoreText(l) {
    if (l.mate != null) {
      if (l.mate > 0) return 'M' + l.mate;
      if (l.mate < 0) return '-M' + (-l.mate);
      return 'M0';
    }
    return (l.cp >= 0 ? '+' : '') + (l.cp / 100).toFixed(2);
  }

  // ---------- UI drag/resize ----------
  function loadPanelGeometry() {
    try {
      return {
        pos: JSON.parse(localStorage.getItem(LS_POS) || 'null'),
        size: JSON.parse(localStorage.getItem(LS_SIZE) || 'null'),
      };
    } catch (_) { return { pos: null, size: null }; }
  }

  function savePanelGeometry() {
    if (!panel) return;
    const r = panel.getBoundingClientRect();
    localStorage.setItem(LS_POS, JSON.stringify({ left: r.left, top: r.top }));
    localStorage.setItem(LS_SIZE, JSON.stringify({ w: r.width, h: r.height }));
  }

  function makeDraggableResizable(el) {
    const head = el.querySelector('.ba-head');
    const grip = el.querySelector('.ba-resize');
    let mode = null, sx, sy, sl, st, sw, sh;

    head.style.cursor = 'move';
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.ba-x')) return;
      mode = 'drag';
      const r = el.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top;
      head.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    grip.addEventListener('pointerdown', (e) => {
      mode = 'resize';
      const r = el.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; sw = r.width; sh = r.height;
      grip.setPointerCapture(e.pointerId);
      e.preventDefault(); e.stopPropagation();
    });
    window.addEventListener('pointermove', (e) => {
      if (!mode) return;
      if (mode === 'drag') {
        let left = sl + (e.clientX - sx), top = st + (e.clientY - sy);
        left = Math.max(0, Math.min(window.innerWidth - 80, left));
        top = Math.max(0, Math.min(window.innerHeight - 40, top));
        el.style.left = left + 'px';
        el.style.top = top + 'px';
        el.style.right = 'auto';
      } else {
        el.style.width = Math.max(200, Math.min(480, sw + (e.clientX - sx))) + 'px';
        el.style.height = Math.max(180, Math.min(window.innerHeight - 20, sh + (e.clientY - sy))) + 'px';
      }
    });
    window.addEventListener('pointerup', () => { if (mode) { mode = null; savePanelGeometry(); } });
    window.addEventListener('pointercancel', () => { mode = null; });
  }

  function ensureUI() {
    if (panel) return;
    panel = document.createElement('div');
    panel.id = 'botapp-panel';
    panel.innerHTML = `
      <div class="ba-head"><strong>BotApp</strong><span class="ba-status">Init…</span>
        <button type="button" class="ba-x" title="Hide">×</button></div>
      <div class="ba-score">—</div>
      <div class="ba-meta"></div>
      <div class="ba-pvs"></div>
      <div class="ba-sec-title">Think timer</div>
      <div class="ba-think"><div class="ba-bmuted">Waiting…</div></div>
      <div class="ba-sec-title">Throw risks <span class="ba-hint">−0.5 to −1.8</span></div>
      <div class="ba-throws"><div class="ba-bmuted">—</div></div>
      <div class="ba-warn">Casual only — rated = ban risk</div>
      <div class="ba-resize" title="Drag to resize"></div>
    `;
    document.documentElement.appendChild(panel);
    panel.querySelector('.ba-x').onclick = () => { panel.style.display = 'none'; };

    const geo = loadPanelGeometry();
    if (geo.pos) {
      panel.style.left = geo.pos.left + 'px';
      panel.style.top = geo.pos.top + 'px';
      panel.style.right = 'auto';
    }
    if (geo.size) {
      panel.style.width = geo.size.w + 'px';
      panel.style.height = geo.size.h + 'px';
    }
    makeDraggableResizable(panel);

    evalBar = document.createElement('div');
    evalBar.id = 'botapp-evalbar';
    evalBar.innerHTML = '<div class="ba-fill"></div>';
    document.documentElement.appendChild(evalBar);

    const st = document.createElement('style');
    st.textContent = `
      #botapp-panel {
        position: fixed !important; top: 72px; right: 10px; z-index: 2147483646 !important;
        width: 270px; min-width: 200px; min-height: 180px;
        max-width: 480px; max-height: 90vh;
        background: #1a1f26; color: #e8ebf0;
        border: 1px solid #2a3544; border-radius: 12px;
        font: 13px/1.4 system-ui,sans-serif; padding: 10px 12px 18px;
        box-shadow: 0 8px 28px rgba(0,0,0,.45);
        overflow: auto; box-sizing: border-box;
      }
      #botapp-panel .ba-head {
        display:flex; align-items:center; gap:8px; margin-bottom:4px;
        cursor: move; user-select: none; touch-action: none;
      }
      #botapp-panel .ba-status { flex:1; color:#8d98a8; font-size:12px; }
      #botapp-panel .ba-x { background:0; border:0; color:#8d98a8; font-size:18px; cursor:pointer; }
      #botapp-panel .ba-score { font:600 26px/1 Georgia,serif; margin:4px 0; }
      #botapp-panel .ba-meta { color:#8d98a8; font-size:12px; margin-bottom:4px; }
      #botapp-panel .ba-pv { display:flex; gap:8px; padding:4px 0; border-top:1px solid #2a3544; }
      #botapp-panel .ba-pv b { min-width:46px; color:var(--c,#6fb487); }
      #botapp-panel .ba-pv span { color:#8d98a8; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      #botapp-panel .ba-sec-title {
        margin-top: 10px; padding-top: 8px; border-top: 1px solid #2a3544;
        font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #8d98a8;
        display: flex; align-items: center; gap: 8px;
      }
      #botapp-panel .ba-hint { font-size: 10px; text-transform: none; letter-spacing: 0; color: #6a7380; }
      #botapp-panel .ba-brow { display:flex; justify-content:space-between; gap:8px; padding:2px 0; }
      #botapp-panel .ba-brow b { font-variant-numeric: tabular-nums; }
      #botapp-panel .ba-urgent { color: #e0675a !important; }
      #botapp-panel .ba-bar {
        height: 4px; background: #2b323d; border-radius: 2px; margin: 4px 0; overflow: hidden;
      }
      #botapp-panel .ba-bar i {
        display: block; height: 100%; background: #6fb487; border-radius: 2px;
        transition: width .15s linear;
      }
      #botapp-panel .ba-bmuted { color:#8d98a8; font-size:11px; margin-top:2px; }
      #botapp-panel .ba-throw {
        display:flex; gap:8px; padding:3px 0; border-top:1px solid #2a3544; font-size:12px;
      }
      #botapp-panel .ba-throw b { min-width: 42px; color: #d4a017; font-variant-numeric: tabular-nums; }
      #botapp-panel .ba-throw span { color:#c4cad3; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      #botapp-panel .ba-warn { margin-top:8px; font-size:11px; color:#e0675a; }
      #botapp-panel .ba-resize {
        position: absolute; right: 2px; bottom: 2px; width: 14px; height: 14px;
        cursor: nwse-resize; touch-action: none;
        background:
          linear-gradient(135deg, transparent 50%, #5a6575 50%, #5a6575 60%, transparent 60%),
          linear-gradient(135deg, transparent 70%, #5a6575 70%, #5a6575 80%, transparent 80%);
        opacity: .7;
      }
      #botapp-evalbar {
        position: fixed !important; z-index: 2147483645 !important; width: 12px;
        border-radius: 5px; background: #2b323d; overflow: hidden; display: none;
      }
      #botapp-evalbar .ba-fill {
        position:absolute; bottom:0; left:0; right:0; height:50%; background:#f4f4f2;
        transition: height .2s ease;
      }
    `;
    document.documentElement.appendChild(st);
  }

  function setStatus(t) {
    if (panel) panel.querySelector('.ba-status').textContent = t;
  }

  function positionBar() {
    if (!evalBar) return;
    const w = getWrap();
    if (!w) { evalBar.style.display = 'none'; return; }
    const r = w.getBoundingClientRect();
    if (r.width < 40) { evalBar.style.display = 'none'; return; }
    evalBar.style.display = 'block';
    evalBar.style.left = Math.max(4, r.left - 18) + 'px';
    evalBar.style.top = r.top + 'px';
    evalBar.style.height = r.height + 'px';
  }

  function ensureArrows() {
    const wrap = getWrap();
    if (!wrap) return null;
    let svg = document.getElementById('botapp-arrows');
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.id = 'botapp-arrows';
      svg.setAttribute('viewBox', '0 0 8 8');
      svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:20;';
      if (getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';
      wrap.appendChild(svg);
    }
    return svg;
  }

  function clearArrows() {
    const a = document.getElementById('botapp-arrows');
    if (a) a.innerHTML = '';
  }

  function sqXY(sq, flipped) {
    const f = sq.charCodeAt(0) - 97;
    const r = +sq[1] - 1;
    return [flipped ? 7 - f + 0.5 : f + 0.5, flipped ? r + 0.5 : 7 - r + 0.5];
  }

  function drawArrows(list) {
    const svg = ensureArrows();
    if (!svg) return;
    svg.innerHTML = '';
    const flipped = isFlipped();
    // best + throw lines (amber)
    const throws = throwLines(list);
    const throwUci = new Set(throws.map(t => t.line.pv[0]));
    list.forEach((l, i) => {
      const u = l.pv[0];
      if (!u || u.length < 4) return;
      const isThrow = throwUci.has(u);
      const [x1, y1] = sqXY(u.slice(0, 2), flipped);
      const [x2, y2] = sqXY(u.slice(2, 4), flipped);
      const c = isThrow ? '#d4a017' : CFG.colors[i % CFG.colors.length];
      const w = i === 0 ? 0.22 : isThrow ? 0.14 : 0.1;
      const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
      const hx = x2 - dx / len * 0.35, hy = y2 - dy / len * 0.35;
      const nx = -dy / len * 0.22, ny = dx / len * 0.22;
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('opacity', i === 0 ? '0.9' : isThrow ? '0.75' : '0.5');
      g.innerHTML = `
        <line x1="${x1}" y1="${y1}" x2="${hx}" y2="${hy}" stroke="${c}" stroke-width="${w}" stroke-linecap="round"/>
        <polygon points="${x2},${y2} ${hx + nx},${hy + ny} ${hx - nx},${hy - ny}" fill="${c}"/>
      `;
      svg.appendChild(g);
    });
  }

  function pvSan(pv) {
    const Chess = getChess();
    if (!Chess) return pv[0] || '';
    try {
      const c = new Chess(lastFen || currentFen());
      const out = [];
      for (const u of pv.slice(0, 5)) {
        const m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || 'q' });
        if (!m) break;
        out.push(m.san);
      }
      return out.join(' ');
    } catch (_) { return pv[0] || ''; }
  }

  function render(list) {
    if (!list.length) return;
    const top = list[0];
    const wp = top.mate != null
      ? (top.mate > 0 ? 0.99 : top.mate < 0 ? 0.01 : 0.5)
      : 1 / (1 + Math.pow(10, -(top.cp || 0) / 400));
    if (panel) {
      // show top 3 as main PVs
      const main = list.slice(0, 3);
      panel.querySelector('.ba-score').textContent = scoreText(top);
      panel.querySelector('.ba-meta').textContent =
        'depth ' + top.depth + (isFlipped() ? ' · black view' : ' · white view');
      panel.querySelector('.ba-pvs').innerHTML = main.map((l, i) =>
        `<div class="ba-pv" style="--c:${CFG.colors[i % CFG.colors.length]}"><b>${scoreText(l)}</b><span>${pvSan(l.pv)}</span></div>`
      ).join('');
      setStatus('Live');
    }
    if (evalBar) {
      const fill = evalBar.querySelector('.ba-fill');
      if (isFlipped()) {
        fill.style.bottom = 'auto'; fill.style.top = '0';
        fill.style.height = ((1 - wp) * 100).toFixed(1) + '%';
      } else {
        fill.style.top = 'auto'; fill.style.bottom = '0';
        fill.style.height = (wp * 100).toFixed(1) + '%';
      }
    }
    drawArrows(list);
    positionBar();
  }

  function tick() {
    ensureUI();
    positionBar();
    readClocks();
    if (!ready) return;
    const fp = boardFingerprint();
    if (!fp || fp.startsWith('|')) return;
    if (fp !== lastKey) {
      if (Date.now() - lastAnalyzeAt < 100) return;
      log('Board changed');
      forceAnalyze();
    }
  }

  function start() {
    ensureUI();
    setStatus('Starting…');
    log('Boot', location.href);
    loadEngine();
    setInterval(tick, 220);
    const mo = new MutationObserver(() => {
      clearTimeout(tick._t);
      tick._t = setTimeout(tick, 40);
    });
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    window.addEventListener('resize', positionBar);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
