# Multiplayer Tic-Tac-Toe on Nakama

Server-authoritative, real-time multiplayer Tic-Tac-Toe. All game logic — move
validation, turn enforcement, win/draw detection, timers, and forfeits — runs
inside a Go match handler on a [Nakama](https://heroiclabs.com/nakama) server.
The browser is a thin render layer driven by server broadcasts.

## Features

- Server-authoritative move validation — no client-side cheating
- Public queue matchmaking (classic and 30s-per-turn timed modes)
- Private rooms via short share codes
- Concurrent game rooms, fully isolated
- Global leaderboard with win streaks
- Auto-forfeit on turn timeout or disconnect (20s grace window)
- Reconnect / rehydrate after refresh

## Tech Stack

| Layer    | Choice                                            |
|----------|---------------------------------------------------|
| Frontend | React 18 + Vite + TypeScript                      |
| Client   | `@heroiclabs/nakama-js`                           |
| Backend  | Nakama + Go plugin (`.so`) match handler          |
| DB       | PostgreSQL 15                                     |
| Infra    | Docker Compose on DigitalOcean + Caddy (TLS + WS) |
| Hosting  | Vercel (client) + DigitalOcean droplet (server)   |

## Repository Layout

```
client/                 React + Vite app
  src/
    context/            Nakama client/session/socket provider
    hooks/              useMatch, useSession
    pages/              Home, Lobby, Game, Leaderboard
    components/         Board, Cell, Timer, PlayerBadge
    types/              Shared opcodes + state shape

server/
  go-module/            Go plugin: match handler, RPCs, hooks
  Dockerfile            Multi-stage: pluginbuilder -> nakama

deploy/
  docker-compose.yml    nakama + postgres + caddy
  Caddyfile             TLS + WebSocket + console basic auth
  local.yml             Nakama runtime config (dev)
  prod.yml              Nakama runtime config (prod)
```

## Milestones

- **M1** — Local match: Go handler, private rooms via RPC, React Game page. Two
  local browsers can play a full classic match end-to-end.
- **M2** — Matchmaker: public queue + `RegisterMatchmakerMatched` hook +
  rehydrate RPC.
- **M3** — Timer mode (30s/turn, auto-forfeit) + leaderboard + per-user stats.
- **M4** — Deploy: droplet, Caddy TLS, Postgres backups, Vercel live, full
  README with setup and test procedure.

## Status

Initial scaffold. See [project plan](#) for full architecture and decisions.

## License

TBD.
