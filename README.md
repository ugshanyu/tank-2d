# TANK

Realtime multiplayer tank arena for mobile: **tilt your phone to drive, touch to aim & shoot**.
Up to 8 players per room, instant respawns, bouncing shells. Ships as a **Usion
direct-mode game** — identity, rooms, and invites come from the platform; the
client talks binary WebSocket straight to this authoritative server (zero relay hop).

- **Play**: launch from the Usion app (a game invite in chat, or Explore). Tap PLAY
  (grants motion access on iOS), then tilt to drive and touch to shoot. A solo
  Explore launch drops you into a local practice arena until you invite friends
  (host **Share** button) — then it promotes into a live match.
- **Fallbacks**: no tilt sensor → virtual joystick (left half of screen); desktop → WASD/arrows + mouse.

## Usion integration — direct mode

The game runs inside the Usion host (WebView/iframe). At boot it calls
`Usion.init`, reads identity (`Usion.user.getId/getName`) and the room
(`Usion.config.roomId`), then fetches a short-lived **RS256 access token** from
the backend via the SDK (`Usion.game._fetchDirectAccess`, host-proxied so there
is no CORS/PNA issue) and opens its OWN binary WebSocket to this server with
`?token=<jwt>`. The server validates the token against the platform JWKS
(`server/auth.js`) and binds the connection to the token's user + room — the
client can pick neither, which is what makes it cheating-resistant. Registered in
the service registry with `realtime.connection_mode: "direct"` (see
`backend/scripts/seed_tank.py` in the monorepo). Opened OUTSIDE the host it falls
back to a `dev:<user>:<room>` token, accepted only when the server runs with
`DEV_ALLOW_UNSIGNED=1` (the process refuses to boot with that set in production).

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

The Railway server serves the static client too (one host for both the iframe
and the WebSocket), so a single deploy ships everything:

```bash
# server + client → Railway
railway up --detach        # railway.json sets start command + /healthz
# NODE_ENV=production is set on the service; DEV_ALLOW_UNSIGNED must stay UNSET.

# register / update in the Usion service registry (from the monorepo backend)
cd backend && python -m scripts.seed_tank
```

`iframe_url` and `realtime.ws_url` both point at the Railway domain
(`https://…/` and `wss://…/ws`). Standalone hosting on Vercel still works if you
prefer to split them — set `DEV_SERVER_URL` in `client/js/config.js` to the
Railway `wss://…/ws` domain and `vercel deploy --prod` the `client/` dir.

## Future upgrades

- WebTransport (UDP-like datagrams) when Safari ships it — the protocol layer is already isolated in `net.js`
- Delta-compressed snapshots + interest management for >8 players
- Lag compensation (server-side rewind) for hitscan weapons
