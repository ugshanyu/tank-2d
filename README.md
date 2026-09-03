# TANK

Realtime **2v2 tower-destruction** tank arena for mobile: **tilt your phone to drive,
touch to aim & shoot** (a joystick takes over if motion access is denied). Fast
tanks (265 px/s, ~2.7 s to cross the arena), a shot every 0.7 s, instant
respawns. Ships as a **Usion direct-mode game** — identity, rooms, and invites come from the platform; the
client talks binary WebSocket straight to this authoritative server (zero relay hop).

The arena is a single **720x1280 portrait screen**. The whole map is visible at
all times — the camera never moves, only the tanks do, so there is no scrolling
and no off-screen threat.

## Match rules

- **Two teams**, BLUE (bottom) and RED (top), max 4 players. Joiners are
  auto-balanced onto the smaller team, and **empty seats are filled with bots**,
  so nobody ever waits in a lobby.
- **The room grows with its population.** A solo launch is a **1v1** against one
  bot — not a 2v2 — and every real player who arrives takes a bot's seat:

  | Humans | Shape | Bots |
  |---|---|---|
  | 1 | 1v1 | 1 |
  | 2 | 1v1 | 0 |
  | 3 | 2v2 | 1 |
  | 4 | 2v2 | 0 |

  The 5th player is refused, and the platform's world matchmaking puts them in
  another room (`server/server.js` `targetTeamSize` / `ensureBots`). It shrinks
  the same way as people leave. A 1v1 default is the readable version of this
  game: the old always-2v2 fill gave a lone player a `rush` teammate whose
  designed job is to trade its life, so they spent ~40% of the match effectively
  1-v-2 while that teammate sat in respawn.
- **Each team has a tower.** Destroy the enemy tower (560 HP, ~17 shells) and your
  team wins the match; it restarts automatically after 6 s. Kills are pressure,
  not the objective.
- **Towers shoot back.** A tower auto-acquires the nearest living enemy tank
  within 330px and fires every 1.1 s, so a lone attacker trades lives for damage.
  Tower fire is server-authoritative and event-sourced like tank fire — clients
  replay it through the normal bullet path and never predict tower AI.
- **Friendly fire is on**, including on your own tower. A teamkill scores nothing.
- Tanks and shells both collide with towers; shells *detonate* on a tower rather
  than bouncing off it, which is how a tower takes damage.
- **Power runes.** Every 10 s a pair appears — **one in each half, at a random
  spot** that moves every wave. The two spots are mirrored through the arena
  centre (that is how the two teams see the map), so neither side's rune is
  easier to reach; a spot is never inside a wall and never under a tower's
  cannon (`server/runes.js` `pickRuneSpots`, positions carried in every
  snapshot so late joiners see them too). Driving over one heals you to full and
  grants its power for 7 s. The two runes always carry **different** powers,
  rolled at random, so a wave is a choice — shield or overdrive? — rather than a
  race for two copies of one thing.

  | Rune | Effect | How often |
  |---|---|---|
  | DOUBLE SHOT | two shells per pull | common |
  | SHIELD | absorbs 4 shots, then pops | common |
  | OVERDRIVE | 1.55x speed | common |
  | POWER SHOT | 2 charges; one-shots a tank, 4x tower damage | **~13% of waves** |

  POWER SHOT is deliberately the rare one — a guaranteed kill has to stay an
  event. Weights live in `RUNE_WEIGHTS` (`client/shared/protocol.js`), the draw
  is in `server/runes.js`, and the distribution is asserted directly in the
  smoke suite rather than left to chance.

## Progression

Every match ends on a scorecard — kills, deaths, tower damage — and awards XP
weighted toward the objective (a win and tower damage are worth more than kills,
because the tower is the win condition and a kills-only scoreboard teaches the
wrong game). Level, XP and lifetime stats persist in `localStorage`
(`client/js/profile.js`).

**This is deliberately local-only.** There is no account and no server-side
column, so progress survives a reload but not a new device or a cleared cache.
That is the honest minimum retention loop; a real one needs a persisted account
row, which is a platform decision rather than a game one.

## Bots

A lone player is topped up to 2v2 with three bots, one of each archetype
(`server/bot.js`). A human always outranks a bot for a seat: when someone joins a
full room a bot is dropped from the larger team, and when the last human leaves
every bot goes with them so abandoned rooms don't simulate forever.

| Bot | Behaviour |
|---|---|
| **Blitz** | Drives at the enemy tower and sieges it, trading lives for damage |
| **Stalker** | Hunts the nearest enemy tank and duels it at mid range; the most accurate |
| **Bulwark** | Orbits its own tower and intercepts anything that comes for it |

All three lead their shots, strafe while engaged, hold fire when a teammate is in
the line (friendly fire is on), fall back toward their own tower below ~34% HP,
and have per-profile aim error so they miss like people do.

**They contest the runes.** A bot prices each live rune against the walk
(`runePlan`): it crosses the map for a POWER SHOT, ignores an OVERDRIVE on the
far side, grabs anything at all when it is hurt — every rune heals to full, so a
wounded bot running for one is choosing the better retreat — and it won't chase
a rune an enemy plainly reaches first. Leaving every wave uncontested was free
value for the player.

**They pick their target.** Tower and tank are priced in the same currency —
shells, at one a second (`chooseTarget`): a kill buys about five shells of
unopposed siege time, so it's worth taking when it costs less than that AND the
tank was actually in the way. A 20 HP defender dies rather than being ignored
while the bot plinks a 560 HP tower; a healthy tank loitering out of the way
doesn't distract it; and a tower two shells from falling outranks even a free
kill, because that ends the match. They also have
**human reaction time**: a bot that notices you swings its turret onto you at
once but holds fire for about a second (per-profile, Stalker the longest), and a
target it loses for more than a moment — real cover, a retreat, a respawn — has
to be noticed all over again. The first shot in any encounter is yours to take.

Bots are **not** part of the deterministic shared sim — they only synthesise an
input packet each tick, which then runs through the same `stepTank`/`tryFire`
path as a human's. So the client needs no bot code at all: a bot is just another
tank in the snapshot and another `fire` event on the wire. Set `BOTS=0` to run a
bot-free server (the scripted half of `npm test` does exactly that).

- **Play**: launch from the Usion app (a game invite in chat, or Explore). The game
  starts immediately — no tap-to-start screen. Tilt to drive and touch to shoot;
  the first touch is what grants motion access on iOS (the OS only hands it out
  from a user gesture). A solo Explore launch drops you into a local practice arena
  until you invite friends (host **Share** button) — then it promotes into a live
  match.
- **Joystick**: appears only when it is needed — motion access denied, no sensor,
  or chosen in ⚙ Settings → Steering. It is two-finger by design: the **first
  finger** down becomes the stick wherever it lands (left or right, whichever hand
  is free) and the **second finger** aims and shoots. A steering choice is
  remembered per device; nothing is persisted until you choose.
- **Desktop**: WASD or arrow keys to drive, mouse to aim, click or Space to fire.
  The canvas takes focus on load and on every press — inside the Usion iframe,
  keyboard events only arrive once it holds focus.

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
