/**
 * Thin wrapper around child_process.spawn/spawnSync that avoids Node 24's
 * DEP0190 warning (args-with-shell-true) while still working cross-platform
 * on Windows where npm/docker/go are shipped as .cmd scripts.
 *
 * Strategy: join the command and its args into a single shell command
 * string. Every arg we call with is a project-controlled string literal —
 * no user input ever flows into these, so the injection risk the warning
 * exists to prevent does not apply here. We still quote args that contain
 * whitespace defensively.
 */

import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";

/**
 * Build a shell-ready command string. Arguments that contain whitespace
 * are wrapped in double quotes; no other escaping is performed because
 * every call site uses static strings.
 */
export function joinCommand(cmd, args = []) {
  const parts = [cmd, ...args].map((segment) => {
    if (segment == null) return "";
    const s = String(segment);
    return /\s/.test(s) ? `"${s}"` : s;
  });
  return parts.join(" ");
}

export function spawnShell(cmd, args, options = {}) {
  return nodeSpawn(joinCommand(cmd, args), { shell: true, ...options });
}

export function spawnShellSync(cmd, args, options = {}) {
  return nodeSpawnSync(joinCommand(cmd, args), { shell: true, ...options });
}
