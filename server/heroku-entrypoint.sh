#!/bin/sh
# Translates Heroku's DATABASE_URL (libpq form) to what Nakama's
# --database.address flag expects, and binds the socket to the dyno's $PORT.
# Secrets come from `heroku config:set`; nothing sensitive is baked into the image.
set -eu

DB="$(printf '%s' "$DATABASE_URL" | sed -E 's|^postgres(ql)?://||')"

# Heroku Postgres requires TLS.
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
