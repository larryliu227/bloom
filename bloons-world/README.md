# BLOONS WORLD

A 2D pixel world you walk around in, together. Right now that is all it is: walking,
and other people.

```
        ┌──────────────────────────┐
        │  · ·  ▮        · ·    ·  │   ▮ somebody else
        │    ·      ▮ you     ·    │
        │  ·    · ·        ·    ·  │   64 x 64 tiles of grass
        └──────────────────────────┘
```

## Play

```bash
npm install
npm run dev
```

Open **http://localhost:5174**. It asks your name once and remembers it.

- **WASD** or **arrow keys** to walk.
- On a phone, **press anywhere** — that spot becomes a thumbstick for as long as you
  hold it, so there is no fixed pad to find and no wrong place to put your thumb.

Vite binds `0.0.0.0`, so anyone on your Wi-Fi joins at `http://<your-lan-ip>:5174`
and appears next to you. There is no lobby and no room code — one world, everybody
in it.

## Deploy

```bash
npm run build
npm start          # one port serves the built client AND the WebSocket
```

The client derives its socket URL from the page origin (`https:` → `wss:`), so there
is no host to configure in dev, in production, or on a phone.

## How it works

Authoritative server at 20 Hz. The client sends **intent** — "I am pushing
north-east" — never a position, so a client cannot put itself somewhere the server
disagrees with, and clamping that vector is the whole anti-cheat surface of a
walking game.

```
shared/   world.ts (the rules of walking), protocol.ts (the wire)
server/   http + ws on one port, the 20 Hz loop
client/   canvas renderer, input, the socket
```

Two pieces of netcode carry the feel:

- **You are predicted locally.** Waiting a round trip to start walking feels broken
  on any connection, so the client runs the *same* `step` the server runs and eases
  the server's answer in rather than snapping to it. A disagreement over 24 pixels is
  accepted outright; anything smaller closes over a few frames and is invisible.
- **Everyone else is interpolated**, held 100 ms behind the newest snapshot so there
  is always a pair of frames to interpolate between. Drawing them at the very latest
  position instead means stuttering on every late packet.

`shared/world.ts` is imported by both sides on purpose. If the two ever disagreed
about how fast a person walks, every player would rubber-band.

## Art

There are no assets. Every sprite is a dozen `fillRect` calls at 1x, scaled up by a
whole number with smoothing off — which is what actually makes something look like
pixel art. The ground is baked once into an offscreen canvas rather than redrawn
four thousand tiles a frame.

Stack: Node + TypeScript + `ws` + Vite + Canvas2D. One runtime dependency.
