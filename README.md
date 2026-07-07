# TANK

Realtime multiplayer tank arena for mobile: **tilt your phone to drive, touch to aim & shoot**.
Up to 8 players per room, instant respawns, bouncing shells.

- **Play**: open the Vercel URL on your phone, tap PLAY (grants motion access on iOS), tilt to move.
- **Rooms**: share `?room=<anything>` to play in a private arena (default room: `arena`).
- **Fallbacks**: no tilt sensor → virtual joystick (left half of screen); desktop → WASD/arrows + mouse.

## Architecture — the zero-lag template

This repo is the reference netcode setup for our future realtime games.

```
client/  → Vercel (static, no build step, ES modules)
server/  → Railway (Node 20+, ws)
client/shared/ → deterministic sim + binary protocol, imported by BOTH sides
```

### Why it feels lag-free

| Technique | Where | What it does |
|---|---|---|
| Authoritative server, fixed 60 Hz tick | `server/server.js` | One truth; cheating-resistant; stable physics |
| Client-side prediction | `client/js/game.js` | Your tank responds in **0 ms** — inputs are applied locally the same frame |
| Server reconciliation | `client/js/game.js` `_reconcile` | Snapshots ack input seq; predicted state is reset + unacked inputs replayed. Residual error decays visually, never snaps |
| Shared deterministic sim | `client/shared/sim.js` | Client & server run byte-identical physics → predictions land exactly on the server result |
| Entity interpolation | `client/js/game.js` `remoteStates` | Remote tanks render ~66 ms in the past between two real snapshots → perfectly smooth despite jitter |
| Event-sourced bullets | `fire`/`bx` events | One event per shot; both sides simulate the deterministic trajectory. No per-bullet state on the wire, no stutter |
| Binary hot path | `client/shared/protocol.js` | 11-byte inputs, 14 bytes/tank snapshots, quantized positions/angles. JSON only for rare events |
| TCP latency hygiene | `server/server.js` | `TCP_NODELAY` on, `permessage-deflate` off, snapshots skipped for choked sockets |
| Input jitter buffer | server `INPUT_QUEUE_CAP` | Absorbs network jitter without rubber-banding; bounded catch-up prevents speed hacks |

### Protocol

- **C→S** `INPUT` (binary, 11 B): seq, move vector, fire flag, aim angle, fire nonce — sent every tick (60/s)
- **C→S** `PING` / **S→C** `PONG` (binary): RTT display + liveness
- **S→C** `SNAPSHOT` (binary): tick, per-client input ack, all tanks (pos/vel/angles/hp/score quantized)
- **JSON events**: `hello`, `welcome`, `join/leave`, `fire`, `bx` (bullet end), `death`, `spawn`

### Server-side validation (never trust the client)

Movement is *simulated* from inputs, never accepted as positions. Fire cooldown enforced
server-side (leaky bucket: tolerates jitter catch-up, caps sustained rate). Input values
clamped by the codec. Malformed/oversized frames dropped, idle sockets kicked,
rooms/players capped. Hits use a swept segment test (no point-blank or corner tunneling).
Optional `ALLOWED_ORIGINS` env (comma-separated) restricts browser origins.

### Testing

`npm test` boots the server and runs a scripted 2-player match over the real protocol:
join, movement + input acks, malformed-frame resilience, fire → hit → death → score,
respawn, leave/rejoin.

## Run locally

```bash
npm install
npm start                 # server on :8080
npx serve client          # or any static server; open http://localhost:3000
```

The client auto-connects to `ws://localhost:8080` on localhost, or use `?server=ws://...` to point anywhere.

## Deploy

```bash
# server → Railway
railway up --detach       # railway.json sets start command + /healthz

# client → Vercel (set PROD_SERVER_URL in client/js/config.js to the Railway wss:// domain first)
cd client && vercel deploy --prod
```

## Future upgrades

- WebTransport (UDP-like datagrams) when Safari ships it — the protocol layer is already isolated in `net.js`
- Delta-compressed snapshots + interest management for >8 players
- Lag compensation (server-side rewind) for hitscan weapons
