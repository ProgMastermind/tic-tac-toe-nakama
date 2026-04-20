#!/bin/sh
# -----------------------------------------------------------------------------
# Heroku entrypoint for Nakama.
#
# Heroku injects two things we have to translate before Nakama can boot:
#
#   1. DATABASE_URL is in libpq form: postgres://user:pass@host:port/db
#      Nakama's --database.address flag wants: user:pass@host:port/db
#      Heroku Postgres requires TLS, so we also ensure ?sslmode=require is
#      present on the DSN.
#
#   2. PORT is assigned dynamically per dyno. Nakama's socket must bind to
#      exactly that port — no EXPOSE / hardcoded 7350 will work.
#
# All secrets (server key, http key, session keys, console password) come
# from `heroku config:set` as environment variables; we pass them via CLI
# flags so they override whatever's in prod.yml. Nothing sensitive lives
# inside the committed image.
#
# `migrate up` is idempotent and runs every dyno boot — cheaper than a
# separate release phase and survives dyno restarts cleanly.
# -----------------------------------------------------------------------------
set -eu

# Strip the postgres:// or postgresql:// scheme — Nakama wants the bare DSN.
DB="$(printf '%s' "$DATABASE_URL" | sed -E 's|^postgres(ql)?://||')"

# Append sslmode=require (Heroku Postgres mandates TLS). Preserve any
# existing query string if Heroku ever adds one.
case "$DB" in
  *\?*) DB="${DB}&sslmode=require" ;;
  *)    DB="${DB}?sslmode=require" ;;
esac

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
