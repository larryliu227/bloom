# VOIDLINE — Architecture & Module Contract

> **Read this fully before writing code.** Multiple agents build this repo in parallel.
> Stay inside your assigned files. Import across modules using the signatures declared
> here — they are a contract. If a function you need does not exist yet, **import it
> anyway and code against the declared signature**; the owning agent is writing it now.

---

## The game in one paragraph

Top-down real-time arena combat for 2–8 players over WebSockets. Your abilities have
**no cooldowns** — they have **circuits**. You pick a **role** and **3 abilities**. Those
3 abilities become the 3 output slots on your personal **Weave board**: a grid of conduit
tiles you rotate in real time to route power from a central core to a slot. A connected
slot charges; a charged slot can fire. You are solving a live routing puzzle *while*
dodging. Enemy hits can **block cells** on your board, forcing re-routes mid-fight.

- **PvP** — duel (1v1) and arena (FFA/teams). Puzzle skill and combat skill both matter.
- **Co-op story** — 4 players, 5 chapters, waves + bosses. Some objectives need
  **cross-player circuits**: `relay` tiles mirror an ally's board, so two people must
  route together to open a seal.

Setting: sci-fi. A derelict deep-space station, *Voidline Station*, whose reactor is
fracturing. Players are "runners" jacked into its conduit lattice.

---

## Stack

- **Runtime**: Node 24, TypeScript (ESM), `tsx` for the server, Vite for the client.
- **Client**: Vite + TypeScript + **Canvas2D**. No rendering framework, no game engine.
- **Transport**: `ws` WebSockets, JSON messages (see `shared/protocol.ts`).
- **Imports**: use the `@shared/*` alias. Always include the `.js` extension on relative
  ESM imports (e.g. `import { x } from './weave.js'`) — required for `tsx`/Node ESM.

Run: `npm run dev` → server on `:8080`, client on `:5173` (bound to `0.0.0.0` for LAN).

---

## Authority model — non-negotiable

The **server** owns all truth: positions, damage, charge, deaths, objectives.
The **client** may predict its own movement and render optimistically. The client
**never** authors damage, charge, kills, or ability effects.

- Client sends `InputFrame`s at 30 Hz with a monotonic `seq`.
- Server simulates at **20 Hz** (`TICK_RATE`) and broadcasts full `WorldState` snapshots
  at 20 Hz with `ackSeq`.
- Client renders at 60 fps: **local player predicted + reconciled**, **remote entities
  interpolated** `INTERP_DELAY_MS` (100 ms) in the past.
- Weave boards are private. Server sends a `weave` message **only to that board's owner**
  whenever it changes. Never broadcast another player's board (except coop relay mirrors).

---

## Already written — do not modify

| File | Contents |
|---|---|
| `shared/constants.ts` | All tuning numbers. Add new constants here; never hardcode. |
| `shared/types.ts` | All domain types. **Source of truth for state shape.** |
| `shared/protocol.ts` | Wire messages `ClientMsg` / `ServerMsg`, `InputFrame`, `ActionBit`. |
| `package.json`, `tsconfig.json`, `vite.config.ts` | Project setup. |

If you genuinely need a new *type* or *constant*, add it to those files additively
(never rename or remove an existing member) and note it in your final report.

---

## File ownership map

Each row is owned by exactly one agent. **Do not create or edit files outside your row.**

| Owner | Files | Responsibility |
|---|---|---|
| **A — Weave** | `shared/weave.ts` | Puzzle engine: tiles, rotation, connectivity, charge |
| **B — Content** | `shared/roles.ts`, `shared/abilities.ts` | 4 roles, ~28 abilities, all data-driven |
| **C — Sim** | `shared/math.ts`, `shared/sim.ts`, `shared/combat.ts` | Movement, collision, damage, statuses, ability resolution |
| **D — Server** | `server/index.ts`, `server/room.ts`, `server/lobby.ts`, `server/net.ts`, `server/matchmaking.ts` | WS server, rooms, lobby, tick loop, snapshots |
| **E — Renderer** | `client/render/*` | Canvas2D arena rendering, camera, particles, juice |
| **F — Client shell** | `client/main.ts`, `client/net/*`, `client/ui/*`, `index.html`, `client/style.css` | Input, prediction, screens, HUD, Weave UI |
| **G — Co-op** | `server/modes/coop.ts`, `server/systems/enemies.ts`, `server/systems/director.ts`, `server/content/chapters.ts` | Story campaign, enemy AI, bosses |
| **H — PvP** | `server/modes/pvp.ts`, `server/systems/scoring.ts` | Duel + arena modes, spawns, rounds, scoring |

---

## Declared module APIs

These signatures are **fixed**. Implement them exactly; call them freely.

### A — `shared/weave.ts`

```ts
import type { WeaveBoard, WeaveTile, EdgeMask, AbilityId, AbilityDef } from './types.js';

/** Build a fresh board. Deterministic given `seed`. Guarantees a solvable layout. */
export function createBoard(size: number, loadout: AbilityId[], seed: number): WeaveBoard;

/** Rotate a tile clockwise. Returns false if index invalid or tile locked. */
export function rotateTile(board: WeaveBoard, index: number): boolean;

/** Flood-fill from the core; sets `tile.powered` and `slot.connected`. Call after any mutation. */
export function recomputePower(board: WeaveBoard): void;

/** Advance charge/decay. Returns slot indices that became fireable this step. */
export function updateCharge(board: WeaveBoard, dt: number, chargeRateMul: number, costs: number[]): number[];

/** True if the slot has enough charge for `ability`. */
export function canFire(board: WeaveBoard, slot: number, ability: AbilityDef): boolean;

/** Spend the charge. Returns the overcharge multiplier (1.0 .. MAX_OVERCHARGE). */
export function consumeCharge(board: WeaveBoard, slot: number, ability: AbilityDef): number;

/** Convert a permanently-blocked cell somewhere on the board (enemy "conduit burst" attack). */
export function damageBoard(board: WeaveBoard, seed: number): number;

/** Randomize rotations of all unlocked tiles (boss mechanic / round reset). */
export function scrambleBoard(board: WeaveBoard, seed: number): void;

/** Edge mask after applying the tile's rotation. */
export function edgeMaskFor(tile: WeaveTile): EdgeMask;

/** Coop: link two boards so `relay` tiles at the same index share power. */
export function linkRelays(boards: WeaveBoard[]): void;
```

Design rules for A:
- Core sits at the board center. The 3 `slot` tiles sit on distinct edges, spread apart.
- `createBoard` must guarantee at least one valid routing exists to **every** slot, but must
  **not** start solved — scramble rotations after generating the solution.
- Difficulty comes from path length, not from unsolvability. Never generate a dead board.
- Keep it pure and deterministic. No `Date.now()`, no `Math.random()` — take a seed.

### B — `shared/roles.ts` + `shared/abilities.ts`

```ts
export const ROLES: Record<RoleId, RoleDef>;
export const ROLE_LIST: RoleDef[];
export function getRole(id: RoleId): RoleDef;
export function defaultLoadout(id: RoleId): AbilityId[];
/** Sanitize client input: keeps only legal ids for the role, pads to ABILITY_SLOTS. */
export function validateLoadout(role: RoleId, loadout: AbilityId[]): AbilityId[];

export const ABILITIES: Record<AbilityId, AbilityDef>;
export function getAbility(id: AbilityId): AbilityDef;
export function abilitiesForRole(role: RoleId): AbilityDef[];
```

The four roles (keep these ids and identities):
- **`breaker`** — heavy ordnance. High damage, low HP, small fast board. Color `#ff5a3c`.
- **`bulwark`** — frontline. High HP, slow, large board with pre-locked helpful tiles. Color `#4da3ff`.
- **`conduit`** — support. Heals, shields, overclocks allies; can push power to ally slots.
  Essential in co-op, oppressive-if-ignored in PvP. Color `#3cffa8`.
- **`phantom`** — mobility assassin. Blink, cloak, burst. Tiny board, very fast charge. Color `#c46bff`.

Give each role **7 abilities** so a 3-slot loadout is a real choice, plus 1 `basicAttack`.
Every `AbilityDef` field must be filled with tuned, playable numbers. Balance target:
a role should reliably kill a same-skill opponent in 4–7 landed abilities.

### C — `shared/math.ts`, `shared/sim.ts`, `shared/combat.ts`

```ts
// math.ts — pure helpers
export function makeRng(seed: number): () => number; // mulberry32
export const v: { add, sub, scale, len, norm, dist, dot, lerp, rot, angle, fromAngle };
export function clamp(n: number, lo: number, hi: number): number;
export function lerp(a: number, b: number, t: number): number;
export function circleHit(a: Vec2, ar: number, b: Vec2, br: number): boolean;
export function segmentCircle(p0: Vec2, p1: Vec2, c: Vec2, r: number): boolean;

// sim.ts — the deterministic step function
export interface SimContext {
  world: WorldState;
  rng: () => number;
  nextId(): EntityId;
  emit(e: GameEvent): void;
  /** Present on the server only; mode handlers hook damage/death. */
  hooks?: SimHooks;
}
export interface SimHooks {
  onDamage?(ctx: SimContext, target: Entity, amount: number, source: Entity | null): void;
  onDeath?(ctx: SimContext, entity: Entity, killer: Entity | null): void;
}
/** Advance the whole world one step. Movement, projectiles, zones, statuses, collision. */
export function stepWorld(ctx: SimContext, inputs: Map<PlayerId, InputFrame>, dt: number): void;
/** Movement-only step used by client-side prediction for the local player. */
export function stepPlayerMovement(p: PlayerEntity, input: InputFrame, dt: number, speedMul: number): void;

// combat.ts — ability resolution
export function fireAbility(ctx: SimContext, caster: Entity, ability: AbilityDef, aim: Vec2, overcharge: number): void;
export function applyDamage(ctx: SimContext, target: Entity, amount: number, source: Entity | null): void;
export function applyStatus(ctx: SimContext, target: Entity, status: Status): void;
export function tickStatuses(ctx: SimContext, e: Entity, dt: number): void;
export function isHostile(a: Entity, b: Entity): boolean;
```

`stepPlayerMovement` must be **byte-identical in behavior** on client and server —
prediction depends on it. Keep it free of RNG and free of world lookups beyond arena bounds.

### D — `server/*`

```ts
// net.ts
export class Client { id: PlayerId; name: string; send(msg: ServerMsg): void; roomId: RoomId | null; }
// room.ts
export class Room {
  id: RoomId; mode: GameMode; phase: MatchPhase;
  join(c: Client): boolean; leave(c: Client): void;
  handle(c: Client, msg: ClientMsg): void;
  tick(dt: number): void;          // called at TICK_RATE by the server loop
  broadcast(msg: ServerMsg): void;
}
// modes — G and H implement this; D defines and calls it
export interface ModeHandler {
  readonly mode: GameMode;
  onMatchStart(room: Room, ctx: SimContext): void;
  onTick(room: Room, ctx: SimContext, dt: number): void;
  onDamage(ctx: SimContext, target: Entity, amount: number, source: Entity | null): void;
  onDeath(room: Room, ctx: SimContext, entity: Entity, killer: Entity | null): void;
  /** Return non-null to end the match. */
  checkComplete(room: Room, ctx: SimContext): MatchResult | null;
  /** Where a joining/respawning player spawns. */
  spawnPoint(room: Room, player: PlayerEntity): Vec2;
}
export function createModeHandler(mode: GameMode, chapter: number): ModeHandler;
```

D owns the tick loop, snapshot broadcast, input buffering + `ackSeq`, ping/pong,
room lifecycle, `quickPlay` matchmaking, and per-player `weave` message dispatch.
D also owns serving the built client in production and graceful disconnect handling
(a dropped player's entity stays for 20 s so they can reconnect into the same slot).

### E — `client/render/*`

```ts
// client/render/renderer.ts
export class Renderer {
  constructor(canvas: HTMLCanvasElement);
  resize(): void;
  render(view: RenderView, dtMs: number): void;
}
export interface RenderView {
  world: WorldState;      // interpolated
  selfId: EntityId;
  camera: { x: number; y: number; zoom: number };
  aim: Vec2;
}
// client/render/particles.ts
export class ParticleSystem { emit(...): void; update(dt): void; draw(ctx, cam): void; }
// client/render/camera.ts
export class Camera { follow(target: Vec2, dt: number): void; shake(mag: number): void; toScreen(p: Vec2): Vec2; toWorld(p: Vec2): Vec2; }
```

E must make this **look expensive with plain Canvas2D**: additive glow via
`globalCompositeOperation='lighter'`, layered starfield parallax, conduit-line floor grid
that pulses toward the arena core, per-entity trails, impact sparks, hitstop, screenshake,
telegraph rings for enemy windups, damage numbers. Target a locked 60 fps with 8 players +
40 enemies + 300 particles. Sci-fi palette: near-black `#06080f` background, cyan/violet
energy, warm orange for danger.

### F — `client/main.ts`, `client/net/*`, `client/ui/*`

Owns: the game loop, `Connection` (reconnect + ping), input capture, **client-side
prediction & reconciliation**, and all screens:
- **Title / Play** — name entry, Quick Play, Create Room, Join by code.
- **Lobby** — player list, mode, chapter select (co-op), ready-up.
- **Loadout** — role picker (4 cards) + ability picker (choose 3 of 7), with a live
  preview of what the Weave board will look like. This screen must feel good; it is the
  first thing players see of the game's identity.
- **HUD** — HP, shield, dash, 3 slot gauges, objective banner, dialogue box, scoreboard (Tab).
- **Weave panel** — the interactive board, bottom-right, click a tile to rotate. Must
  clearly show power flow (animated energy travelling along connected conduits) and which
  slot is charging. This is the heart of the game — invest in it.

```ts
// client/net/connection.ts
export class Connection {
  constructor(url: string);
  send(msg: ClientMsg): void;
  on<T extends ServerMsg['t']>(t: T, fn: (m: Extract<ServerMsg, {t:T}>) => void): void;
  readonly ping: number;
}
```

### G — co-op story

5 chapters aboard Voidline Station, each ~8–12 minutes:
1. **Docking Spine** — tutorialised: teaches routing under light pressure.
2. **Coolant Gallery** — introduces `blocked` cells + a hazard that damages your board.
3. **The Choir** — first cross-player **relay circuit** seal; 2 players must route together.
4. **Reactor Shell** — escort/defend under heavy waves.
5. **The Fracture** — multi-phase boss that **scrambles your board** between phases.

Enemy archetypes (at least 7): chaser, ranged spitter, shielded bulwark, splitter, sapper
(attacks your Weave), turret, elite. Each needs a readable telegraph via `telegraph` /
`telegraphKind`. Plus 2 bosses. Wave director scales to player count. Write the story
beats as `dialogue` events — terse, atmospheric, no exposition dumps.

### H — PvP

- **`pvp_duel`** — 1v1, best of 5 rounds, boards reset + scramble between rounds.
- **`pvp_arena`** — up to 8, FFA or auto-balanced teams, first to score limit.
Owns spawn selection (away from enemies), round flow, kill/assist scoring, killstreaks,
and a comeback mechanic so a losing player is not locked out of their own board.

---

## Ground rules for everyone

1. **TypeScript strict.** No `any` unless genuinely unavoidable; no `@ts-ignore`.
2. **No new dependencies** without saying so in your report. `ws` is the only runtime dep.
3. **Deterministic sim.** No `Math.random()` or `Date.now()` inside simulation code — use
   the seeded RNG from `SimContext`. Wall-clock is fine in the server loop and the client.
4. **Relative ESM imports need `.js`** (`./weave.js`), cross-package uses `@shared/...`.
5. Write the code as if it ships. Real numbers, real content, no `// TODO: implement`.
6. Before finishing, run `npx tsc --noEmit` and fix every error **in your own files**.
   Errors in other agents' unwritten files are expected — ignore those.
7. In your final report: list files written, any type/constant you added to the shared
   files, anything you stubbed, and anything the integrator must wire up.
