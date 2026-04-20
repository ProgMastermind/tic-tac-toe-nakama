# Build context MUST be the repo root so both server/ and deploy/ are reachable.
# The pluginbuilder tag MUST match the nakama tag below — mismatches cause
# "plugin was built with a different version of package X" at boot.

FROM heroiclabs/nakama-pluginbuilder:3.38.0 AS builder

ENV GOOS=linux \
    GOARCH=amd64 \
    CGO_ENABLED=1

WORKDIR /backend

# Separate layer so app code changes don't invalidate module download.
COPY server/go-module/go.mod server/go-module/go.sum* ./
RUN go mod download

COPY server/go-module/ ./

RUN go mod tidy \
 && go build --trimpath --buildmode=plugin -o ./backend.so .

FROM heroiclabs/nakama:3.38.0

COPY --from=builder /backend/backend.so /nakama/data/modules/backend.so
COPY deploy/local.yml /nakama/data/local.yml
