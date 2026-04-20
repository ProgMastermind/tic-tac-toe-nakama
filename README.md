# Multiplayer Tic-Tac-Toe on Nakama

Server-authoritative, real-time multiplayer Tic-Tac-Toe. All game logic — move
validation, turn enforcement, win/draw detection, timers, and forfeits — runs
inside a Go match handler on a [Nakama](https://heroiclabs.com/nakama) server.
The browser is a thin render layer driven by server broadcasts.

> **Live:** client at `https://tic-tac-toe-nakama.vercel.app` · server at
> `https://tic-tac-toe-nakama.herokuapp.com`. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
> for the full deploy walkthrough.

## Quick start (one command)

From a fresh clone on Windows, macOS, or Linux:

```sh
npm install            # picks up the small orchestration dep (concurrently)
npm run dev            # set up env, start Nakama+Postgres, start Vite
```

`npm run dev` does everything:

1. Copies `client/.env.example` → `client/.env` if missing.
2. Installs the client's npm dependencies if `node_modules` is missing.
3. `docker compose up --build -d` for the Nakama + Postgres stack.
4. Waits for Nakama's healthcheck to report ready.
5. Starts the Vite dev server on `http://127.0.0.1:5173`.
6. On Ctrl+C, stops the Docker stack cleanly.

Prerequisites: **Docker Desktop** running, and **Node.js 18+** on `PATH`.

## Other scripts

| Command | What it does |
|---|---|
| `npm run setup` | Idempotent: creates `.env`, installs client deps, reports which tools are on PATH |
| `npm run test` | Server Go unit tests + client TypeScript check + client production build |
| `npm run test:server` | Just the Go unit tests |
| `npm run test:client` | Just the client typecheck + build |
| `npm run verify` | `setup` then `test` — the "is this repo healthy" command |
| `npm run server:up` | Start the Nakama stack detached (no client) |
| `npm run server:logs` | Follow Nakama's stdout |
| `npm run server:down` | Stop and remove the stack |

## Smoke-test the multiplayer flow

1. `npm run dev`
2. Watch for `tic-tac-toe module: ready` in the Nakama logs.
3. Open `http://127.0.0.1:5173` in two browsers — **one normal, one incognito**
   so they pick up different device IDs.
4. In browser A, pick a mode (Classic or Timed) and click **Create a private room**.
   The URL will include `?code=ABCD` — that's your share code.
5. In browser B, enter `ABCD` under "Join with a code" and click **Join**.
6. Play a match. Server-authoritative guarantees mean:
   - Clicking an occupied cell does nothing — the server rejects it and only you
     see the transient error, your opponent never knows.
   - In timed mode, letting the 30 s timer expire forfeits automatically.
   - Closing a tab mid-game gives a 20 s grace window before the opponent wins.

## Features

- Server-authoritative move validation — no client-side cheating
- Private rooms via short share codes (crypto-random, unambiguous alphabet)
- Classic and 30s-per-turn timed modes
- Concurrent game rooms, fully isolated
- Editorial-minimal UI with expressive motion (spring presses, drawn marks,
  winning-line animation, winner confetti)
- Auto-forfeit on turn timeout or disconnect (20 s grace)
- Mobile-first responsive layout

Public matchmaker queue, rehydrate-on-refresh, and the global leaderboard with
per-user stats are all live as of M3.

## Tech Stack

| Layer    | Choice                                            |
|----------|---------------------------------------------------|
| Frontend | React 18 + Vite + TypeScript, Framer Motion, canvas-confetti |
| Client   | `@heroiclabs/nakama-js` 2.8                       |
| Backend  | Nakama 3.38 + Go 1.26 plugin (`.so`) match handler |
| DB       | PostgreSQL 15                                     |
| Infra    | Docker Compose (local), Heroku container dyno (prod) |
| Hosting  | Vercel (client) + Heroku (server + Postgres Mini) |

## Repository Layout

```
client/                 React + Vite app
  src/
    context/            NakamaProvider (client, session, socket)
    hooks/              useMatch, useNakama
    pages/              Home, Game
    components/         game/ (Board, Cell, Timer, PlayerBadge, EndOverlay)
                        ui/   (Button, TextInput, ModeToggle)
    styles/             tokens.css + globals.css (design system)
    types/              wire protocol (opcodes, state shape)

server/
  go-module/            Go plugin: main.go, match_handler.go, state.go, rpc.go
  Dockerfile            Local multi-stage: pluginbuilder → nakama
  heroku-entrypoint.sh  Rewrites DATABASE_URL and binds to $PORT (prod)

deploy/
  docker-compose.yml    nakama + postgres (local)
  local.yml             Nakama runtime config (dev)
  prod.yml              Nakama runtime config (prod, secrets injected at boot)

Dockerfile.heroku       Heroku production image (root-level — see heroku.yml)
heroku.yml              Heroku container manifest
scripts/                Cross-platform orchestration (setup, dev, tests)
docs/
  DEPLOYMENT.md         Heroku + Vercel walkthrough
```

## Design decisions

- **Authoritative match handler in Go.** Every move is validated on the server
  in `ValidateMove` before `ApplyMove` mutates state. The client never
  evaluates win/draw locally. 14-test Go suite covers every rule path.
- **Room code lives on the match label**, not a storage row — the code
  disappears automatically when the match ends. `MatchList` query on
  `+label.code:ABCD +label.open:true` resolves it back.
- **Device-ID auth** keeps first-run friction at zero. Future work adds email
  linking for account portability.
- **Mobile-first, editorial minimal UI**: warm off-white paper, near-black ink,
  one editorial red accent. No gradient defaults. Fraunces (display) + Inter
  (body) + JetBrains Mono (numerics).

## Milestones

- **M1** ✅ — Local match: Go handler, private rooms via RPC, React Game page.
- **M2** ✅ — Public matchmaker queue + rehydrate RPC + reconnect flow.
- **M3** ✅ — Global leaderboard + per-user stats (wins/losses/streak).
- **M4a** ✅ — Richer editorial redesign across Home, Game, Leaderboard, EndOverlay.
- **M4b** ✅ — Heroku container deploy (server) + Vercel (client). See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## License

TBD.
