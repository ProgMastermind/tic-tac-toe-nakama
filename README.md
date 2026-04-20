# Multiplayer Tic-Tac-Toe on Nakama

Server-authoritative, real-time multiplayer Tic-Tac-Toe. All game logic — move
validation, turn enforcement, win/draw detection, timers, and forfeits — runs
inside a Go match handler on a [Nakama](https://heroiclabs.com/nakama) server.
The browser is a thin render layer driven by server broadcasts.

## Deliverables

| | |
|---|---|
| **Source code** | https://github.com/ProgMastermind/tic-tac-toe-nakama |
| **Live game (client)** | https://tic-tac-toe-nakama-two.vercel.app |
| **Nakama server endpoint** | https://tic-tac-toe-nakama-bd3383be1804.herokuapp.com |

Everything below satisfies the written requirements in one document: setup &
install, architecture & design decisions, deployment, API/server config, and
how to test the multiplayer flow.

## Features

- Server-authoritative move validation — no client-side cheating
- Private rooms via short share codes (crypto-random, unambiguous alphabet)
- Public matchmaker queue with 2-second matching interval
- Classic and 30s-per-turn timed modes
- Concurrent game rooms, fully isolated
- Auto-forfeit on turn timeout or disconnect (20 s grace)
- Global leaderboard + per-user stats (wins/losses/streaks)
- Rehydrate-on-refresh (rejoin an in-flight match after reload)
- Mobile-first responsive layout with expressive motion

## Tech Stack

| Layer | Choice |
|---|---|
| Frontend | React 18 + Vite + TypeScript, Framer Motion, canvas-confetti |
| Client SDK | `@heroiclabs/nakama-js` 2.8 |
| Backend | Nakama 3.38 + Go 1.26 plugin (`.so`) match handler |
| Database | PostgreSQL 15 |
| Infra | Docker Compose (local), Heroku container dyno (prod) |
| Hosting | Vercel (client) + Heroku (server + Postgres Essential-0) |

---

## 1. Setup and installation

### Prerequisites

- **Docker Desktop** (or Docker Engine) running
- **Node.js 18+** on `PATH`
- Git

### Quick start (one command)

From a fresh clone on Windows, macOS, or Linux:

```sh
npm install            # orchestration dep (concurrently)
npm run dev            # set up env, start Nakama+Postgres, start Vite
```

`npm run dev` does everything:

1. Copies `client/.env.example` → `client/.env` if missing.
2. Installs the client's npm dependencies if `node_modules` is missing.
3. `docker compose up --build -d` for the Nakama + Postgres stack.
4. Waits for Nakama's healthcheck to report ready.
5. Starts the Vite dev server on `http://127.0.0.1:5173`.
6. On Ctrl+C, stops the Docker stack cleanly.

### Other scripts

| Command | What it does |
|---|---|
| `npm run setup` | Idempotent: creates `.env`, installs client deps, reports which tools are on PATH |
| `npm run test` | Server Go unit tests + client TypeScript check + client production build |
| `npm run test:server` | Just the Go unit tests (7 functions, 26 table-driven cases) |
| `npm run test:client` | Just the client typecheck + build |
| `npm run verify` | `setup` then `test` — the "is this repo healthy" command |
| `npm run server:up` | Start the Nakama stack detached (no client) |
| `npm run server:logs` | Follow Nakama's stdout |
| `npm run server:down` | Stop and remove the stack |

---

## 2. How to test the multiplayer functionality

### Against the live deployment

1. Open https://tic-tac-toe-nakama-two.vercel.app in **two incognito windows**
   (different device IDs ⇒ different player identities).
2. In window A, click **Find a match**.
3. In window B, click **Find a match**. The matchmaker pairs them within ~2 s.
4. Play through — server validates every click, broadcasts state, draws the
   winning line + confetti on game end.
5. Visit the **Leaderboard** — your win is recorded.

### Against a local dev stack

1. `npm run dev`
2. Watch for `tic-tac-toe module: ready` in the Nakama logs.
3. Open `http://127.0.0.1:5173` in two browsers — **one normal, one incognito**.
4. Exercise the three flows:
   - **Public matchmaker** — both hit **Find a match**.
   - **Private room** — browser A clicks **Create a private room** (URL gets
     `?code=ABCD`). Browser B types the code under "Join with a code".
   - **Timed mode** — pick Timed on the home page; the 30 s turn countdown is
     visible on both sides.
5. Verify server-authoritative guarantees:
   - Clicking an occupied cell: server rejects it, only the sender sees a
     transient error — opponent never knows.
   - Timed mode, let the 30 s timer expire: server auto-forfeits the turn.
   - Close a tab mid-game: opponent gets a 20 s grace window, then wins by
     `abandoned`.
   - Refresh mid-match: client rehydrates via `get_current_match` RPC and
     re-renders the exact board state.

---

## 3. Architecture and design decisions

### Server-authoritative match handler

Every game lives inside a Nakama authoritative match (`server/go-module/`).
The handler is a Go plugin (`buildmode=plugin`) loaded at Nakama startup.

Move flow:

```
client → socket.sendMatchState(OpMove, {cell})
         ↓
server.MatchLoop() — receives the op, calls ValidateMove(state, userId, cell)
         ↓ (on success)
         ApplyMove(state, cell) — mutates board, checks winner/draw, flips turn
         ↓
         dispatcher.BroadcastMessage(OpStateUpdate, PublicState)
```

`ValidateMove` is pure (no mutation) and covers all six rejection paths:
`ErrNotPlaying`, `ErrUnknownPlayer`, `ErrNotYourTurn`, `ErrCellOutRange`,
`ErrCellOccupied`, `ErrBadPayload`. The client never evaluates win/draw —
the server's `CheckWinner` is the sole authority.

### Match label as ephemeral index

Private-room share codes live on the match label (a JSON blob Nakama indexes
in Bleve), not in a storage collection:

```go
type MatchLabel struct {
    Mode    string `json:"mode"`
    Code    string `json:"code,omitempty"`
    Creator string `json:"creator,omitempty"`
    Open    bool   `json:"open"`
}
```

`join_private_match` resolves a code via
`MatchList(query: "+label.code:ABCD +label.open:true")`. When the match ends
the label disappears with it — no garbage collection needed.

### Disconnect handling

On `MatchLeave` the handler records a 20-second grace deadline instead of
ending immediately. `MatchLoop` checks the deadline every tick and forfeits
only if the player hasn't reconnected. The `rehydrate` RPC
(`get_current_match`) lets a reloaded client rejoin by reusing the same
`userId` presence, which replaces (not duplicates) the old one in the
handler's `Presences` map.

### 20 Hz tick rate

Match loop runs at 20 Hz (`TickRate = 20` in [state.go](server/go-module/state.go)).
Sub-50 ms worst-case move latency keeps the feel instant; any faster wastes
cycles given the 9-cell state space.

### Stats + leaderboard on finish

On match end the handler writes two things, synchronously, before broadcasting
`OpMatchEnded`:

1. `LeaderboardRecordWrite("global_wins", winner, 1)` — increment-only.
2. `StorageWrite("stats", winner)` — read-modify-write, bumps `wins` +
   `currentStreak`, updates `bestStreak` if higher.

Synchronous order matters: the EndOverlay on the client calls `useStats()
.refresh()` the same tick, and a reader-after-writer race would flash stale
numbers.

### Editorial-minimal UI

Warm off-white paper, near-black ink, one editorial red accent. Fraunces
(display), Inter (body), JetBrains Mono (numerics). Spring presses, drawn
marks, winning-line animation, winner confetti. All motion respects
`prefers-reduced-motion`.

### Device-ID auth

`authenticateDevice` keeps first-run friction at zero — no email or password.
Future work could add email linking for account portability.

---

## 4. API and server configuration

### RPCs (registered in [main.go](server/go-module/main.go))

| RPC | Purpose | Payload |
|---|---|---|
| `create_private_match` | Creator starts a private room, gets back `{matchId, code}` | `{mode: "classic"\|"timed"}` |
| `join_private_match` | Joiner resolves a code, gets back `{matchId}` | `{code: "ABCD"}` |
| `get_current_match` | Rehydrate: returns the active match id for this user, or `null` | `{}` |
| `get_stats` | Reads the caller's stats row (wins/losses/streaks/mode split) | `{}` |

Public matchmaker pairing uses Nakama's built-in `socket.addMatchmaker` with
a `mode:classic` or `mode:timed` query; the pairing handler
(`matchmakerMatched` in [matchmaker.go](server/go-module/matchmaker.go)) creates
a match and returns its id to both clients.

### Wire protocol (opcodes)

Sent via `socket.sendMatchState(matchId, opcode, payload)`:

| Op | Name | Direction | Payload |
|---|---|---|---|
| 1 | `OpMove` | client → server | `{cell: 0..8}` |
| 2 | `OpStateUpdate` | server → client | `PublicState` (full snapshot) |
| 3 | `OpMatchEnded` | server → client | `{reason, winner?, winningLine?}` |
| 4 | `OpRematch` | _reserved_ | _unused_ |
| 5 | `OpError` | server → client (sender only) | `{code, message}` |

`PublicState` carries `board`, `turnMark`, `markByUserId`, `userIdByMark`,
`usernames`, `movesCount`, `status`, `winner`, `winReason`, `winningLine`,
`turnDeadlineMs`, `serverTimeMs`. The client never synthesises these.

### Server configuration files

- [deploy/local.yml](deploy/local.yml) — dev config (checked-in defaults,
  safe for local only).
- [deploy/prod.yml](deploy/prod.yml) — prod overrides (logger level, socket
  timeouts, matchmaker interval). **No secrets** — secrets come from env
  vars via the Heroku entrypoint shim.
- [deploy/docker-compose.yml](deploy/docker-compose.yml) — dev stack
  (Postgres 15 + Nakama).

### Client environment variables

Local (committed as [client/.env.example](client/.env.example)):

```
VITE_NAKAMA_HOST=127.0.0.1
VITE_NAKAMA_PORT=7350
VITE_NAKAMA_USE_SSL=false
VITE_NAKAMA_SERVER_KEY=defaultkey
```

Production (set in the Vercel dashboard; template at
[client/.env.production.example](client/.env.production.example)):

```
VITE_NAKAMA_HOST=tic-tac-toe-nakama-bd3383be1804.herokuapp.com
VITE_NAKAMA_PORT=443
VITE_NAKAMA_USE_SSL=true
VITE_NAKAMA_SERVER_KEY=<same string as NAKAMA_SERVER_KEY on Heroku>
```

Vite inlines these at build time — redeploy Vercel after changing them.

### Server environment variables (Heroku)

Set once via `heroku config:set`:

| Var | Notes |
|---|---|
| `NAKAMA_SERVER_KEY` | Must match `VITE_NAKAMA_SERVER_KEY` on Vercel |
| `NAKAMA_HTTP_KEY` | Guards runtime HTTP RPC access |
| `NAKAMA_SESSION_KEY` | 32+ hex chars; rotates sessions if changed |
| `NAKAMA_SESSION_REFRESH` | 32+ hex chars; refresh token encryption |
| `NAKAMA_CONSOLE_USER` | Usually `admin` |
| `NAKAMA_CONSOLE_PASSWORD` | Random 24-byte hex |
| `DATABASE_URL` | Injected automatically by the Postgres addon |

---

## 5. Deployment process

Total cost: ~$12/mo ($7 Heroku Basic dyno + $5 Heroku Postgres Essential-0;
Vercel Hobby is free).

### 5.1 Server → Heroku

```sh
heroku create tic-tac-toe-nakama --region eu
heroku stack:set container --app tic-tac-toe-nakama
heroku addons:create heroku-postgresql:essential-0 --app tic-tac-toe-nakama

heroku config:set \
  NAKAMA_SERVER_KEY="$(openssl rand -hex 24)" \
  NAKAMA_HTTP_KEY="$(openssl rand -hex 24)" \
  NAKAMA_SESSION_KEY="$(openssl rand -hex 32)" \
  NAKAMA_SESSION_REFRESH="$(openssl rand -hex 32)" \
  NAKAMA_CONSOLE_USER="admin" \
  NAKAMA_CONSOLE_PASSWORD="$(openssl rand -hex 24)" \
  --app tic-tac-toe-nakama

heroku ps:scale web=1:basic --app tic-tac-toe-nakama   # never-sleeping
git push heroku main
```

First build takes ~5 minutes (pulls `heroiclabs/nakama-pluginbuilder:3.38.0`
and `heroiclabs/nakama:3.38.0`, compiles the Go plugin). Subsequent pushes
reuse cached layers.

**How it runs:** [heroku.yml](heroku.yml) points Heroku at
[Dockerfile.heroku](Dockerfile.heroku), which is a two-stage build
(pluginbuilder → nakama) that ships the compiled `.so`, [deploy/prod.yml](deploy/prod.yml),
and [server/heroku-entrypoint.sh](server/heroku-entrypoint.sh). The shim
rewrites `DATABASE_URL` into Nakama's expected DSN form (adds
`?sslmode=require`), runs `migrate up`, then execs the Nakama binary with
all secrets passed as CLI flags — no secret ever lands in a committed file.

Verify:

```sh
heroku logs --tail --app tic-tac-toe-nakama
# look for:
#   Database migrations applied
#   tic-tac-toe module: loading (match="tictactoe")
#   tic-tac-toe module: ready
#   Startup done

curl https://tic-tac-toe-nakama-bd3383be1804.herokuapp.com/healthcheck
# → {} with HTTP 200
```

Admin console (port 7351, not publicly routed):

```sh
heroku ps:forward 7351:7351 --app tic-tac-toe-nakama
# then browse http://localhost:7351 with admin / NAKAMA_CONSOLE_PASSWORD
```

### 5.2 Client → Vercel

1. https://vercel.com/new → Import the GitHub repository.
2. Framework preset: **Vite**
3. Root directory: **`client`** (important — repo root has its own `package.json` for orchestration)
4. Build command: `npm run build`, Output directory: `dist`
5. Set the four `VITE_NAKAMA_*` env vars (see section 4). `VITE_NAKAMA_SERVER_KEY` must equal the `NAKAMA_SERVER_KEY` you set on Heroku.
6. Click **Deploy**. First build ~1 minute.

### 5.3 Rollback

- **Server:** `heroku releases --app tic-tac-toe-nakama` → `heroku rollback v<N>`. Reverts to previous Docker image in ~10 s.
- **Client:** Vercel → Deployments → Promote a prior build to Production.
- **Database:** `heroku pg:backups:capture` before risky migrations; restore with `heroku pg:backups:restore b<ID> DATABASE_URL`.

### 5.4 Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `plugin was built with a different version of package ...` | `nakama-pluginbuilder` and `nakama` tags in [Dockerfile.heroku](Dockerfile.heroku) drifted apart. They must match (currently both `3.38.0`). |
| `pq: SSL is not enabled on the server` | Shim didn't append `?sslmode=require`. Almost always `DATABASE_URL` is missing — check `heroku config` and that the Postgres addon is attached. |
| Client connects but `authenticate_device` returns 401 | `VITE_NAKAMA_SERVER_KEY` on Vercel ≠ `NAKAMA_SERVER_KEY` on Heroku. Redeploy Vercel after fixing (Vite inlines env vars at build time). |
| Dyno restarts mid-match | Heroku cycles dynos ~daily (~20 s blip). In-flight matches fail to rehydrate — users rejoin from the lobby. |
| "Application error" on the Heroku URL | Most commonly: a config var missing (shim exits `parameter not set`), plugin ABI mismatch, or migration failure. `heroku logs --tail` shows which. |

---

## Repository layout

```
client/                 React + Vite app
  src/
    context/            NakamaProvider (client, session, socket)
    hooks/              useMatch, useNakama, useStats
    pages/              Home, Game, Leaderboard
    components/         brand/ (Wordmark)
                        game/  (Board, Cell, Timer, PlayerBadge, EndOverlay)
                        ui/    (Button, TextInput, ModeToggle, SectionHead, Rule)
    styles/             tokens.css + globals.css (design system)
    types/              wire protocol (opcodes, state shape)
  .env.example          Local dev template
  .env.production.example  Vercel production template

server/
  go-module/            Go plugin: main.go, match_handler.go, state.go,
                        rpc.go, matchmaker.go, stats.go, active_match.go,
                        *_test.go (7 functions, 26 cases)
  Dockerfile            Local multi-stage: pluginbuilder → nakama
  heroku-entrypoint.sh  Rewrites DATABASE_URL, binds to $PORT (prod)

deploy/
  docker-compose.yml    nakama + postgres (local)
  local.yml             Nakama runtime config (dev)
  prod.yml              Nakama runtime config (prod, secrets injected at boot)

Dockerfile.heroku       Heroku production image (root-level — see heroku.yml)
heroku.yml              Heroku container manifest
scripts/                Cross-platform orchestration (setup, dev, tests)
```
