# Tic-Tac-Toe Multiplayer — Plan and Progress

This is the authoritative plan for the project. It captures what's already
been shipped, the design decisions behind it, and the remaining work. If
this file disagrees with code, the code won, and this file should be
updated to match.

**Repo**: https://github.com/ProgMastermind/tic-tac-toe-nakama
**Current branch**: `main`
**HEAD as of this writing**: `bd4cef3` (M3 complete, unpushed)

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

**M3 — leaderboard + stats** ✅ **DONE**
Every finished match writes a per-user storage row (wins / losses /
draws / current streak / best streak / per-mode wins) and increments
a global_wins leaderboard for the winner. Home shows a stats strip
under the display-name tag; `/leaderboard` renders the top 10 with
rank, wins, live streak, best streak, and classic / timed split.
Abandoned matches are filtered so never-started rooms don't pollute
the record.

**M4 — production deploy** 🔜 **NEXT** (DigitalOcean + Vercel)

---

## 3 · Shipped so far (M1 + M2 + M3)

### 3.1 Server (Go plugin)

Files in [server/go-module/](server/go-module/):

- [main.go](server/go-module/main.go) — `InitModule` registers the match handler, private-room RPCs (`create_private_match`, `join_private_match`), the rehydrate RPC (`get_current_match`), the stats RPC (`get_stats`), the matchmaker-matched hook, and creates the `global_wins` leaderboard (idempotent).
- [state.go](server/go-module/state.go) — pure types, opcodes, rule helpers. `StatsWritten` flag on state guards the match-finish write path against double counting.
- [match_handler.go](server/go-module/match_handler.go) — the full `runtime.Match` lifecycle. `MatchJoin` writes each player's `active_match` row; `MatchLeave` clears it immediately for finished matches; `MatchLoop` calls `writeMatchStats` on transition to finished; `MatchTerminate` clears rehydrate rows for every known player and runs `writeMatchStats` as a safety net if the loop-side write didn't fire.
- [rpc.go](server/go-module/rpc.go) — private-room RPCs with crypto-random codes, per-user cooldown, input sanitisation.
- [matchmaker.go](server/go-module/matchmaker.go) — `matchmakerMatched` hook opens an authoritative match with `expected_users` populated so `MatchJoinAttempt` admits only the paired users.
- [active_match.go](server/go-module/active_match.go) — storage read/write/clear helpers plus `get_current_match` RPC. Collection `active_match`, key `current`, owner-readable only.
- [stats.go](server/go-module/stats.go) — `StatsSummary` storage row (collection `stats`, key `summary`, **public-readable** so the leaderboard page can enrich records in one batch), outcome classification (win/loss/draw/skip), `writeMatchStats` orchestrator (read-modify-write per player + winner-only `LeaderboardRecordWrite`), and the `get_stats` RPC.
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

**Stats + leaderboard flow (M3):**

- `InitModule` calls `nk.LeaderboardCreate(ctx, "global_wins", authoritative=true, "desc", "incr", "", nil, enableRanks=true)` — idempotent across boots.
- On transition to `finished`, `MatchLoop` calls `writeMatchStats(ctx, logger, nk, s)` **before** broadcasting `OpMatchEnded`, then sets `StatsWritten=true`. This guarantees a player's stats are already updated the moment they see the end overlay, so a manual refresh on the leaderboard page shows the new numbers immediately.
- `writeMatchStats` iterates `MarkByUserID`, classifies each player as win/loss/draw (or `skip` for `WinReasonAbandoned`), and does a read-modify-write on `(stats, summary, userId)`. Rows are `PermissionRead=2` (public) so the leaderboard page reads all top-10 streaks in a **single** batched `StorageRead` rather than N round-trips.
- After the storage writes, if `s.Winner != ""`, a single `nk.LeaderboardRecordWrite("global_wins", winnerId, username, score=1, subscore=0, nil, nil)` is issued. The `"incr"` operator on the leaderboard means this adds 1 to the winner's total.
- `MatchTerminate` retains the `writeMatchStats` call **gated on `!s.StatsWritten && s.Status == StatusFinished`** as a safety net for crash / shutdown paths where `MatchLoop` didn't reach the finish branch.
- `get_stats` RPC is a thin wrapper over `readStats(ctx, nk, callerUserId)`. A first-time caller gets a **zero-valued `StatsSummary`** rather than a 404 — the Home page renders its stats strip unconditionally.
- Client `useStats` hook pulls on boot and on every `reconnectGeneration` change, so stats that shifted while offline show up immediately after reconnect.
- Client `/leaderboard` page: calls `listLeaderboardRecords("global_wins", null, 10)` and then a single `readStorageObjects` batch to pair each record with its owner's public stats row. `nakama-js` already parses `object.value` into a plain JS object, so no `JSON.parse` is needed client-side (see §5 gotcha 14).

### 3.2 Client (React)

Files in [client/src/](client/src/):

- [App.tsx](client/src/App.tsx) — router; wraps `NakamaProvider → StatusGate → ReconnectingBanner + RehydrateGate → Routes`.
- [context/NakamaProvider.tsx](client/src/context/NakamaProvider.tsx) — owns `Client`, `Session`, `Socket`; multiplexes `onmatchdata` / `onmatchpresence` / `onmatchmakermatched`; initial connect + exponential-backoff reconnect loop (1s → 30s cap); exposes `isReconnecting`, `reconnectGeneration`, `fetchCurrentMatch`.
- [hooks/useMatch.ts](client/src/hooks/useMatch.ts) — joins/leaves a match (optional matchmaker token on first join), routes opcodes through a reducer, exposes `makeMove`.
- [lib/nakama.ts](client/src/lib/nakama.ts) — env-var validation, device-id lifecycle (`crypto.randomUUID` → localStorage).
- [hooks/useStats.ts](client/src/hooks/useStats.ts) — fetches the caller's stats via `get_stats`; refetches on boot and on every reconnect. Zero-valued default means the UI never flashes a spinner on first paint.
- [pages/Home.tsx](client/src/pages/Home.tsx) — lobby: display-name editor, stats strip, mode toggle, **Find a match** (matchmaker), create / join flows, cancellable search state, footer link to leaderboard.
- [pages/Game.tsx](client/src/pages/Game.tsx) — board + players + timer + waiting state + end overlay. Reads `?t=<token>` from URL for matchmaker-origin joins.
- [pages/Leaderboard.tsx](client/src/pages/Leaderboard.tsx) — top 10 view. One `listLeaderboardRecords` call + one batched `readStorageObjects` to hydrate streak + classic/timed split per row.
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
| Stats write from `MatchLoop`, not `MatchTerminate` | Users expect counts to update before the end overlay fades. `MatchTerminate` runs ~30s later (empty-ticks timer) and is kept only as a crash-path safety net, gated on `!StatsWritten`. |
| Stats rows public-readable (`PermissionRead=2`) | Enables the leaderboard page to batch-hydrate every top-10 row's streak / per-mode split in a single `readStorageObjects` call instead of N round-trips per visit. Server holds sole write authority (`PermissionWrite=0`). |
| `get_stats` returns zero for first-time player | Not a 404. Zero-valued `StatsSummary` reads cleanly as "no games yet" and lets the Home strip render unconditionally — no existence branch on the client. |
| `readStats` swallows malformed rows as zero | A corrupt stats row is one player's history, not a match-finish stopper. Silently resetting is strictly better than blocking the write and leaving both players with stale counts. |
| Abandoned matches don't write stats | `WinReason=="abandoned"` means nobody ever joined. Writing would inflate `losses` on a ghost match. Filter at the top of `writeMatchStats`. |
| Leaderboard increment via `score=1` with `"incr"` operator | `LeaderboardCreate` is configured with `operator="incr"` so a `score=1` write increments the owner's total by 1. No read-modify-write dance required for the win count itself. |
| Client-side leaderboard streak column reads the public stats row | Nakama's leaderboard record only holds the score — streak and per-mode split live on the owner's `stats/summary` row. The page pairs the two in a single batched read. |

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
14. **`nakama-js` hydrates `ApiStorageObject.value` into an `object`, not a JSON string.** The server sends `value` as a JSON string, but the SDK parses it for you before handing it over. Calling `JSON.parse(obj.value)` on the client is both a TypeScript error (the type is `object`, not `string`) and a runtime double-parse. Treat the client-side `obj.value` as the parsed object directly — opposite to what the Go server's `obj.Value` string returns.

---

## 6 · Remaining work

### 6.1 M4 — Production deploy

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

1. Run `git log --oneline` — top commits should be `bd4cef3` (M3 client) → `eeb3661` (get_stats) → `c520d6f` (stats writer) → `789f3d0` (leaderboard init) → `0bd6fb0` (M2 plan snapshot) → `603f0b6` (back-to-lobby fix) → older. If not, the state described in §3 may have drifted; trust the code.
2. `docker ps` — if Nakama + Postgres are up, skip to the task. Otherwise `npm run dev`. **Known proxy gotcha:** if BuildKit stalls on `[internal] load metadata`, pre-pull the base images via `docker pull heroiclabs/nakama:3.38.0` + `docker pull heroiclabs/nakama-pluginbuilder:3.38.0`, then run with `--pull=never` (see §5 gotcha 11).
3. Read `PLAN.md` §4 (decisions) and §5 (gotchas) before touching server code. **Most bugs we've hit are foot-guns listed there.**
4. **Commit cadence: one meaningful chunk per commit, conventional-style messages (`feat(server): ...`, `fix(client): ...`). Don't push until asked.**
5. Start at §6.1 (M4 — production deploy) unless directed otherwise.
