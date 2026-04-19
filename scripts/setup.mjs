#!/usr/bin/env node
/**
 * One-shot project setup. Idempotent — safe to run repeatedly.
 *
 * - Copies client/.env.example → client/.env if missing (the NakamaProvider
 *   throws on boot without this).
 * - Installs client npm deps if node_modules is missing.
 * - Sanity-checks that docker and node are on PATH, warning but not
 *   failing if something is missing (the user might be setting up just
 *   the client half).
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { spawnShellSync } from "./lib/spawn.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const env = {
  example: resolve(repoRoot, "client/.env.example"),
  target: resolve(repoRoot, "client/.env"),
};

const clientNodeModules = resolve(repoRoot, "client/node_modules");

// --- Copy .env.example → .env -------------------------------------------
if (!existsSync(env.target)) {
  if (!existsSync(env.example)) {
    die(`Missing ${env.example}. Did the repo clone fully?`);
  }
  mkdirSync(dirname(env.target), { recursive: true });
  copyFileSync(env.example, env.target);
  info(`Created client/.env from .env.example`);
} else {
  info(`client/.env already exists — leaving as-is`);
}

// --- Install client deps ------------------------------------------------
if (!existsSync(clientNodeModules)) {
  info("Installing client dependencies (first run)…");
  const r = spawnShellSync("npm", ["install"], {
    cwd: resolve(repoRoot, "client"),
    stdio: "inherit",
  });
  if (r.status !== 0) die("client npm install failed");
} else {
  info("client/node_modules present — skipping install");
}

// --- Sanity-probe tooling so the user gets a helpful message early ------
check("node", ["--version"], { required: true });
check("npm", ["--version"], { required: true });
check("docker", ["--version"], { required: false, hint: "Docker Desktop is required for `npm run dev`." });
check("go", ["version"], { required: false, hint: "Go is only needed if you want to run `npm run test:server`." });

info("\nSetup complete. Handy commands:");
info("  npm run test       — server unit tests + client typecheck + build");
info("  npm run dev        — bring up Nakama + Postgres + the client dev server");
info("  npm run server:up  — background: just the Nakama stack");
info("  npm run server:logs — tail Nakama logs");
info("  npm run server:down — stop and remove containers");

// -----------------------------------------------------------------------

function check(cmd, args, opts) {
  const r = spawnShellSync(cmd, args, { stdio: "pipe" });
  if (r.status === 0) {
    const version = String(r.stdout || r.stderr).trim().split(/\r?\n/)[0];
    info(`✓ ${cmd}: ${version}`);
  } else if (opts.required) {
    die(`Required tool not found on PATH: ${cmd}`);
  } else {
    warn(`? ${cmd} not found. ${opts.hint ?? ""}`);
  }
}

function info(msg) {
  process.stdout.write(msg + "\n");
}
function warn(msg) {
  process.stdout.write("\x1b[33m" + msg + "\x1b[0m\n");
}
function die(msg) {
  process.stderr.write("\x1b[31m" + msg + "\x1b[0m\n");
  process.exit(1);
}

