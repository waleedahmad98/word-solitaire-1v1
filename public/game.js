// Word-association solitaire engine. Rules (mirroring the original's model):
//  - Cards are either a CATEGORY card or a WORD card belonging to one category.
//  - Tableau ("play stacks"): columns with face-down cards; the top card is face-up.
//  - Home slots: an empty slot accepts a CATEGORY card. A slot holding category X
//    accepts WORD cards of X. When all of X's words are home, the category completes
//    and the slot frees up.
//  - In the tableau a word can go on a word/category of the same category, and any
//    card (or same-category run) can go into an empty column.
//  - Stock: tap to deal one card to the waste; when empty, the waste recycles.
(function (root) {
  const SLOT_COUNT = 4;
  const COL_COUNT = 5;

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, rnd) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // Build a deal from a seed. Same seed => identical deal on every client.
  function deal(seed, pool, opts = {}) {
    const numCats = opts.categories || 6;
    for (let attempt = 0; attempt < 200; attempt++) {
      const rnd = mulberry32((seed * 7919 + attempt * 104729) >>> 0);
      const names = shuffle(Object.keys(pool).slice(), rnd).slice(0, numCats);
      const cats = names.map((name) => {
        const n = 3 + Math.floor(rnd() * 3); // 3–5 words per category
        return { name, words: shuffle(pool[name].slice(), rnd).slice(0, n) };
      });
      const cards = [];
      cats.forEach((c, ci) => {
        cards.push({ id: cards.length, type: "cat", cat: ci, text: c.name });
        c.words.forEach((w) => cards.push({ id: cards.length, type: "word", cat: ci, text: w }));
      });
      const order = shuffle(cards.map((c) => c.id), rnd);
      const columns = [];
      let k = 0;
      for (let i = 0; i < COL_COUNT; i++) {
        const col = [];
        for (let j = 0; j <= i; j++) col.push({ id: order[k++], up: j === i });
        columns.push(col);
      }
      const stock = order.slice(k).reverse(); // last element = top
      const state = {
        cats: cats.map((c) => ({ name: c.name, total: c.words.length })),
        cards, columns, stock, waste: [],
        slots: Array.from({ length: SLOT_COUNT }, () => null), // {cat, count}
        done: [], moves: 0,
      };
      if (solvable(state, (seed ^ attempt) >>> 0)) return state;
    }
    throw new Error("could not generate a solvable deal");
  }

  const clone = (s) => JSON.parse(JSON.stringify(s));
  const won = (s) => s.done.length === s.cats.length;
  const card = (s, id) => s.cards[id];

  // Movable run starting at column index i (all face-up, cohesive).
  function runFrom(s, col, i) {
    const c = s.columns[col];
    if (i < 0 || i >= c.length || !c[i].up) return null;
    const first = card(s, c[i].id);
    for (let j = i + 1; j < c.length; j++) {
      const x = card(s, c[j].id);
      if (x.type !== "word" || x.cat !== first.cat) return null;
    }
    return c.slice(i).map((e) => e.id);
  }

  function canHome(s, ids, slot) {
    const first = card(s, ids[0]);
    const sl = s.slots[slot];
    if (!sl) {
      if (first.type !== "cat") return "CategoryWrongStart";
    } else {
      if (first.type !== "word" || first.cat !== sl.cat) return "HomeWrongOrder";
    }
    return ids.every((id, n) => n === 0 || card(s, id).cat === first.cat) ? null : "HomeWrongOrder";
  }

  function canStack(s, ids, col) {
    const c = s.columns[col];
    if (!c.length) return null;
    const top = card(s, c[c.length - 1].id);
    const first = card(s, ids[0]);
    if (first.type !== "word" || first.cat !== top.cat) return "WordWrongOrder";
    return null;
  }

  // src: {from:'col', col, index} | {from:'waste'}; dst: {to:'slot', slot} | {to:'col', col}
  function idsFor(s, src) {
    if (src.from === "waste") return s.waste.length ? [s.waste[s.waste.length - 1]] : null;
    return runFrom(s, src.col, src.index);
  }

  function check(s, src, dst) {
    const ids = idsFor(s, src);
    if (!ids) return "NoCard";
    if (dst.to === "col" && src.from === "col" && src.col === dst.col) return "Same";
    if (dst.to === "slot") return canHome(s, ids, dst.slot);
    return canStack(s, ids, dst.col);
  }

  // Applies move in place. Returns events: [{type:'home'|'complete'|'flip', ...}]
  function apply(s, src, dst) {
    const err = check(s, src, dst);
    if (err) return { error: err };
    const ids = idsFor(s, src);
    if (src.from === "waste") s.waste.pop();
    else s.columns[src.col].splice(src.index);
    const ev = [];
    if (dst.to === "slot") {
      for (const id of ids) {
        const c = card(s, id);
        if (c.type === "cat") s.slots[dst.slot] = { cat: c.cat, count: 0, top: id };
        else { s.slots[dst.slot].count++; s.slots[dst.slot].top = id; ev.push({ type: "home", id }); }
      }
      const sl = s.slots[dst.slot];
      if (sl.count === s.cats[sl.cat].total) {
        s.done.push(sl.cat); s.slots[dst.slot] = null;
        ev.push({ type: "complete", cat: sl.cat, slot: dst.slot });
      }
    } else {
      for (const id of ids) s.columns[dst.col].push({ id, up: true });
    }
    if (src.from === "col") {
      const c = s.columns[src.col];
      if (c.length && !c[c.length - 1].up) { c[c.length - 1].up = true; ev.push({ type: "flip", id: c[c.length - 1].id }); }
    }
    s.moves++;
    return { events: ev, ids };
  }

  function draw(s) {
    if (s.stock.length) s.waste.push(s.stock.pop());
    else if (s.waste.length) { s.stock = s.waste.reverse(); s.waste = []; }
    else return false;
    s.moves++;
    return true;
  }

  function sources(s) {
    const out = [];
    if (s.waste.length) out.push({ from: "waste" });
    s.columns.forEach((c, col) => {
      for (let i = 0; i < c.length; i++) if (runFrom(s, col, i)) { out.push({ from: "col", col, index: i }); }
    });
    return out;
  }

  // All legal card moves, scored for usefulness (used by solver and hints).
  function legalMoves(s) {
    const moves = [];
    for (const src of sources(s)) {
      const ids = idsFor(s, src);
      const reveals = src.from === "col" && src.index > 0 && !s.columns[src.col][src.index - 1].up;
      const wholeCol = src.from === "col" && src.index === 0;
      for (let slot = 0; slot < s.slots.length; slot++) {
        if (!check(s, src, { to: "slot", slot })) {
          const isWord = card(s, ids[0]).type === "word";
          moves.push({ src, dst: { to: "slot", slot }, score: (isWord ? 100 : 40) + (reveals ? 30 : 0) });
          if (!s.slots[slot]) break; // one empty slot is enough
        }
      }
      for (let col = 0; col < s.columns.length; col++) {
        if (check(s, src, { to: "col", col })) continue;
        const empty = !s.columns[col].length;
        if (empty && wholeCol) continue; // pointless
        let score = reveals ? 50 : src.from === "waste" ? 20 : wholeCol && !empty ? 15 : 1;
        if (empty) score -= 5;
        moves.push({ src, dst: { to: "col", col }, score });
      }
    }
    return moves.sort((a, b) => b.score - a.score);
  }

  // Randomised greedy playouts — accept the deal if any playout wins.
  function solvable(state, seed) {
    const rnd = mulberry32(seed);
    for (let p = 0; p < 60; p++) {
      const s = clone(state);
      let idle = 0;
      for (let step = 0; step < 600 && !won(s); step++) {
        const ms = legalMoves(s).filter((m) => m.score > 1);
        if (ms.length && (idle < 2 || rnd() < 0.9)) {
          const pick = rnd() < 0.75 ? ms[0] : ms[Math.floor(rnd() * ms.length)];
          apply(s, pick.src, pick.dst);
          idle = 0;
        } else {
          if (!draw(s)) break;
          idle++;
          if (idle > (s.stock.length + s.waste.length) * 2 + 2) break;
        }
      }
      if (won(s)) return true;
    }
    return false;
  }

  function hint(s) {
    const ms = legalMoves(s).filter((m) => m.score > 1);
    return ms[0] || ((s.stock.length || s.waste.length) ? { draw: true } : null);
  }

  function cardsLeft(s) {
    let n = s.stock.length + s.waste.length;
    s.columns.forEach((c) => (n += c.length));
    return n;
  }

  const api = { deal, apply, check, draw, hint, legalMoves, runFrom, won, clone, cardsLeft, SLOT_COUNT };
  if (typeof module !== "undefined") module.exports = api;
  else root.Engine = api;
})(this);
