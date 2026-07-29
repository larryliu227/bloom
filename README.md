# BLOOM

> Grow your vine. Cut theirs.

Touch-first territory RTS for phones. One rule carries the whole game: **your territory
must stay connected back to your seedling.** Cut an opponent's neck and everything behind
the cut withers — you kill ground you never touched.

Cutting is the same tap as growing, so there is one interaction and nothing to learn twice.

```
        ┌────────────────────────┐
        │ · · · ▓ ▓ · · ☀ · · · ·│   ▓ rock — the chokepoints
        │ · ● ● ● ▓ · · · 🜁 · · ·│   ☀ sun    — feeds the photosynthesisers
        │ · ● ✿ ● · · ▓ ▓ · · · ·│   ▤ wood   — feeds FUNGAL, braces its holder
        │ · ● · ╳ ← the cut      │   ⁙ insect — feeds SPORE, rots everyone else
        │ · · · ░ ░ ░ ← withering│   🜁 acid   — the ONLY currency tech accepts
        │ · · ▤ ░ ░ · · ⁙ · · · ·│   ✿ seedling — lose it, lose everything
        │ · · · · · · · ✿ ○ ○ · ·│   12 x 18, the whole board always on screen
        └────────────────────────┘
```

## Four larders, and nobody eats from all of them

Every wage in the game is paid by a tile somebody is holding. There is no free trickle
for the scavengers and no way to buy tech without fighting for ground.

| tile | pays | and |
|---|---|---|
| **☀ sun** | vine, moss, thorn — daylight only | **kills** fungal and spore on contact |
| **▤ wood** | fungal, and nothing else pays it | braces its holder ×2 — except THORN, ×0.5 |
| **⁙ insect** | spore, and nothing else pays it | rots its holder ×0.4 (fungal ×0.75) — but SPORE on a grub bed is ×8 |
| **🜁 acid** | everyone, and it is the only thing the **32-tech tree** accepts | three or four cells decide who upgrades at all |

**HOSTILE TAKEOVER** — SPORE's item, **1 acid**. Instantly evaporates every tile in a 9×9
block and sprinkles the ruins with landings. Priced at one so it is a weapon you fire,
not a thing you save up for. FUNGAL and SPORE are immune, so it deletes
the photosynthesisers out of a third of the board and leaves the rot standing in it.
Seedlings survive: a nuke that could take a heart from nine cells away would make the
six-second seedling rule meaningless.

## Five factions, differentiated by verb

Not by stat block. From an identical opening position they produce
13 / 4 / 164 / 4 / 0 legal moves.

| | |
|---|---|
| **VINE** | throws a 4-tile runner down a straight line |
| **MOSS** | claims a 2x2 block, tough, resists cutting |
| **SPORE** | hops over walls; a landing roots and becomes a second seedling |
| **THORN** | plants normally, but every capture infects the neutral cells around it |
| **FUNGAL** | never taps to grow — the mycelium creeps on its own. It does not photosynthesise: **eating is its only income**, so its bite is free and everything else it does is paid for out of somebody else's garden. Roots anywhere, so it cannot be cut |

Plus: territory pays energy (ground compounds), a 60-second day/night cycle, insects that
walk and eat on their own, mutual-consent pacts, and a 31-tech forking tree — two shared
chains you cannot both afford, and a faction branch that splits in two.

FUNGAL's endgame is the swarm, and it is locked behind **BROOD (100)** — roughly fifty
digested tiles. Insects do not exist until it is bought.

Conquer a seedling and it becomes **yours**: a real second root that feeds the ground
around it. SPORE is the exception to losing one — its landings root themselves, so it
plays on for as long as it holds a single tile.

**Tap your own seedling to repel.** Two energy: knocks an assault on your base part of
the way back and shoves anyone on your doorstep to bare soil, then goes on a 3-second
cooldown.

It buys time, it does not buy safety — **the attacker holds the advantage on purpose.**
They picked the moment, they are watching the fight, and nothing warns you that your heart
is being eaten. Measured: an undefended seedling falls in 6 seconds, and one whose owner
repels on every single cooldown falls in 14. Repel early enough and you break the claim
outright; repel late and you are only delaying. A repel with nothing to push costs
nothing.

## The draft

The map is cut *before* anyone has a plant, and you pick after you have seen it.

```
        OPEN FIELD                      THE WARREN
  wide runs, nowhere to hide      cramped, everything touches
        → VINE, MOSS                    → THORN, MOSS

      WALLED GARDEN                     STONE ROWS
 a wall across every approach     chokepoints everywhere
        → SPORE hops it                 → FUNGAL, SPORE
```

Maps are **deliberately unfair**. One spawn gets a sun on its doorstep and open ground;
another gets boxed in behind a wall. That asymmetry is the whole reason the draft exists —
a perfectly fair board would make the choice meaningless, because every spot would want the
same plant.

## Play

```bash
npm install
npm run dev
```

Open **http://localhost:5173** — that one URL serves the game and the socket both, in
development and in production, so there is never a host to configure.

Vite binds `0.0.0.0`, so a phone on the same Wi-Fi joins at `http://<your-lan-ip>:5173`.

### Online

- **QUICK MATCH** — dropped into any open garden, or a fresh one.
- **START A GARDEN** — get a 6-character room code and a **COPY LINK** button. Anyone who
  opens that link lands straight in the room; no code to type.
- **JOIN** — type a code somebody read out loud (the alphabet has no O/0/I/1).

Up to 5 gardens per room, 2 to start. The host can fill empty seats with bots. Plants are
**not** reserved — five gardens may all play VINE if they all fancy it; gardens are told
apart by seat colour, not by faction.

Drop your Wi-Fi mid-match and you have 20 seconds to reconnect into your own garden — it
keeps growing while you are gone. Quit for good and the machine takes your chair, so the
match stays winnable instead of leaving a statue on the board.

### Solo

**PLAY SOLO** runs the identical simulation on the device against four bots, no server.

## Deploy

```bash
npm run build
npm start          # one port serves the built client AND the WebSocket
```

See [docs/DEPLOY.md](docs/DEPLOY.md). `Dockerfile`, `fly.toml`, `render.yaml` and
`railway.json` are all set up for a single-process deploy; `/health` reports rooms,
players and sockets.

## Architecture

Authoritative server at 20 Hz. The board is small enough (216 cells) that the server ships
the **whole match state** in every snapshot, which deletes an entire class of desync bug —
so there is no prediction and no reconciliation anywhere in the client.

```
shared/   the game. bloom.ts (types + tuning), rules.ts (legality), garden.ts (the sim)
server/   ws transport, rooms, lobby, reconnect, the tick loop
client/   canvas2d board + input, the socket, the screens
```

`shared/garden.ts` is the single simulation, run by the server as authority and by the
client for solo play. There is deliberately no second implementation of "what does a tap
do" — that is how the highlight under your thumb can never disagree with the outcome.

The one gameplay input is `tap`. Everything else the player can do (`buyTech`, `hatch`,
`pact`) is a deliberate, occasional act. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
and [docs/BLOOM.md](docs/BLOOM.md).

Stack: Node + TypeScript + `ws` + Vite + Canvas2D. One runtime dependency.
