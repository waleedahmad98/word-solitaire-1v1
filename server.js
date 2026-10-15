// Zero-dependency 1v1 server: static files + Server-Sent Events for push, JSON POSTs for actions.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const MATCH_SECONDS = 360;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

const rooms = new Map(); // code -> room
let quickQueue = null; // code of a public room waiting for an opponent

function newRoom(isPublic) {
  let code;
  do code = crypto.randomBytes(3).toString("hex").toUpperCase().slice(0, 5); while (rooms.has(code));
  const room = { code, isPublic, players: {}, state: "lobby", seed: 0, startAt: 0, winner: null, timer: null };
  rooms.set(code, room);
  return room;
}

function publicView(room) {
  return {
    code: room.code, state: room.state, seed: room.seed, startAt: room.startAt,
    endAt: room.startAt ? room.startAt + MATCH_SECONDS * 1000 : 0,
    winner: room.winner, now: Date.now(),
    players: Object.values(room.players).map((p) => ({
      id: p.id, name: p.name, ready: p.ready, connected: !!p.res,
      score: p.score, catsDone: p.catsDone, cardsLeft: p.cardsLeft, finishedAt: p.finishedAt, moves: p.moves,
    })),
  };
}

function broadcast(room, event = "room", data = publicView(room)) {
  for (const p of Object.values(room.players)) if (p.res) p.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function addPlayer(room, name) {
  if (Object.keys(room.players).length >= 2) return null;
  const id = crypto.randomBytes(8).toString("hex");
  room.players[id] = { id, name: String(name || "Player").slice(0, 16), ready: false, res: null, score: 0, catsDone: 0, cardsLeft: 0, finishedAt: 0, moves: 0 };
  return id;
}

function maybeStart(room) {
  const ps = Object.values(room.players);
  if (ps.length !== 2 || !ps.every((p) => p.ready) || room.state === "playing") return;
  room.state = "playing";
  room.seed = crypto.randomInt(1, 2 ** 31);
  room.startAt = Date.now() + 3500; // countdown
  room.winner = null;
  for (const p of ps) Object.assign(p, { score: 0, catsDone: 0, cardsLeft: 0, finishedAt: 0, moves: 0 });
  clearTimeout(room.timer);
  room.timer = setTimeout(() => endMatch(room, "time"), room.startAt - Date.now() + MATCH_SECONDS * 1000);
  broadcast(room);
}

function endMatch(room, reason, winnerId) {
  if (room.state !== "playing") return;
  clearTimeout(room.timer);
  const ps = Object.values(room.players);
  if (!winnerId) {
    const [a, b] = ps;
    winnerId = !b ? a?.id : a.score === b.score ? (a.catsDone === b.catsDone ? "draw" : a.catsDone > b.catsDone ? a.id : b.id) : a.score > b.score ? a.id : b.id;
  }
  room.state = "over";
  room.winner = { id: winnerId, reason };
  for (const p of ps) p.ready = false;
  broadcast(room);
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 1e4) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
  });
}
const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

const api = {
  async create(body) {
    const room = newRoom(false);
    return { code: room.code, pid: addPlayer(room, body.name) };
  },
  async join(body) {
    const room = rooms.get(String(body.code || "").toUpperCase());
    if (!room) return { error: "Room not found" };
    const pid = addPlayer(room, body.name);
    if (!pid) return { error: "Room is full" };
    if (quickQueue === room.code) quickQueue = null;
    broadcast(room);
    return { code: room.code, pid };
  },
  async quick(body) {
    const waiting = quickQueue && rooms.get(quickQueue);
    if (waiting && Object.keys(waiting.players).length === 1) return api.join({ code: waiting.code, name: body.name });
    const room = newRoom(true);
    quickQueue = room.code;
    return { code: room.code, pid: addPlayer(room, body.name) };
  },
  async ready(body, room, p) {
    p.ready = true;
    broadcast(room);
    maybeStart(room);
    return {};
  },
  async progress(body, room, p) {
    if (room.state !== "playing") return {};
    p.score = Math.max(-100000, Math.min(100000, body.score | 0));
    p.catsDone = body.catsDone | 0;
    p.cardsLeft = body.cardsLeft | 0;
    p.moves = body.moves | 0;
    if (body.finished && !p.finishedAt) {
      p.finishedAt = Date.now();
      broadcast(room);
      endMatch(room, "cleared", p.id); // fastest to clear the board wins
      return {};
    }
    broadcast(room);
    return {};
  },
  async forfeit(body, room, p) {
    const other = Object.values(room.players).find((x) => x.id !== p.id);
    endMatch(room, "forfeit", other?.id);
    return {};
  },
  async leave(body, room, p) {
    p.res?.end();
    delete room.players[p.id];
    if (room.state === "playing") { const other = Object.values(room.players)[0]; endMatch(room, "left", other?.id); }
    if (!Object.keys(room.players).length) { clearTimeout(room.timer); rooms.delete(room.code); if (quickQueue === room.code) quickQueue = null; }
    else broadcast(room);
    return {};
  },
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/events") {
    const room = rooms.get(url.searchParams.get("code"));
    const p = room?.players[url.searchParams.get("pid")];
    if (!p) return json(res, 404, { error: "not in room" });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    p.res?.end();
    p.res = res;
    broadcast(room);
    const ping = setInterval(() => res.write(": ping\n\n"), 20000);
    req.on("close", () => { clearInterval(ping); if (p.res === res) { p.res = null; broadcast(room); } });
    return;
  }
  if (url.pathname.startsWith("/api/") && req.method === "POST") {
    const fn = api[url.pathname.slice(5)];
    if (!fn) return json(res, 404, { error: "unknown" });
    const body = await readBody(req);
    if (["create", "join", "quick"].includes(fn.name)) return json(res, 200, await fn(body));
    const room = rooms.get(body.code);
    const p = room?.players[body.pid];
    if (!p) return json(res, 404, { error: "not in room" });
    return json(res, 200, await fn(body, room, p));
  }
  // static
  const file = path.normalize(path.join(PUBLIC, url.pathname === "/" ? "index.html" : url.pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, () => console.log(`Word Solitaire 1v1 on http://localhost:${PORT}`));
