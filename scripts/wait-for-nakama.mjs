#!/usr/bin/env node
/**
 * Poll the Nakama healthcheck endpoint until it responds 200 OK, with a
 * hard timeout. Used in `npm run dev` to make sure the client doesn't
 * start hammering a half-booted server during the first `docker build`.
 */

import { setTimeout as sleep } from "node:timers/promises";

const HEALTH = process.env.NAKAMA_HEALTH_URL ?? "http://127.0.0.1:7350/healthcheck";
const TIMEOUT_MS = Number(process.env.NAKAMA_WAIT_TIMEOUT_MS ?? 180_000);
const INTERVAL_MS = 1000;

const deadline = Date.now() + TIMEOUT_MS;
let attempt = 0;

process.stdout.write(`Waiting for Nakama at ${HEALTH} (timeout ${TIMEOUT_MS / 1000}s)…\n`);

while (Date.now() < deadline) {
  attempt++;
  try {
    const r = await fetch(HEALTH, { method: "GET" });
    if (r.ok) {
      process.stdout.write(`Nakama is ready after ${attempt} attempts.\n`);
      process.exit(0);
    }
  } catch {
    // Connection refused / DNS miss while the container is still booting.
    // That's expected — just wait and try again.
  }
  await sleep(INTERVAL_MS);
}

process.stderr.write(
  `\x1b[31mNakama did not become healthy within ${TIMEOUT_MS / 1000}s. ` +
    "Run `npm run server:logs` to see what went wrong.\x1b[0m\n",
);
process.exit(1);
