# Tic-Tac-Toe Multiplayer — Plan and Progress

This is the authoritative plan for the project. It captures what's already
been shipped, the design decisions behind it, and the remaining work. If
this file disagrees with code, the code won, and this file should be
updated to match.

**Repo**: https://github.com/ProgMastermind/tic-tac-toe-nakama
**Current branch**: `main`
**HEAD as of this writing**: `603f0b6` (M2 complete, unpushed)

---

## 1 · What this project is

A production-ready, server-authoritative multiplayer tic-tac-toe. All game
logic — move validation, turn enforcement, win/draw detection, timers,
forfeits — runs inside a Go match handler on a [Nakama](https://heroiclabs.com/nakama)
server. The browser is a thin render layer driven entirely by server
broadcasts. Satisfies the full assignment brief plus three bonus features
(concurrent rooms, leaderboard, timed mode).

**Fixed tech stack** (do not revisit):

| Layer    | Choice                                             |
|----------|----------------------------------------------------|
| Frontend | React 18.3 + Vite 5.4 + TypeScript 5.6             |
| Client   | `@heroiclabs/nakama-js` 2.8                        |
| Motion   | Framer Motion 11 + canvas-confetti 1.9             |
| Backend  | Nakama 3.38.0 + Go 1.26 plugin (`buildmode=plugin`)|
| DB       | PostgreSQL 15-alpine                               |
| Infra    | Docker Compose locally; DigitalOcean + Caddy + Vercel for prod |

---

## 2 · Status summary

**M1 — local multiplayer** ✅ **DONE**
Two browsers can open a private room, join via 4-char code, and play a
full match (classic or timed) end-to-end against a real Nakama server
running in Docker. Smoke-tested on Windows with Chrome + Edge.

**M2 — public matchmaker + reconnect** ✅ **DONE**
Two browsers on the Home page both click **Find a match**, Nakama
pairs them, both auto-navigate into the same authoritative match with
the right marks. Refreshing mid-game rehydrates to the active match.
Network drops trigger a reconnect pill banner (1s → 30s backoff) and
the socket re-attaches without losing state. Back-to-lobby after a
match end lands cleanly on `/` without bouncing.

**M3 — leaderboard + stats** 🔜 **NEXT**
**M4 — production deploy** (DigitalOcean + Vercel)

---

## 3 · Shipped so far (M1 + M2)

### 3.1 Server (Go plugin)

Files in [server/go-module/](server/go-module/):

- [main.go](server/go-module/main.go) — `InitModule` registers the match handler, private-room RPCs, `get_current_match`, and the matchmaker-matched hook. Leaderboard init lands here in M3.
- [state.go](server/go-module/state.go) — pure types, opcodes, rule helpers. The file M3 will extend when stats need new fields.
- [match_handler.go](server/go-module/match_handler.go) — the full `runtime.Match` lifecycle. `MatchJoin` writes each player's `active_match` row; `MatchLeave` clears it immediately for finished matches; `MatchTerminate` clears anything left as a safety net.
- [rpc.go](server/go-module/rpc.go) — private-room RPCs with crypto-random codes, per-user cooldown, input sanitisation.
- [matchmaker.go](server/go-module/matchmaker.go) — `matchmakerMatched` hook opens an authoritative match with `expected_users` populated so `MatchJoinAttempt` admits only the paired users.
- [active_match.go](server/go-module/active_match.go) — storage read/write/clear helpers plus `get_current_match` RPC. Collection `active_match`, key `current`, owner-readable only.
- [state_test.go](server/go-module/state_test.go) — 14 unit tests covering every win line and every `ValidateMove` rejection path.

**Wire protocol (opcodes)** — mirrored in [client/src/types/match.ts](client/src/types/match.ts):

| Code | Direction | Purpose                                   |
|------|-----------|-------------------------------------------|
| 1    | C→S       | `{cell}` — place a mark                   |
| 2    | S→C       | full state snapshot (authoritative)       |
| 3    | S→C       | match ended (`reason`, `winner`, `line`)  |
| 4    | C→S       | rematch request (placeholder, unwired)    |
| 5    | S→C       | per-user validation error (never broadcast) |

**Match lifecycle, per tick (tickRate=1):**

1. If `status=waiting` and `now > joinDeadlineMs` → abandon.
2. For each player with a live disconnect-clock past 20s → forfeit, opponent wins.
3. For each inbound `OpMove`: `ValidateMove` → `ApplyMove` → broadcast state.
4. If `mode=timed` and `status=playing` and `now > turnDeadlineMs` → timeout forfeit.
5. On transition to `finished`: broadcast `OpMatchEnded`, mark `StatsWritten=true`.
6. If finished and empty for 30 ticks → return `nil` (terminate).

**Match label shape** (JSON, set at `MatchInit`, updated on full room):

```json
{ "mode": "classic|timed", "code": "ABCD", "creator": "<userId>", "open": true|false }
```

`MatchList` queries filter on `+label.code:ABCD` with `maxSize=1` to find
waiting rooms — **do not** reintroduce `+label.open:true` (Bleve's
boolean indexing breaks this silently; see §5).

**Public matchmaker flow (M2):**

- Client calls `socket.addMatchmaker("+properties.mode:<mode>", 2, 2, {mode}, {})`.
  String properties surface under `properties.*` in the query DSL.
- Server's `matchmakerMatched` hook reads `mode` off `entries[0].GetProperties()` and calls `nk.MatchCreate(MatchModuleName, {mode, expected_users: [userIds]})`. Returning the match id causes Nakama to auto-deliver a `matchmaker_matched` event (with a short-lived `token`) to both clients.
- Client's `onmatchmakermatched` multiplex handler navigates to `/game/<matchId>?t=<token>`. `useMatch` passes the token to the first `socket.joinMatch` call.

**Rehydrate flow (M2):**

- On `MatchJoin` (first time a user acquires a mark), server writes `{matchId, mark, mode}` to `(active_match, current, userId)`.
- `get_current_match` RPC reads that row. Returns `{active: false}` if absent.
- `MatchLeave` clears the row **immediately** when the match is already finished — prevents a rehydrate race from bouncing a user back into the end overlay after they click Back to Lobby.
- `MatchTerminate` clears rows for every known player as a safety net.
- Client-side `RehydrateGate` calls the RPC once on boot (first time `status=ready`), and navigates from `/` to `/game/:matchId` if a row exists. It is a **boot-time one-shot** — reconnects do not re-trigger it.

### 3.2 Client (React)

Files in [client/src/](client/src/):

- [App.tsx](client/src/App.tsx) — router; wraps `NakamaProvider → StatusGate → ReconnectingBanner + RehydrateGate → Routes`.
- [context/NakamaProvider.tsx](client/src/context/NakamaProvider.tsx) — owns `Client`, `Session`, `Socket`; multiplexes `onmatchdata` / `onmatchpresence` / `onmatchmakermatched`; initial connect + exponential-backoff reconnect loop (1s → 30s cap); exposes `isReconnecting`, `reconnectGeneration`, `fetchCurrentMatch`.
- [hooks/useMatch.ts](client/src/hooks/useMatch.ts) — joins/leaves a match (optional matchmaker token on first join), routes opcodes through a reducer, exposes `makeMove`.
- [lib/nakama.ts](client/src/lib/nakama.ts) — env-var validation, device-id lifecycle (`crypto.randomUUID` → localStorage).
- [pages/Home.tsx](client/src/pages/Home.tsx) — lobby: display-name editor, mode toggle, **Find a match** (matchmaker), create / join flows, cancellable search state.
- [pages/Game.tsx](client/src/pages/Game.tsx) — board + players + timer + waiting state + end overlay. Reads `?t=<token>` from URL for matchmaker-origin joins.
- [components/ui/](client/src/components/ui/) — `Button`, `TextInput`, `ModeToggle` (primitives).
- [components/game/](client/src/components/game/) — `Board`, `Cell`, `Timer`, `PlayerBadge`, `EndOverlay`.
- [styles/tokens.css](client/src/styles/tokens.css) — the design system (palette, type, spacing, motion).

**Design language** (locked in — do not theme-swap without user approval):
editorial minimalism, warm off-white paper (`#FAF8F3`), near-black ink,
one editorial red accent (`#B2342C`). **No gradient backgrounds.** Fraunces
(display) + Inter (body) + JetBrains Mono (timers, codes). Mobile-first.

### 3.3 Deploy (local)

Files in [deploy/](deploy/) and [server/Dockerfile](server/Dockerfile):

- `Dockerfile` — multi-stage: `heroiclabs/nakama-pluginbuilder:3.38.0` builds `backend.so`, copied into `heroiclabs/nakama:3.38.0`. **Tags must stay pinned in lockstep** (ABI-sensitive).
- `docker-compose.yml` — Postgres + Nakama with healthchecks. Entrypoint uses single-line commands because YAML folded scalars split over-indented lines.
- `local.yml` — Nakama runtime config. `name` must be ≤16 chars (`ttt-local`).

### 3.4 Scripts (one-command dev loop)

Files in [scripts/](scripts/):

- `setup.mjs` — idempotent: copies `.env`, installs client deps, probes tooling.
- `dev.mjs` — full orchestrator: setup → docker up -d → wait-for-health → vite, Ctrl+C = clean teardown.
- `test-server.mjs` — `go test` (race opt-in via `NAKAMA_TEST_RACE=1`).
- `wait-for-nakama.mjs` — polls `/healthcheck`.
- `lib/spawn.mjs` — Node 24 DEP0190-safe spawn shim.

**Root `package.json` scripts:**
- `npm run dev` — full local loop (backend + frontend)
- `npm run client:dev` — just the Vite server (if backend already up)
- `npm run test` — Go unit tests + client typecheck + build
- `npm run server:up` / `server:down` / `server:logs`

---

## 4 · Design decisions (non-obvious)

These are the choices that aren't visible from reading the code. Don't
re-litigate them without a real reason.

| Decision | Why |
|----------|-----|
| `tickRate=1` (1 Hz) | Moves arrive as messages regardless of tick rate. Ticks only check time-based deadlines. ±1s precision is fine for a 30s turn timer. |
| Private rooms pass `creator` not `expected_users` | Non-empty `ExpectedUsers` triggers matchmaker-gate logic in `MatchJoinAttempt` which rejects anyone else. Private rooms let the first 2 unique joiners win the slots. |
| Join-deadline = **120s**, not 15s | 15s was dev ergonomics. Real flow: create → copy code → paste into chat → friend reads → types → joins. 120s covers that; orphaned rooms are cheap. |
| Room code on label, not storage row | Code dies with the match — no orphaned rows to GC. |
| `MatchList` filter: `+label.code:X` with `maxSize=1` only | Do **not** add `+label.open:true` — Bleve's JSON boolean indexing is inconsistent across Nakama versions; `maxSize=1` reliably excludes full rooms. |
| Device ID auth (no email) | Zero friction for the assignment. Linking email is a future item, noted as deferred. |
| Creator → X, second joiner → O | Deterministic, independent of whoever physically joined the match goroutine first. |
| `StatsWritten` flag on state | Match finish broadcasts in `MatchLoop`; `MatchTerminate` is safety-net only. Prevents double leaderboard writes in M3. |
| Matchmaker passes `expected_users` (not `creator`) | Opposite of private rooms: here we *want* the allow-list behaviour in `MatchJoinAttempt` so nobody else can claim the paired slot. |
| `active_match` row cleared on `MatchLeave` when finished | Not just `MatchTerminate`. The 30-tick terminate delay is too long — a client that lands on `/` in that window would bounce right back into the end overlay via rehydrate. |
| `RehydrateGate` is boot-time one-shot (ref-gated) | Auto-navigate only on the first successful connect this session. Reconnects don't re-trigger — `useMatch` already resumes the in-game session naturally when a new socket attaches. |
| Matchmaker token via URL query `?t=...` | Threaded through the route because only the first join needs it; on refresh the user is already a known presence and Nakama accepts the join as a reconnect with no token. |
| Single accent colour, no gradients | Deliberate visual language (chess.com / Linear / Notion feel). User explicitly rejected AI-default "purple-pink gradient" look. |

---

## 5 · Gotchas we've already tripped over

A reminder list so the next session doesn't re-discover these.

1. **Top-level `return` is illegal in ESM.** `process.exit()` is the ESM-safe way to abort a module.
2. **External BuildKit frontends** (`# syntax=docker/dockerfile:1.7`) add a network fetch that flakes on corporate networks. The built-in frontend handles everything we use.
3. **YAML folded scalars (`>`) preserve newlines on over-indented continuation lines.** Never indent the continuation of a shell command inside a `>` block — put the whole command on one physical line.
4. **Nakama's `name` config is capped at 16 chars.** Over → fatal on boot.
5. **Bleve boolean label filters don't reliably match JSON `true`/`false`.** Use `maxSize` / `minSize` for count-based filtering, strings for flag-like filtering.
6. **Corporate proxies must be set in BOTH Docker Desktop proxy sections** (daemon proxy + container/build proxy). Otherwise `go mod download` inside the plugin builder hangs.
7. **`expected_users` in `MatchCreate` triggers allow-listing in `MatchJoinAttempt`.** Only populate it for matchmaker-origin matches.
8. **Same-browser tabs share localStorage → same device ID → same Nakama user.** The self-join guard in `join_private_match` catches this with a friendly message.
9. **Windows doesn't support `buildmode=plugin`** — any Go plugin build has to happen inside the pluginbuilder Docker image. Unit tests still run fine natively.
10. **CockroachDB is Nakama's default DB** — if `--database.address` doesn't reach the binary, you'll see cryptic connection-refused to `127.0.0.1:26257` instead of a clear error.
11. **BuildKit ignores `--pull=never` for base-image metadata.** Even with the image cached in the daemon's containerd store, BuildKit dials `auth.docker.io` to revalidate digest. When the corporate proxy is flaky, this stalls the whole build. Workaround: pre-pull via `docker pull heroiclabs/nakama:3.38.0` (daemon path has working proxy), then `docker compose up --build --pull=never`.
12. **Docker Desktop 29.x displays `HTTP Proxy: http.docker.internal:3128` in `docker info` even when upstream proxy is configured.** That's the internal gateway — the real upstream (Intel proxy) sits behind it. Don't assume the proxy is unset based on `docker info` alone; test with `docker pull alpine:latest` instead.
13. **Rehydrate races match-end.** If the active_match row lives until `MatchTerminate` (30 empty ticks), a user who clicks Back to Lobby can be bounced right back. Clear the row on `MatchLeave` when the match is already `StatusFinished`. On the client, `RehydrateGate` is a boot-time one-shot — don't re-run on every reconnect.

---

## 6 · Remaining work

### 6.1 M3 — Leaderboard + per-user stats

**Goal:** every finished match updates win/loss/draw counts and a global
"wins" leaderboard. Home and Game pages show the top 10 and the caller's
current streak.

**Components to build:**

1. **Leaderboard init** in `InitModule`:
   ```go
   nk.LeaderboardCreate(ctx, "global_wins", true, "desc", "incr", "", nil, true)
   ```
   Authoritative, descending, increment operator, never resets, ranks enabled.

2. **Stats writer** (new file `server/go-module/stats.go`):
   - Called from `MatchLoop` the moment status transitions to `finished` (not from `MatchTerminate` — users expect their count to update before the overlay finishes fading).
   - Updates storage collection `stats`, key `summary`, owner = each player:
     ```json
     { "wins": 0, "losses": 0, "draws": 0,
       "currentStreak": 0, "bestStreak": 0,
       "classicWins": 0, "timedWins": 0 }
     ```
   - Writes `nk.LeaderboardRecordWrite(ctx, "global_wins", winnerId, username, 1, 0, nil, nil)` for the winner only.
   - Sets `StatsWritten=true` (already a field on state).

3. **`get_stats` RPC** — returns caller's row for Home masthead and profile.

4. **Leaderboard page** (new `client/src/pages/Leaderboard.tsx`):
   - `client.listLeaderboardRecords(session, "global_wins", null, 10)`
   - Paired storage reads for each entry's streak + classic/timed split.
   - Route `/leaderboard` in `App.tsx`.

5. **Home page eyebrow strip**: show caller's wins / losses / streak next to the display-name tag.

**New files:**
- `server/go-module/stats.go`
- `client/src/pages/Leaderboard.tsx` + `.module.css`
- `client/src/hooks/useStats.ts`

**Verification:**
- Play a match, win, refresh → stats row shows `wins: 1`.
- Win three in a row → `currentStreak: 3, bestStreak: 3`.
- Lose once → `currentStreak: 0, bestStreak: 3`.
- Leaderboard page shows top 10 across all users.
- Draw doesn't increment wins, does increment draws.

**Commit plan:**
1. `feat(server): create global_wins leaderboard in InitModule`
2. `feat(server): stats + leaderboard writes at match finish`
3. `feat(server): get_stats RPC`
4. `feat(client): leaderboard page + home stats strip`

---

### 6.2 M4 — Production deploy

**Goal:** the live URL from the assignment brief. Game reachable at a
public hostname, backed by a real Nakama instance with TLS, running
under a process supervisor with daily backups.

**Components to build:**

1. **DigitalOcean droplet** — Ubuntu 22.04, 2 GB RAM, $12/mo. Use `doctl` or the web console. Bind a domain (e.g. `ttt.yourdomain.com` for client, `nakama.yourdomain.com` for server).

2. **Caddy reverse proxy** — `deploy/Caddyfile` with two sites:
   - `nakama.yourdomain.com` → `reverse_proxy nakama:7350` (WebSocket auto-upgrade).
   - `console.yourdomain.com` → `reverse_proxy nakama:7351` + `basicauth` with a bcrypted admin password.

3. **Production Nakama config** — `deploy/prod.yml`, derived from `local.yml`:
   - Unique `encryption_key`, `refresh_encryption_key`, `http_key`, `socket.server_key`.
   - Secrets injected via environment variables at container start (not committed).
   - `logger.level: WARN`.
   - `console.password` bcrypted.

4. **docker-compose.prod.yml** — same services as local but with the Caddy container added and bind mounts for persistent volumes.

5. **Postgres backup** — systemd timer:
   ```
   docker exec <postgres> pg_dump -U postgres nakama | gzip > /backups/ttt-$(date +%F).sql.gz
   ```
   Daily, retain 14 days.

6. **Vercel client** — link GitHub repo, set root directory to `client/`, build command `npm run build`, output `dist/`. Env vars:
   ```
   VITE_NAKAMA_HOST=nakama.yourdomain.com
   VITE_NAKAMA_PORT=443
   VITE_NAKAMA_USE_SSL=true
   VITE_NAKAMA_SERVER_KEY=<secret, from prod.yml>
   ```

7. **README deployment section** — full walkthrough of droplet creation, DNS setup, first deploy, update flow.

**New files:**
- `deploy/Caddyfile`
- `deploy/prod.yml`
- `deploy/docker-compose.prod.yml`
- `docs/DEPLOYMENT.md`

**Verification:**
- Two browsers on different networks can play a full match against the public server.
- `curl https://nakama.yourdomain.com/healthcheck` returns 200.
- Console accessible with basic auth, match inspector shows live games.
- `docker compose exec postgres pg_isready` inside droplet.
- Backup cron has written at least one file overnight.

**Commit plan:**
1. `feat(deploy): Caddyfile + prod compose stack`
2. `feat(deploy): production Nakama config template`
3. `docs: deployment walkthrough`

---

## 7 · Things out of scope (decided)

- **Rematch flow** — opcode 4 is reserved but unwired; leave for post-M4.
- **In-match chat** — not in the brief.
- **Email/password linking** — device-id is the only auth; account recovery is a future concern.
- **Mobile wrapper** (React Native / Capacitor) — the web client is responsive and the brief accepts web.
- **ELO / skill matchmaking** — M2 ships pure queue + mode; ranking can come later.
- **Spectator mode** — interesting but not asked for.

---

## 8 · How to pick this up in a fresh session

If you're reading this after a chat compaction:

1. Run `git log --oneline` — top commits should be `603f0b6` (back-to-lobby fix) → `5c83dd3` → `4c3bed8` → `c759226` → `d2bde27` → `2daf466` (M1 plan snapshot). If not, the state described in §3 may have drifted; trust the code.
2. `docker ps` — if Nakama + Postgres are up, skip to the task. Otherwise `npm run dev`. **Known proxy gotcha:** if BuildKit stalls on `[internal] load metadata`, pre-pull the base images via `docker pull heroiclabs/nakama:3.38.0` + `docker pull heroiclabs/nakama-pluginbuilder:3.38.0`, then run with `--pull=never` (see §5 gotcha 11).
3. Read `PLAN.md` §4 (decisions) and §5 (gotchas) before touching server code. **Most bugs we've hit are foot-guns listed there.**
4. **Commit cadence: one meaningful chunk per commit, conventional-style messages (`feat(server): ...`, `fix(client): ...`). Don't push until asked.**
5. Start at §6.1 (M3 — leaderboard + stats) unless directed otherwise.
