# BLOOM — design & module contract

> Replaces VOIDLINE. The engine (netcode, rooms, lobby, matchmaking, reconnect,
> renderer scaffolding, audio) is KEPT. The game on top of it is new.
> Read this fully before writing code. Multiple agents build in parallel.

---

## The game in one sentence

**Grow your vines across a garden grid. Cut someone else's vine and everything past
the cut withers.**

## Why it is built this way (read this, it is the whole point)

The previous design failed for three reasons. Do not reintroduce any of them.

1. **The puzzle was a gate, not a pressure.** It was solved in 0.1 s and then never
   mattered. Here, your territory must stay physically connected back to your Home
   tile *at all times*, and opponents are severing it constantly. It is never solved.
2. **The puzzle sat beside combat.** Here there is exactly one interaction — tapping a
   tile — and it is simultaneously your expansion, your attack, and your puzzle move.
3. **Roles differed by numbers.** Here each role has a different *verb*. They are five
   different games sharing one board.

## Hard requirements

- **Touch-first.** Tap and drag only. No keyboard, no mouse-aim, no twitch. Must be
  fully playable one-handed on a phone in **portrait**. Desktop is the secondary case.
- **Kid-simple.** A 8-year-old should understand it in 20 seconds without reading.
  Colour and shape do the teaching, not text. No stat blocks, no numbers on screen
  except your energy.
- **Real-time strategy.** You command territory, not an avatar. No character to steer.
- **2D, Canvas2D**, same renderer stack.
- **Online multiplayer**, same server, rooms and lobby.

---

## Board

- Square grid, **4-neighbour** connectivity (no diagonals — simpler to read and to reason about).
- **12 wide × 18 tall** for portrait phones. The whole board is always on screen; there
  is no camera to pan. This is deliberate: a kid must never be lost.
- Each cell is one of:
  - `empty` — plain soil, claimable
  - `owned` — belongs to a player (tint by player colour)
  - `rock` — permanently blocked, never claimable. Makes chokepoints and shapes the map.
  - `sun` — a resource tile; whoever owns it earns energy faster
  - `home` — a player's root. **Indestructible, but if it is ever surrounded so nothing
    can grow, that player is dead.** Lose your home tile and you lose.

## The core loop

1. **Tap an empty tile next to your territory** → it starts growing (a visible fill
   animation, ~1.2 s), costs energy.
2. **Tap an enemy tile next to your territory** → it starts being taken (~2.0 s).
3. **Connectivity is checked every tick.** Any owned tile with no path back to its
   owner's `home` through that owner's own tiles begins to **wither** (2 s) and then
   turns neutral.
4. Therefore: **capturing one tile can kill fifty.** Cutting a narrow neck is the whole
   strategic game, and it is instantly legible on screen — a whole limb greys out.

Energy: passive `+1 / 3 s`, plus `+1 / 2 s` per `sun` tile owned. Growth costs 1,
attacking costs 2. Energy is the only number on screen.

## Win conditions

- Take an opponent's `home` neighbourhood so they cannot grow, **or**
- Hold **60 % of claimable tiles for 15 continuous seconds**.
- Co-op: contain and destroy the Blight (below).

---

## The five roles — different VERBS, not different stats

Each role's growth rule is genuinely a different game. Keep these ids.

| id | name | colour | verb |
|---|---|---|---|
| `vine` | **VINE** | `#3ddc6b` green | Grows **two tiles in a straight line** per tap, fast (0.8 s). Cheap. But its tiles wither **twice as fast** when cut. Sprinter. |
| `moss` | **MOSS** | `#4da3ff` blue | Every claim takes a **2×2 block** (whatever of it is legal). Slow (2.0 s) and expensive, but moss tiles take **twice as long** for enemies to capture. Tank. |
| `spore` | **SPORE** | `#c46bff` violet | **Cannot grow adjacently at all.** Taps **any empty tile anywhere** on the board to drop a spore. A spore withers in **8 s** unless it connects to your network. Plays leapfrog and lands behind enemy lines. |
| `thorn` | **THORN** | `#ff5a3c` red | Grows on neutral at **half speed**, but **captures enemy tiles at double speed** and pays no extra energy for it. Parasite — weak alone, terrifying in contact. |

Roles must feel different within 10 seconds of play. If two roles feel similar, the
design has failed again — say so rather than shipping it.

## Modes

- **DUEL** — 1v1, first to win condition.
- **GARDEN** — free-for-all, 2–5 players. Plants are drafted after the map is dealt, and are not exclusive.
- **CO-OP vs THE BLIGHT** — 1–4 players against a spreading grey AI creeper that grows
  on its own rules and punishes disconnection. Kid-friendly PvE, and the tutorial lives
  in its first level.

---

## What is KEPT from the old codebase (do not rewrite these)

| Keep | Why |
|---|---|
| `server/index.ts`, `net.ts`, `room.ts`, `lobby.ts`, `matchmaking.ts` | WS transport, rooms, lobby, host migration, room codes, reconnect tokens, rate limiting, security hardening — all verified |
| `client/net/connection.ts` | reconnect + backoff + ping, secret-token handshake |
| `client/render/*`, `client/audio/*` | Canvas2D + generative audio, both concept-independent |
| `Dockerfile`, `fly.toml`, `render.yaml`, CI, `docs/DEPLOY.md` | deployment |
| WebSocket compression, `/health`, graceful shutdown | verified in production mode |

## What is DELETED

`shared/weave.ts`, `shared/abilities.ts`, `shared/roles.ts`, `shared/sim.ts`,
`shared/combat.ts`, `server/systems/*`, `server/modes/*`, `server/content/*`,
`client/ui/weave.ts`, `client/ui/loadout.ts`, `client/ui/hud.ts`.

Anything replaced must be replaced wholesale — do not leave a half-ported file.

---

## Ground rules

1. TypeScript strict, 0 errors. Relative ESM imports need `.js`.
2. Server is authoritative. The client sends **taps**, never outcomes.
3. Deterministic sim; seeded RNG only, never `Math.random()`/`Date.now()` in sim code.
4. The board is small state — send the **whole board** each snapshot. It compresses to
   almost nothing and removes a whole class of desync bugs.
5. **Touch targets ≥ 44 px.** Test at 393×852 before claiming done.
6. No text tutorials. If something needs a paragraph to explain, redesign it.
