# syntax=docker/dockerfile:1.7

# -----------------------------------------------------------------------------
# This Dockerfile MUST be built with the repository root as the build context
# so that both `server/` and `deploy/` are reachable. See deploy/docker-compose.yml
# for the compose build.context and build.dockerfile wiring.
# -----------------------------------------------------------------------------

# -----------------------------------------------------------------------------
# Stage 1: build the Go plugin against the exact Nakama ABI.
#
# The pluginbuilder image tag MUST match the nakama image tag in stage 2.
# Mismatched Go versions or nakama-common minor revisions between the two
# images are the #1 cause of "plugin was built with a different version of
# package X" runtime errors.
# -----------------------------------------------------------------------------
FROM heroiclabs/nakama-pluginbuilder:3.38.0 AS builder

ENV GOOS=linux \
    GOARCH=amd64 \
    CGO_ENABLED=1

WORKDIR /backend

# Cache dependencies on their own layer. Touching application code does not
# invalidate the module download step unless go.mod/go.sum actually change.
COPY server/go-module/go.mod server/go-module/go.sum* ./
RUN go mod download

COPY server/go-module/ ./

# --trimpath strips local filesystem prefixes from the binary; --buildmode=plugin
# emits the .so that Nakama loads at startup via the modules directory.
RUN go mod tidy \
 && go build --trimpath --buildmode=plugin -o ./backend.so .

# -----------------------------------------------------------------------------
# Stage 2: final image carrying only the Nakama server and the compiled plugin.
# -----------------------------------------------------------------------------
FROM heroiclabs/nakama:3.38.0

COPY --from=builder /backend/backend.so /nakama/data/modules/backend.so
COPY deploy/local.yml /nakama/data/local.yml
