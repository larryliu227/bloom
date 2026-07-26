# VOIDLINE

> Your abilities don't have cooldowns. They have circuits.

Online multiplayer puzzle-combat. Real-time top-down arena fighting where every ability
you own is powered by a live routing puzzle you solve *while* you're dodging.

```
        ARENA                                  YOUR WEAVE
 ┌────────────────────────────┐          ┌───┬───┬───┬───┬───┐
 │        ✦                   │          │ ╔═╧═╗ │ ═╣ │   │ │
 │    ~~~~>        ▲          │          ├───┼───┼───┼───┼───┤
 │  ◉          @               │          │   │ ╚═╤═╗ │   │ │
 │        ▲          ~~~>     │          ├───┼───┼───┼───┼───┤
 └────────────────────────────┘          │  [CORE]  │   │   │
   real-time, 20Hz authoritative         └───┴───┴───┴───┴───┘
                                          ✸ PULSE LANCE ███░░ 
                                          ❋ NULL FIELD  █░░░░
                                          ⬢ HARD LIGHT  ░░░░░
```

## The loop

1. Pick a **role** and **3 abilities**.
2. Those 3 abilities become the 3 output slots on your personal **Weave board**.
3. Rotate conduit tiles to route power from the core to a slot. Connected → it charges.
4. Charged → you can fire it. Hold the circuit longer → **overcharge** for a bigger hit.
5. Enemies can **block cells** on your board. Bosses **scramble** it. Re-route under fire.

Two axes of skill at once: aim and movement, *and* how fast you can think in circuits.

## Roles

| Role | Identity | Board |
|---|---|---|
| **Breaker** | Heavy ordnance. Glass cannon. | Small, fast |
| **Bulwark** | Frontline. Soaks and holds space. | Large, partly pre-locked |
| **Conduit** | Support. Heals, shields, overclocks allies. | Balanced, fast charge |
| **Phantom** | Blink-and-burst assassin. | Tiny, very fast charge |

Each role has 7 abilities; you take 3. Poke build, burst build, zone-control build.

## Modes

- **Duel** — 1v1, best of 5. Boards regenerate and scramble between rounds.
- **Arena** — up to 8, FFA or auto-balanced teams.
- **Co-op Story** — up to 4 players, 5 chapters aboard *Voidline Station* as its reactor
  fractures. Waves, objectives, and two bosses. Some seals need **cross-player circuits** —
  `relay` tiles mirror an ally's board, so two people have to route *together*.

## Run it

```bash
npm install
npm run dev
```

- Client: http://localhost:5173
- Server: ws://localhost:8080

Both bind to `0.0.0.0`, so anyone on your network can join at `http://<your-lan-ip>:5173`.

Production:

```bash
npm run build
npm start          # serves the built client and the WS server on one port
```

## Controls

| | |
|---|---|
| **WASD** | move |
| **Mouse** | aim |
| **Left click** | basic attack (free, not routed) |
| **1 / 2 / 3** | fire Weave slots |
| **Space / Shift** | dash (i-frames) |
| **F** | interact / revive |
| **Click a tile** | rotate it clockwise |
| **Tab** | scoreboard |

## Architecture

Authoritative server at 20 Hz, client renders at 60 with prediction + reconciliation.
See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full module contract.

```
shared/   deterministic sim, weave engine, roles + abilities — imported by BOTH sides
server/   ws transport, rooms, lobby, tick loop, game modes, enemy AI
client/   canvas2d renderer, prediction, screens, the Weave panel
```

Stack: Node + TypeScript + `ws` + Vite + Canvas2D. One runtime dependency.
