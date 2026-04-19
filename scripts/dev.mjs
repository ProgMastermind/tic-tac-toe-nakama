#!/usr/bin/env node
/**
 * Single-command orchestrator for local development.
 *
 *   1. Idempotent setup (copy .env, install client deps if missing).
 *   2. Bring the Nakama + Postgres stack up in detached mode.
 *   3. Poll Nakama's healthcheck until it responds.
 *   4. Start the Vite dev server in the foreground.
 *   5. On Ctrl+C (or any exit) — stop the docker stack cleanly.
 *
 * Works identically on Windows (cmd/PowerShell/Git Bash), macOS, and Linux
 * because everything is routed through Node. Failure at any step surfaces
 * a useful message — no cryptic "pipeline broke somewhere" states.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { spawnShell, spawnShellSync } from "./lib/spawn.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

let stopping = false;

// ---- Signal handling ---------------------------------------------------
const cleanup = async (code = 0) => {
  if (stopping) return;
  stopping = true;
  log("\nStopping Nakama stack…", "dim");
  const r = spawnShellSync(
    "docker",
    ["compose", "-f", "deploy/docker-compose.yml", "down"],
    { cwd: repoRoot, stdio: "inherit" },
  );
  process.exit(r.status ?? code);
};
process.on("SIGINT", () => cleanup(0));
process.on("SIGTERM", () => cleanup(0));

// ---- Step 1: setup -----------------------------------------------------
log("→ Running setup…", "cyan");
if (runSync("node", ["scripts/setup.mjs"]) !== 0) fatal("setup failed");

// ---- Step 2: bring up docker -------------------------------------------
log("\n→ Bringing up Nakama + Postgres (first build ~3-5 min, cached afterwards)…", "cyan");
if (
  runSync("docker", [
    "compose",
    "-f",
    "deploy/docker-compose.yml",
    "up",
    "--build",
    "-d",
  ]) !== 0
) {
  fatal("docker compose up failed. Is Docker Desktop running?");
}

// ---- Step 3: wait for health -------------------------------------------
log("\n→ Waiting for Nakama healthcheck…", "cyan");
if (runSync("node", ["scripts/wait-for-nakama.mjs"]) !== 0) {
  log("Showing Nakama logs to help diagnose:", "yellow");
  runSync("docker", [
    "compose",
    "-f",
    "deploy/docker-compose.yml",
    "logs",
    "--tail",
    "80",
    "nakama",
  ]);
  await cleanup(1);
}

// ---- Step 4: vite in the foreground ------------------------------------
log("\n→ Starting Vite dev server…", "cyan");
log("  Nakama:  http://127.0.0.1:7350  (console: http://127.0.0.1:7351)", "dim");
log("  Client:  http://127.0.0.1:5173  (opens in a moment)\n", "dim");

const vite = spawnShell(
  "npm",
  ["--prefix", "client", "run", "dev"],
  { cwd: repoRoot, stdio: "inherit" },
);

vite.on("exit", (code) => cleanup(code ?? 0));

// -----------------------------------------------------------------------

function runSync(cmd, args) {
  const r = spawnShellSync(cmd, args, { cwd: repoRoot, stdio: "inherit" });
  return r.status ?? 1;
}

function log(msg, color = "reset") {
  const codes = { reset: 0, cyan: 36, yellow: 33, dim: 2 };
  const c = codes[color] ?? 0;
  process.stdout.write(`\x1b[${c}m${msg}\x1b[0m\n`);
}

function fatal(msg) {
  process.stderr.write(`\x1b[31m${msg}\x1b[0m\n`);
  cleanup(1);
}
