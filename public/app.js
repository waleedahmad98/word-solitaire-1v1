/* global Engine, WORD_POOL */
const $ = (id) => document.getElementById(id);
const SCORE = { word: 10, catCard: 15, complete: 50, hint: -15, undo: -10 };
const SOLO_SECONDS = 600;

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

let G = null;    // { s, history, score, startAt, endAt, finished, seed }
let net = null;  // { code, pid, es, room, offset }
let mode = "solo";
let sel = null;  // selected source
let tick = null;

// ---------- screens ----------
function show(id) {
  for (const s of ["menu", "lobby", "game"]) $(s).classList.toggle("hidden", s !== id);
}
function overlay(html) {
  if (!html) return $("overlay").classList.add("hidden");
  $("overlayBody").innerHTML = html;
  $("overlay").classList.remove("hidden");
}
function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.classList.add("on");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("on"), 1400);
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (ms) => { const t = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };
const now = () => Date.now() + (net?.offset || 0); // server-aligned clock

// ---------- game lifecycle ----------
function startGame(seed, startAt, endAt) {
  G = { s: Engine.deal(seed, WORD_POOL), history: [], score: 0, startAt, endAt, finished: false, seed };
  sel = null;
  $("game").classList.toggle("solo", mode === "solo");
  $("meName").textContent = myName() + " (you)";
  show("game");
  render();
  clearInterval(tick);
  tick = setInterval(onTick, 200);
  onTick();
}

function onTick() {
  if (!G) return;
  const t = now();
  if (t < G.startAt) {
    overlay(`<div class="small">Same deal for both players</div><div class="big">${Math.ceil((G.startAt - t) / 1000)}</div><div>Get ready…</div>`);
    return;
  }
  if ($("overlay").dataset.kind !== "result" && !$("overlay").classList.contains("hidden") && G.startAt) overlay(null);
  const left = G.endAt - t;
  $("timer").textContent = fmt(left);
  $("timer").classList.toggle("low", left < 30000);
  if (mode === "solo" && left <= 0 && !G.finished) finishSolo(false);
}

function myName() { return ($("name").value || "Player").trim().slice(0, 16); }

function pushProgress(finished = false) {
  const s = G.s;
  if (mode !== "mp") return;
  api("progress", { score: G.score, catsDone: s.done.length, cardsLeft: Engine.cardsLeft(s), moves: s.moves, finished });
}

function afterMove(events) {
  for (const e of events || []) {
    if (e.type === "home") G.score += SCORE.word;
    if (e.type === "complete") {
      G.score += SCORE.complete;
      toast(`✓ ${G.s.cats[e.cat].name} complete!`);
      requestAnimationFrame(() => $("slots").children[e.slot]?.classList.add("pop"));
    }
  }
  if (Engine.won(G.s) && !G.finished) {
    G.finished = true;
    const secsLeft = Math.max(0, Math.floor((G.endAt - now()) / 1000));
    G.score += secsLeft; // time bonus
    render();
    if (mode === "mp") pushProgress(true);
    else finishSolo(true);
    return;
  }
  render();
  pushProgress();
}

function finishSolo(won) {
  G.finished = true;
  clearInterval(tick);
  const t = Math.round((now() - G.startAt) / 1000);
  const best = +store.get("ws_best") || 0;
  if (won && G.score > best) store.set("ws_best", G.score);
  showResult(`<h2>${won ? "Board cleared!" : "Time's up"}</h2>
    <div class="big">${G.score}</div>
    <div class="small">${won ? `in ${fmt(t * 1000)} · ` : ""}${G.s.moves} moves · best ${Math.max(best, won ? G.score : 0)}</div>
    <button class="primary" onclick="solo()">New deal</button>
    <button class="ghost" onclick="toMenu()">Menu</button>`);
}

function showResult(html) {
  overlay(html);
  $("overlay").dataset.kind = "result";
}

// ---------- moves ----------
function snapshot() { G.history.push({ s: Engine.clone(G.s), score: G.score }); if (G.history.length > 200) G.history.shift(); }

function tryMove(src, dst) {
  if (!G || G.finished || now() < G.startAt) return false;
  const err = Engine.check(G.s, src, dst);
  if (err) {
    const msg = { CategoryWrongStart: "A category card must open an empty slot", HomeWrongOrder: "That word doesn't belong to this category", WordWrongOrder: "Words only stack on the same category" }[err];
    if (msg) toast(msg);
    return false;
  }
  snapshot();
  const r = Engine.apply(G.s, src, dst);
  sel = null;
  afterMove(r.events);
  return true;
}

function autoMove(src) {
  const s = G.s;
  for (let i = 0; i < s.slots.length; i++) if (s.slots[i] && !Engine.check(s, src, { to: "slot", slot: i })) return tryMove(src, { to: "slot", slot: i });
  for (let i = 0; i < s.slots.length; i++) if (!s.slots[i] && !Engine.check(s, src, { to: "slot", slot: i })) return tryMove(src, { to: "slot", slot: i });
  for (let c = 0; c < s.columns.length; c++) if (s.columns[c].length && !Engine.check(s, src, { to: "col", col: c })) return tryMove(src, { to: "col", col: c });
  const wholeCol = src.from === "col" && src.index === 0;
  if (!wholeCol) for (let c = 0; c < s.columns.length; c++) if (!s.columns[c].length) return tryMove(src, { to: "col", col: c });
  return false;
}

function drawStock() {
  if (!G || G.finished || now() < G.startAt) return;
  snapshot();
  if (!Engine.draw(G.s)) { G.history.pop(); return; }
  sel = null;
  render(); pushProgress();
}

function undo() {
  if (!G || G.finished || !G.history.length) return;
  const h = G.history.pop();
  G.s = h.s; G.score = h.score + SCORE.undo;
  sel = null; render(); pushProgress();
}

function hint() {
  if (!G || G.finished) return;
  const h = Engine.hint(G.s);
  if (!h) return toast("No moves left. Try undo");
  G.score += SCORE.hint;
  render(); pushProgress();
  if (h.draw) return $("stock").classList.add("drop-ok"), setTimeout(() => $("stock").classList.remove("drop-ok"), 1500);
  const el = h.src.from === "waste" ? $("waste").lastElementChild : $("columns").children[h.src.col].children[h.src.index];
  el?.classList.add("hint");
  const tgt = h.dst.to === "slot" ? $("slots").children[h.dst.slot] : $("columns").children[h.dst.col];
  tgt?.classList.add("drop-ok"); setTimeout(() => tgt?.classList.remove("drop-ok"), 1800);
}

// ---------- rendering ----------
function cardEl(c, extra = "") {
  const d = document.createElement("div");
  d.className = `card ${c.type === "cat" ? "cat" : ""} ${c.text.length > 10 ? "xlong" : c.text.length > 7 ? "long" : ""} ${extra}`;
  d.innerHTML = c.type === "cat"
    ? `<div class="w">${esc(c.text)}</div><div class="n">${G.s.cats[c.cat].total} words</div>`
    : `<div class="w">${esc(c.text)}</div>`;
  return d;
}

function colOffsets() {
  // shrink spacing on short screens
  const cw = $("slots").firstElementChild?.offsetWidth || 70;
  return { down: Math.round(cw * 0.16), up: Math.round(cw * 0.36) };
}

function render() {
  const s = G.s;
  // slots
  const slots = $("slots"); slots.innerHTML = "";
  s.slots.forEach((sl, i) => {
    const d = document.createElement("div");
    d.className = "slot" + (sl ? " filled" : "");
    d.dataset.drop = "slot:" + i;
    if (sl) {
      const top = s.cards[sl.top];
      const ce = cardEl(top);
      if (top.type === "word") ce.innerHTML = `<div class="small" style="color:inherit;opacity:.6">${esc(s.cats[sl.cat].name)}</div><div class="w">${esc(top.text)}</div>`;
      d.appendChild(ce);
      d.insertAdjacentHTML("beforeend", `<div class="prog">${sl.count}/${s.cats[sl.cat].total}</div>`);
    } else d.innerHTML = `<div class="lbl">Category<br>slot</div>`;
    slots.appendChild(d);
  });
  // stock / waste
  const st = $("stock"); st.innerHTML = "";
  st.classList.toggle("recycle", !s.stock.length && s.waste.length > 0);
  if (s.stock.length) { st.appendChild(Object.assign(document.createElement("div"), { className: "card down" })); st.insertAdjacentHTML("beforeend", `<div class="cnt">${s.stock.length}</div>`); }
  const w = $("waste"); w.innerHTML = "";
  if (s.waste.length) {
    const top = s.cards[s.waste[s.waste.length - 1]];
    const ce = cardEl(top, sel?.from === "waste" ? "sel" : "");
    ce.dataset.src = "waste";
    w.appendChild(ce);
  }
  // columns
  const off = colOffsets();
  const cols = $("columns"); cols.innerHTML = "";
  s.columns.forEach((col, ci) => {
    const d = document.createElement("div");
    d.className = "col" + (col.length ? "" : " empty");
    d.dataset.drop = "col:" + ci;
    let y = 0;
    col.forEach((e, i) => {
      const c = s.cards[e.id];
      const selected = sel?.from === "col" && sel.col === ci && i >= sel.index;
      const ce = e.up ? cardEl(c, selected ? "sel" : "") : Object.assign(document.createElement("div"), { className: "card down" });
      ce.style.top = y + "px";
      if (e.up) ce.dataset.src = `col:${ci}:${i}`;
      d.appendChild(ce);
      y += e.up ? off.up : off.down;
    });
    if (col.length) d.style.height = `calc(${y - (col[col.length - 1].up ? off.up : off.down)}px + var(--ch))`;
    cols.appendChild(d);
  });
  // hud
  const total = s.cats.length;
  $("meScore").textContent = G.score;
  $("meBar").style.width = (100 * s.done.length) / total + "%";
  $("moves").textContent = `${s.moves} moves · ${s.done.length}/${total} categories`;
}

function renderOpponent() {
  if (!net?.room || !G) return;
  const opp = net.room.players.find((p) => p.id !== net.pid);
  if (!opp) return;
  $("oppName").textContent = opp.name + (opp.connected ? "" : " (offline)");
  $("oppScore").textContent = opp.score;
  $("oppBar").style.width = (100 * opp.catsDone) / G.s.cats.length + "%";
}

// ---------- input: tap + drag ----------
function parseSrc(str) {
  if (str === "waste") return { from: "waste" };
  const [, col, index] = str.split(":");
  return { from: "col", col: +col, index: +index };
}
function parseDst(str) {
  if (!str || str === "stock") return null;
  const [k, n] = str.split(":");
  return k === "slot" ? { to: "slot", slot: +n } : { to: "col", col: +n };
}
const sameSrc = (a, b) => a && b && a.from === b.from && a.col === b.col && a.index === b.index;

let drag = null;
let lastTap = { t: 0, key: "" };

document.addEventListener("pointerdown", (e) => {
  if ($("game").classList.contains("hidden")) return;
  const cardNode = e.target.closest("[data-src]");
  if (cardNode && G && Engine.runFrom && (cardNode.dataset.src === "waste" || Engine.runFrom(G.s, ...cardNode.dataset.src.split(":").slice(1).map(Number)))) {
    drag = { src: parseSrc(cardNode.dataset.src), key: cardNode.dataset.src, x: e.clientX, y: e.clientY, node: cardNode, ghost: null, moved: false };
  } else drag = { src: null, x: e.clientX, y: e.clientY, target: e.target };
});

document.addEventListener("pointermove", (e) => {
  if (!drag?.src) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 8) return;
  if (!drag.moved) {
    drag.moved = true;
    const r = drag.node.getBoundingClientRect();
    const g = document.createElement("div");
    g.className = "ghostdrag";
    // clone the dragged run
    let n = drag.node; const base = n.offsetTop;
    while (n) { const c = n.cloneNode(true); c.style.top = n.offsetTop - base + "px"; c.classList.remove("sel"); g.appendChild(c); n.style.visibility = "hidden"; n = drag.src.from === "col" ? n.nextElementSibling : null; }
    g.style.left = r.left + "px"; g.style.top = r.top + "px";
    drag.ox = e.clientX - r.left; drag.oy = e.clientY - r.top;
    document.body.appendChild(g); drag.ghost = g;
  }
  drag.ghost.style.left = e.clientX - drag.ox + "px";
  drag.ghost.style.top = e.clientY - drag.oy + "px";
  document.querySelectorAll(".drop-ok").forEach((x) => x.classList.remove("drop-ok"));
  const dz = dropZoneAt(e.clientX, e.clientY);
  const dst = parseDst(dz?.dataset.drop);
  if (dst && !Engine.check(G.s, drag.src, dst)) dz.classList.add("drop-ok");
});

function dropZoneAt(x, y) {
  const els = document.elementsFromPoint(x, y);
  for (const el of els) { const z = el.closest?.("[data-drop]"); if (z) return z; }
  return null;
}

document.addEventListener("pointerup", (e) => {
  const d = drag; drag = null;
  if (!d || $("game").classList.contains("hidden")) return;
  document.querySelectorAll(".drop-ok").forEach((x) => x.classList.remove("drop-ok"));
  if (d.moved) {
    d.ghost.remove();
    const dst = parseDst(dropZoneAt(e.clientX, e.clientY)?.dataset.drop);
    if (!(dst && tryMove(d.src, dst))) render();
    return;
  }
  onTap(d, e);
});

function onTap(d, e) {
  if (!G) return;
  if (e.target.closest("#stock")) return drawStock();
  if (d.src) {
    const t = Date.now();
    const dbl = lastTap.key === d.key && t - lastTap.t < 350;
    lastTap = { t, key: d.key };
    if (dbl || sameSrc(sel, d.src)) { sel = null; if (!autoMove(d.src)) { render(); toast("No place for that card"); } return; }
    if (sel) {
      // tapping another card = try to drop onto its column
      if (d.src.from === "col" && tryMove(sel, { to: "col", col: d.src.col })) return;
    }
    sel = d.src; render(); return;
  }
  const dz = e.target.closest("[data-drop]");
  const dst = parseDst(dz?.dataset.drop);
  if (sel && dst) { if (!tryMove(sel, dst)) { dz.classList.add("shake"); setTimeout(() => dz.classList.remove("shake"), 300); } return; }
  if (sel) { sel = null; render(); }
}

// ---------- networking ----------
async function api(path, body = {}) {
  const r = await fetch("/api/" + path, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, code: net?.code, pid: net?.pid }),
  });
  return r.json();
}

function connect(code, pid) {
  net = { code, pid, es: null, room: null, offset: 0 };
  try { sessionStorage.setItem("ws_room", JSON.stringify({ code, pid })); } catch {}
  const es = new EventSource(`/events?code=${code}&pid=${pid}`);
  net.es = es;
  es.addEventListener("room", (ev) => onRoom(JSON.parse(ev.data)));
  es.onerror = () => {
    if (es.readyState !== 2) return; // browser will retry
    toast("Room no longer exists");
    net = null;
    try { sessionStorage.removeItem("ws_room"); } catch {}
    toMenu();
  };
}

function onRoom(room) {
  if (!net) return;
  net.room = room;
  net.offset = room.now - Date.now();
  if (room.state === "lobby" || (room.state === "over" && (!G || $("game").classList.contains("hidden")))) renderLobby(room);
  if (room.state === "playing") {
    if (!G || G.seed !== room.seed || G.startAt !== room.startAt) { mode = "mp"; overlay(null); $("overlay").dataset.kind = ""; startGame(room.seed, room.startAt, room.endAt); }
    renderOpponent();
  }
  if (room.state === "over" && G && !$("game").classList.contains("hidden")) { renderOpponent(); showMatchResult(room); }
}

function renderLobby(room) {
  show("lobby");
  $("lobbyCode").textContent = room.code;
  $("shareLink").value = `${location.origin}/?room=${room.code}`;
  $("lobbyHint").textContent = room.players.length < 2 ? "Waiting for an opponent. Share this link:" : "Opponent joined! Ready up.";
  $("lobbyPlayers").innerHTML = room.players.map((p) => `<li><span>${esc(p.name)}${p.id === net.pid ? " (you)" : ""}</span><span class="${p.ready ? "ok" : ""}">${p.ready ? "Ready ✓" : p.connected ? "Not ready" : "offline"}</span></li>`).join("")
    + (room.players.length < 2 ? `<li><span style="color:var(--muted)">Waiting…</span><span></span></li>` : "");
  const me = room.players.find((p) => p.id === net.pid);
  $("btnReady").disabled = !!me?.ready;
  $("btnReady").textContent = me?.ready ? "Waiting for opponent…" : "I'm ready";
}

function showMatchResult(room) {
  if (G) G.finished = true;
  clearInterval(tick);
  const me = room.players.find((p) => p.id === net.pid);
  const opp = room.players.find((p) => p.id !== net.pid);
  const w = room.winner || {};
  const title = w.id === "draw" ? "Draw!" : w.id === net.pid ? "You win! 🏆" : "You lose";
  const why = { cleared: w.id === net.pid ? "You cleared the board first" : `${esc(opp?.name || "Opponent")} cleared the board first`, time: "Time's up, highest score wins", forfeit: w.id === net.pid ? "Opponent gave up" : "You gave up", left: "Opponent left" }[w.reason] || "";
  const row = (p) => p ? `<tr><td>${esc(p.name)}${p.id === net.pid ? " (you)" : ""}</td><td>${p.catsDone}/${G?.s.cats.length ?? "?"} cats</td><td><b>${p.score}</b></td></tr>` : "";
  showResult(`<h2>${title}</h2><div class="small">${why}</div>
    <table class="result-table">${row(me)}${row(opp)}</table>
    ${opp ? `<button class="primary" id="btnRematch">Rematch</button>` : ""}
    <button class="ghost" onclick="leaveRoom()">Leave</button>`);
  const rb = $("btnRematch");
  if (rb) rb.onclick = () => { rb.disabled = true; rb.textContent = "Waiting for opponent…"; api("ready"); };
}

async function leaveRoom() {
  if (net) { api("leave"); net.es?.close(); }
  net = null;
  try { sessionStorage.removeItem("ws_room"); } catch {}
  toMenu();
}

function toMenu() {
  clearInterval(tick); G = null; overlay(null); $("overlay").dataset.kind = "";
  history.replaceState(null, "", "/");
  show("menu");
}

function solo() {
  if (net) leaveRoom();
  mode = "solo"; overlay(null); $("overlay").dataset.kind = "";
  const t = Date.now();
  startGame((Math.random() * 2 ** 31) >>> 0, t, t + SOLO_SECONDS * 1000);
}

async function enter(path, body) {
  $("menuErr").textContent = "";
  store.set("ws_name", myName());
  try {
    const r = await (await fetch("/api/" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: myName(), ...body }) })).json();
    if (r.error) return ($("menuErr").textContent = r.error);
    connect(r.code, r.pid);
  } catch { $("menuErr").textContent = "Can't reach the server"; }
}

// ---------- wire up ----------
$("name").value = store.get("ws_name") || "";
$("btnQuick").onclick = () => enter("quick");
$("btnCreate").onclick = () => enter("create");
$("btnJoin").onclick = () => enter("join", { code: $("joinCode").value.trim().toUpperCase() });
$("btnSolo").onclick = solo;
$("btnReady").onclick = () => api("ready");
$("btnLeave").onclick = leaveRoom;
$("btnCopy").onclick = () => { navigator.clipboard?.writeText($("shareLink").value); toast("Link copied"); };
$("btnUndo").onclick = undo;
$("btnHint").onclick = hint;
$("btnQuit").onclick = () => { if (mode === "mp") { if (confirm("Give up this match?")) api("forfeit"); } else toMenu(); };
window.addEventListener("resize", () => G && render());

const qRoom = new URLSearchParams(location.search).get("room");
if (qRoom) $("joinCode").value = qRoom.toUpperCase();
try {
  const saved = JSON.parse(sessionStorage.getItem("ws_room") || "null");
  if (saved) connect(saved.code, saved.pid);
} catch {}
