# Deployment walkthrough — Heroku (server) + Vercel (client)

This document walks through a cold deploy of the tic-tac-toe app to
production. The server runs on Heroku as a container dyno with a
Heroku Postgres Mini attached; the client ships as a static Vite
bundle on Vercel.

Runtime cost at the end: ~$12/month ($7 Basic dyno + $5 Postgres Mini,
Vercel Hobby tier is free for personal projects).

- **App name**: `tic-tac-toe-nakama`
- **Region**: `eu`

Replace those two strings in the commands below if you renamed / re-regioned the app.

---

## 1. Prerequisites

One-time setup, all on your local machine.

| Tool | Check | Install |
|------|-------|---------|
| Heroku CLI | `heroku --version` | https://devcenter.heroku.com/articles/heroku-cli |
| Docker Desktop (optional, local dry-run only) | `docker --version` | https://www.docker.com/products/docker-desktop |
| `openssl` (for generating secrets) | `openssl version` | Ships with Git Bash on Windows |
| Logged into Heroku | `heroku auth:whoami` | `heroku login` |
| GitHub repo pushed | `git remote -v` | already done |

Vercel just needs a GitHub-linked account at https://vercel.com — no CLI required.

---

## 2. Server → Heroku

### 2.1 Create the app and database

```sh
heroku create tic-tac-toe-nakama --region eu
heroku stack:set container --app tic-tac-toe-nakama
heroku addons:create heroku-postgresql:mini --app tic-tac-toe-nakama
```

`mini` is the $5/mo tier (10k rows, 1 GB). The addon will export
`DATABASE_URL` onto the dyno automatically — the entrypoint shim picks it
up from there.

### 2.2 Generate and set secrets

```sh
heroku config:set \
  NAKAMA_SERVER_KEY="$(openssl rand -hex 24)" \
  NAKAMA_HTTP_KEY="$(openssl rand -hex 24)" \
  NAKAMA_SESSION_KEY="$(openssl rand -hex 32)" \
  NAKAMA_SESSION_REFRESH="$(openssl rand -hex 32)" \
  NAKAMA_CONSOLE_USER="admin" \
  NAKAMA_CONSOLE_PASSWORD="$(openssl rand -hex 24)" \
  --app tic-tac-toe-nakama
```

Save a copy of the output — you will need `NAKAMA_SERVER_KEY` for Vercel
and `NAKAMA_CONSOLE_PASSWORD` to log into the admin console later.

Verify:

```sh
heroku config --app tic-tac-toe-nakama
```

### 2.3 Upgrade to Basic dyno (never-sleeping)

Eco dynos sleep after 30 minutes of inactivity — a reviewer opening the
app cold would wait 10–15 seconds for first response. Basic dynos at
$7/mo stay awake:

```sh
heroku ps:scale web=1:basic --app tic-tac-toe-nakama
```

### 2.4 Push the code

The Heroku remote was added automatically by `heroku create`. Push
`main`:

```sh
git push heroku main
```

First push takes ~5 minutes (pulls the `heroiclabs/nakama-pluginbuilder`
and `heroiclabs/nakama` base images, compiles the Go plugin). Subsequent
pushes are faster because Heroku caches layers.

Watch the build. Success looks like:

```
...
-----> Building web (server/Dockerfile.heroku)
...
Successfully built <hash>
...
Released v3
https://tic-tac-toe-nakama.herokuapp.com/ deployed to Heroku
```

### 2.5 Verify the server is up

```sh
heroku logs --tail --app tic-tac-toe-nakama
```

Look for, in order:
1. `Database migrations applied`
2. `Registered match handler for 'tictactoe'`
3. `Startup done`

Then in another terminal:

```sh
curl https://tic-tac-toe-nakama.herokuapp.com/healthcheck
# → {}
```

`{}` (empty JSON object) with a 200 is healthy — Nakama's healthcheck
returns no body.

### 2.6 (Optional) Admin console

The console port (7351) is not publicly routed — only `$PORT` is. To
reach it, tunnel through the dyno:

```sh
heroku ps:forward 7351:7351 --app tic-tac-toe-nakama
```

Open http://localhost:7351 and log in with `admin` / the
`NAKAMA_CONSOLE_PASSWORD` you set in 2.2.

---

## 3. Client → Vercel

### 3.1 Import the repo

1. Go to https://vercel.com/new
2. Import the GitHub repository
3. Framework preset: **Vite**
4. Root directory: **`client`**  ← important, the repo root also has a `package.json`
5. Build command: `npm run build`
6. Output directory: `dist`

Don't click Deploy yet — env vars first.

### 3.2 Set environment variables

In the import screen (or later: Project → Settings → Environment Variables),
add these four, scope **Production** (also tick Preview if you want PR
previews to talk to the same server):

| Key | Value |
|-----|-------|
| `VITE_NAKAMA_HOST` | `tic-tac-toe-nakama.herokuapp.com` |
| `VITE_NAKAMA_PORT` | `443` |
| `VITE_NAKAMA_USE_SSL` | `true` |
| `VITE_NAKAMA_SERVER_KEY` | *(paste the `NAKAMA_SERVER_KEY` from 2.2 — same string)* |

See [client/.env.production.example](../client/.env.production.example) for
the same template.

### 3.3 Deploy

Click **Deploy**. First build takes ~1 minute. Vercel gives you a URL
like `https://tic-tac-toe-nakama.vercel.app`.

### 3.4 Smoke test

1. Open the Vercel URL in two incognito windows.
2. Click **Find a match** in both — they should pair within ~2 seconds.
3. Play a full classic match, confirm the end overlay shows correct
   winner + stats echo.
4. Repeat with **Timed mode**.
5. Visit the **Leaderboard** — your wins from step 3–4 should be there.
6. Leave the app idle for 30 minutes, then refresh. Still responsive =
   the Basic dyno isn't sleeping. ✅

---

## 4. Troubleshooting

### `plugin was built with a different version of package ...`

The `nakama-pluginbuilder` tag in [server/Dockerfile.heroku](../server/Dockerfile.heroku)
drifted out of sync with the `nakama` runtime tag. They MUST match
(currently both `3.38.0`).

### `pq: SSL is not enabled on the server`

The entrypoint shim failed to append `?sslmode=require`. Check
`heroku logs --tail` for the exact DSN it built — most commonly this
means `DATABASE_URL` isn't set (Postgres addon missing). Verify with
`heroku config | grep DATABASE_URL`.

### Client connects, but `authenticate_device` returns 401

`VITE_NAKAMA_SERVER_KEY` on Vercel does not match `NAKAMA_SERVER_KEY`
on Heroku. Redeploy Vercel after fixing; the env var is inlined at
build time, not read at runtime.

### Dyno restarts mid-match

Heroku cycles dynos once every ~24 hours — this is normal, ~20-second
blip. In-flight matches will fail to rehydrate (the in-memory match
state is gone), but users can rejoin from the lobby immediately.

### "Application error" on the Heroku URL

```sh
heroku logs --tail --app tic-tac-toe-nakama
```

Almost always one of:
- Missing config var (shim exits with `parameter not set`)
- Plugin ABI mismatch (see above)
- Database migration failed (check the first `migrate up` output)

### Rolling back

Server: `heroku releases --app tic-tac-toe-nakama` → `heroku rollback v<N>`.
Rolls back to the previous Docker image in ~10 seconds.

Client: Vercel → Deployments → find the last good one → "Promote to
Production".

Database: take a backup before any risky migration:
```sh
heroku pg:backups:capture --app tic-tac-toe-nakama
heroku pg:backups:restore b<ID> DATABASE_URL --app tic-tac-toe-nakama
```

---

## 5. Cost summary

| Resource | Tier | Cost |
|----------|------|------|
| Heroku web dyno | Basic | $7/mo |
| Heroku Postgres | Mini | $5/mo |
| Vercel | Hobby | $0 |
| **Total** | | **$12/mo** |

Basic dyno never sleeps. Eco ($5/mo) would save $2/mo but sleeps after
30 minutes — not worth it for a demo that reviewers open cold.
