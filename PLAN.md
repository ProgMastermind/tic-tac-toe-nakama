# Tic-Tac-Toe Multiplayer — Plan and Progress

This is the authoritative plan for the project. It captures what's already
been shipped, the design decisions behind it, and the remaining work. If
this file disagrees with code, the code won, and this file should be
updated to match.

**Repo**: https://github.com/ProgMastermind/tic-tac-toe-nakama
**Current branch**: `main`
**HEAD as of this writing**: `8560162` (M4a complete — design polish + perf tuning, unpushed)

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
| Infra    | Docker Compose locally; **Heroku** (paid Basic dyno + Postgres Mini) + Vercel for prod |

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

**M4a — design polish + perf** ✅ **DONE**
Editorial furniture primitives (`Wordmark`, `Rule`, `SectionHead`)
plus paper-grain token. Home rebuilt as a single-column 42rem
landing: wordmark + connection chip brandbar, short masthead, action
card with the CTA as hero, three-cell record strip that footer-links
to the leaderboard. Game stage gets a breadcrumb topbar,
ghost-board waiting illustration, and SVG X/O marks on the
`PlayerBadge` with a pulsing active-turn rail. Leaderboard rebuilt
as a single ranked list (rank 1 gets an accent wash + red left rail)
after the podium felt lonely with few entries. End overlay shows a
W/L/D · Streak echo strip and carries the just-played mode back to
Home via `?mode=`. Mobile tuned at 520px and 400px breakpoints: join
row stacks vertically, monogram shrinks, subline truncates.
**Perf**: matchmaker `interval_sec` dropped from 15 → 2 (paired
tickets resolve ~1s avg), match tick rate bumped from 1Hz → 20Hz so
move-apply latency stays under ~50ms.

**M4b — production deploy** 🔜 **NEXT** (Heroku + Vercel)

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

**Match lifecycle, per tick (tickRate=20, every 50ms):**

1. If `status=waiting` and `now > joinDeadlineMs` → abandon.
2. For each player with a live disconnect-clock past 20s → forfeit, opponent wins.
3. For each inbound `OpMove`: `ValidateMove` → `ApplyMove` → broadcast state.
4. If `mode=timed` and `status=playing` and `now > turnDeadlineMs` → timeout forfeit.
5. On transition to `finished`: broadcast `OpMatchEnded`, mark `StatsWritten=true`.
6. If finished and empty for `EmptyMatchSeconds × TickRate = 600` ticks (30 wall-clock seconds) → return `nil` (terminate).

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
- [pages/Home.tsx](client/src/pages/Home.tsx) — single-column 42rem landing: brandbar (Wordmark + name + connection chip), masthead, action card (mode toggle + Find a match CTA + rule + create-private + join-by-code), three-cell record strip that footer-links to the leaderboard, secondary-nav footer. Reads `?mode=` to pre-select the toggle when arriving from an end-of-match.
- [pages/Game.tsx](client/src/pages/Game.tsx) — breadcrumb topbar + rule, scorecard-style player row, ghost-board waiting illustration, framer-motion page-enter. Reads `?t=<token>` from URL for matchmaker-origin joins. Back to lobby carries `?mode=<current>` back to Home.
- [pages/Leaderboard.tsx](client/src/pages/Leaderboard.tsx) — single 44rem ranked list (replaced the earlier silver-gold-bronze podium because it looked lonely with few entries). Rank 1 gets an accent-soft wash + 3px red left rail so the leader reads at a glance. One `listLeaderboardRecords` call + one batched `readStorageObjects` to hydrate streak + classic/timed split per row.
- [components/brand/Wordmark.tsx](client/src/components/brand/Wordmark.tsx) — inline SVG mark (3×3 dot grid, center dot in accent) paired with a Fraunces wordmark (`Tic Tac Toe` with `Toe` italic + accent).
- [components/ui/](client/src/components/ui/) — `Button`, `TextInput`, `ModeToggle`, `SectionHead`, `Rule` (primitives).
- [components/game/](client/src/components/game/) — `Board`, `Cell`, `Timer`, `PlayerBadge` (SVG X/O marks + pulsing active-turn rail), `EndOverlay` (with W/L/D · Streak echo pulled from `useStats().refresh()` on mount).
- [styles/tokens.css](client/src/styles/tokens.css) — the design system (palette, type, spacing, motion, paper-grain URL).

**Design language** (locked in — do not theme-swap without user approval):
editorial minimalism with **restraint** (see §5 gotcha 15), warm off-white
paper (`#FAF8F3`), near-black ink, one editorial red accent (`#B2342C`).
**No gradient backgrounds.** Fraunces (display) + Inter (body) + JetBrains
Mono (timers, codes). Subtle paper-grain overlay on the body. Single-column
reading-width layouts (42–44rem) rather than 2-col grids. Mobile-first.

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
| `tickRate=20` (20 Hz, every 50ms) | Messages queue between `MatchLoop` ticks. At 1Hz that was up to 1s of dead time between click and mark — clearly laggy. 20Hz caps move-apply latency under ~50ms. Loop is O(1) so CPU cost is negligible. `EmptyMatchTicks = EmptyMatchSeconds × TickRate` so the 30s cleanup window survives the rate change. |
| `matchmaker.interval_sec: 2` | Nakama's 15s default makes **Find a match** feel sluggish. At 2s paired tickets resolve in ~1s avg. CPU cost of scanning the (tiny) pool every 2s is negligible. |
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
15. **Editorial design favours restraint over density.** First attempt at a "richer editorial" Home stacked section numerals (I / II) + a huge drop cap + a 2-col grid + wordmark bar + rules simultaneously — cluttered on desktop, would collapse ugly on mobile. User called it "looking very bad". Fix: one strong typographic move per screen, not five. Default to single-column 40–44rem reading-width layouts unless a screen has two genuinely independent regions. When in doubt, show a mockup before layering ornaments.
16. **Podium layouts look lonely when the board is sparse.** The original Leaderboard top-3 podium (silver-gold-bronze) felt great with 10 entries populated in dev, but in reality the prod leaderboard starts empty. With 1 winner the podium shows a single card flanked by empty slots. Rebuilt as a single ranked list where rank 1 gets an accent wash + red left rail — reads cleanly whether there's 1 entry or 10.
17. **Play again was redundant UX.** Shipping both "Play again" and "Back to lobby" on the end overlay looked like two distinct CTAs but they did the same thing (both called `leave()` + navigated to `/`, only differing in `?mode=`). Users couldn't actually start a new match from the overlay — they still had to click Find a match at the lobby. Collapsed to a single button that carries the mode hint.
18. **Default Nakama matchmaker interval (15s) is unusable for demos.** Even on localhost the first test of Find a match felt broken because both players would queue and then wait up to 15s. Set `matchmaker.interval_sec: 2` in `local.yml` (and carry forward to `prod.yml`) on any new Nakama deploy.
19. **1Hz match tick = laggy perceived feel.** The plan originally specified `tickRate=1` on the grounds that moves "arrive as messages regardless of tick rate". That's technically true but misleading — `MatchLoop` still only runs at tick rate, so a move message waits until the next loop iteration before being applied and broadcast. At 1Hz that's up to 1000ms of dead time. 20Hz fixes it without measurable CPU cost.

---

## 6 · Remaining work

### 6.1 M4b — Production deploy (Heroku + Vercel)

**Goal:** the live URL from the assignment brief. Game reachable at a
public hostname, backed by a real Nakama instance with TLS, never
sleeping, with stats/leaderboard persisting across dyno restarts.

**Why Heroku over other hosts** — user has an active subscription, so
cost is sunk. Basic dyno ($7/mo) never sleeps, survives reviewer
visits days later. Heroku Postgres Mini ($5/mo) is paid, persistent,
no 30-day expiry. TLS + WebSocket routing are bundled at the router
(no Caddy needed). `heroku ps:forward` tunnels the console port.
Dyno cycles once every ~24h (a ~20s blip) which is invisible to a
reviewer since matches last ~2min. Alternatives considered + rejected:
Koyeb (free, but 512MB free tier is tight, acquisition risk, less
mature tooling); Render/Fly/Railway free tiers either require a
credit card or sleep on idle; DigitalOcean droplet works but is a
pointless second bill when Heroku subscription is already paid.

**Files to build:**

1. **[server/Dockerfile.heroku](server/Dockerfile.heroku)** — multi-stage, identical builder stage to the existing Dockerfile, final stage copies `deploy/prod.yml` + `server/heroku-entrypoint.sh` and sets the shim as `CMD`.

2. **[server/heroku-entrypoint.sh](server/heroku-entrypoint.sh)** — executable shell shim:
   ```sh
   #!/bin/sh
   set -eu
   DB="$(printf '%s' "$DATABASE_URL" | sed -E 's|^postgres(ql)?://||')"
   case "$DB" in *'?'*) DB="${DB}&sslmode=require" ;; *) DB="${DB}?sslmode=require" ;; esac
   /nakama/nakama migrate up --database.address "$DB"
   exec /nakama/nakama \
     --config /nakama/data/prod.yml \
     --database.address "$DB" \
     --socket.port "$PORT" \
     --socket.server_key "$NAKAMA_SERVER_KEY" \
     --runtime.http_key "$NAKAMA_HTTP_KEY" \
     --session.encryption_key "$NAKAMA_SESSION_KEY" \
     --session.refresh_encryption_key "$NAKAMA_SESSION_REFRESH" \
     --console.username "$NAKAMA_CONSOLE_USER" \
     --console.password "$NAKAMA_CONSOLE_PASSWORD"
   ```
   Heroku exposes `DATABASE_URL` as `postgres://user:pass@host:port/db`; Nakama wants `user:pass@host:port/db` with `?sslmode=require`. All secrets come from `heroku config:set` — no secret ever lands in a committed file.

3. **[deploy/prod.yml](deploy/prod.yml)** — non-secret prod overrides only (logger level, socket timeouts, match queues, matchmaker `interval_sec: 2`). Same shape as `local.yml`, secret fields omitted because they're passed via CLI flags above.

4. **[heroku.yml](heroku.yml)** — app manifest:
   ```yaml
   build:
     docker:
       web: server/Dockerfile.heroku
   ```
   No `run` block (Dockerfile `CMD` is the entrypoint). No `release` phase (migrations run inside the shim on dyno boot — the official Nakama pattern).

5. **[client/.env.production.example](client/.env.production.example)** — Vercel-injected prod template:
   ```
   VITE_NAKAMA_HOST=<your-app>.herokuapp.com
   VITE_NAKAMA_PORT=443
   VITE_NAKAMA_USE_SSL=true
   VITE_NAKAMA_SERVER_KEY=<same as NAKAMA_HTTP_KEY on server>
   ```
   Real values live in Vercel's env-var UI; only the template is committed.

6. **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** — dedicated walkthrough (README stays short). Sections: prereqs, server deploy to Heroku (CLI block + `heroku logs --tail` verification), client deploy to Vercel, admin console tunneling via `heroku ps:forward 7351:7351`, troubleshooting (plugin ABI mismatch, `sslmode=require`, dyno restart behaviour), cost note ($7 dyno + $5 Postgres Mini).

**Heroku CLI setup (documented in walkthrough, not run from Claude):**

```sh
heroku create <app-name>
heroku stack:set container --app <app-name>
heroku addons:create heroku-postgresql:mini --app <app-name>
heroku config:set \
  NAKAMA_SERVER_KEY="$(openssl rand -hex 24)" \
  NAKAMA_HTTP_KEY="$(openssl rand -hex 24)" \
  NAKAMA_SESSION_KEY="$(openssl rand -hex 32)" \
  NAKAMA_SESSION_REFRESH="$(openssl rand -hex 32)" \
  NAKAMA_CONSOLE_USER="admin" \
  NAKAMA_CONSOLE_PASSWORD="$(openssl rand -hex 24)" \
  --app <app-name>
heroku ps:scale web=1:basic --app <app-name>   # $7/mo, never sleeps
git push heroku main
```

**Verification:**
- Dry-run locally: `docker build -f server/Dockerfile.heroku -t ttt-heroku .` succeeds; `docker run --rm -e PORT=7350 -e DATABASE_URL=postgres://... [all env vars] ttt-heroku` boots against a local Postgres and migrates cleanly.
- `git push heroku main` → `heroku logs --tail` shows `"Module loaded"` → `"Registered match handler 'tictactoe'"` → `"Startup done"`.
- `curl https://<app>.herokuapp.com/healthcheck` → 200.
- `heroku ps:forward 7351:7351` → console reachable at `http://localhost:7351` with `NAKAMA_CONSOLE_USER` / `NAKAMA_CONSOLE_PASSWORD`.
- Vercel deploy with the four prod env vars → two incognito windows can play full classic + timed matches end-to-end against the live stack.
- Leaderboard on Vercel URL shows the wins.
- Leave the app idle 30 min; refresh — still responsive (Basic dyno doesn't sleep).

**Rollback:**
- Client: Vercel keeps every deploy; "Promote to Production" on any prior build.
- Server: `heroku releases` → `heroku rollback v<N>` returns to previous image in seconds.
- Postgres: `heroku pg:backups:capture` before first M4b deploy; restore via `heroku pg:backups:restore <id>` if needed.

**Commit plan:**
1. `feat(deploy): heroku production dockerfile + entrypoint shim`
2. `feat(deploy): nakama prod config + env-driven secrets`
3. `feat(deploy): heroku.yml manifest`
4. `feat(client): vercel prod env template`
5. `docs: heroku + vercel deployment walkthrough`

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

1. Run `git log --oneline -20` — top commits should include `8560162` (tickRate 20Hz) → `5369df8` (matchmaker 2s) → `e58c22b` (leaderboard link in record card) → `b33987e` (mobile 400px) → `987c89a` (drop Play Again) → `fc0a33e` (leaderboard ranked list) → `453cabd` (home single-col) → `56bafdd` (editorial primitives) → `956baad` (M3 plan snapshot). If not, the state described in §3 may have drifted; trust the code.
2. `docker ps` — if Nakama + Postgres are up, skip to the task. Otherwise `npm run dev`. **Known proxy gotcha:** if BuildKit stalls on `[internal] load metadata`, pre-pull the base images via `docker pull heroiclabs/nakama:3.38.0` + `docker pull heroiclabs/nakama-pluginbuilder:3.38.0`, then run with `--pull=never` (see §5 gotcha 11).
3. Read `PLAN.md` §4 (decisions) and §5 (gotchas) before touching server or design code. **Most bugs we've hit are foot-guns listed there** — especially gotcha 15 (design restraint) before any UI work.
4. **Commit cadence: one meaningful chunk per commit, conventional-style messages (`feat(server): ...`, `fix(client): ...`). No `Co-Authored-By` trailer. Don't push until asked.**
5. Start at §6.1 (M4b — Heroku + Vercel deploy) unless directed otherwise.
