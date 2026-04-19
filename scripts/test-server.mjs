#!/usr/bin/env node
/**
 * Run the Go server tests from any platform. Uses `go test ./...` from
 * server/go-module with the repo-root go.sum so the result is reproducible.
 * Falls back gracefully if Go isn't installed.
 */

import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { spawnShellSync } from "./lib/spawn.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const goModule = resolve(repoRoot, "server/go-module");

if (!existsSync(goModule)) {
  process.stderr.write(`error: ${goModule} not found\n`);
  process.exit(1);
}

const probe = spawnShellSync("go", ["version"], { stdio: "pipe" });
if (probe.status !== 0) {
  process.stderr.write(
    "\x1b[33mSkipping server tests: `go` not on PATH. " +
      "Install Go 1.22+ or run this inside the Docker pluginbuilder.\x1b[0m\n",
  );
  process.exit(0);
}

// -race is not enabled by default because it needs cgo (a C toolchain),
// which isn't on PATH on vanilla Windows setups. Set NAKAMA_TEST_RACE=1 to
// opt in locally or in CI.
const raceFlag = process.env.NAKAMA_TEST_RACE === "1" ? ["-race"] : [];
process.stdout.write(
  `Running: go test ${raceFlag.join(" ")} -count=1 ./... (in ${goModule})\n`,
);
const r = spawnShellSync("go", ["test", ...raceFlag, "-count=1", "./..."], {
  cwd: goModule,
  stdio: "inherit",
});
process.exit(r.status ?? 1);
