# Word Solitaire 1v1

An ad-free web take on word-association solitaire (in the style of *Solitaire Associations: Journey*), with a realtime 1v1 race mode.

## Run

```bash
node server.js        # Node 18+, no npm install needed
```

Open http://localhost:3000. To play someone on your network or online, deploy it anywhere that runs Node (Render, Fly.io, Railway, a VPS) and share the room link.

## Modes
- **Quick match**: pairs you with the next player who presses Quick match.
- **Private room**: creates a 5-character code and share link.
- **Practice solo**: 10-minute timer, no server round-trips.

## 1v1 rules
- Both players get the **same deal** (the server picks a seed; the deal generator is deterministic).
- 3-second countdown, then a 6-minute match.
- **First to clear every category wins.** If time runs out, the higher score wins (category count breaks ties).
- Scoring: +10 per word sent home, +50 per completed category, +1 per second left when you clear. Hint −15, Undo −10.
- Opponent score and category progress update live.

## How it works
| File | Purpose |
|---|---|
| `public/game.js` | Rules engine, seeded deal generator, and a playout solver that only accepts winnable deals |
| `public/words.js` | 40 original categories × 7 words |
| `public/app.js` | UI: rendering, tap/drag input, HUD, lobby, networking |
| `server.js` | Static files, rooms/matchmaking, Server-Sent Events push, match timer and winner calls |

## Reverse-engineering notes (from the 1.23.1 XAPK)
- Unity IL2CPP build. Gameplay types were read from `global-metadata.dat`: `Level { CardColumns, Categories }`, `CardColumn { Cards: WordData[] }`, `WordData { WordId, CategoryId }`.
- Card types `Word`, `Joker`. Card states `Invisible` (face-down), `Stock`, `PlayStack`, `HomeCategory`.
- Move types `PlaceToPlayStack`, `PlaceToHome`, `StockCard`. Rule errors `CategoryWrongStart`, `WordWrongOrder`, `HomeWrongOrder`.
- Boosters Hint, Undo, Joker. Moves limit (`MovesLimit`). A level solver (`SimulationController.TryToWinLevel`).
- Level content (`SolitaireGameContent/<LANG>/*.assetbundle`) is encrypted and was **not** decrypted or used. All words and art here are original.

## Known limits
- Scores are reported by the clients, so a modified client could cheat. For competitive play, move validation should run on the server (the engine already runs in Node).
- Rooms are kept in memory, so restarting the server ends any open matches.
