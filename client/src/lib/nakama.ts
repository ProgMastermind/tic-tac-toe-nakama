import { Client } from "@heroiclabs/nakama-js";

/*
 * Nakama client factory and device-identity helpers.
 *
 * The Client object is created once and shared via context. Session and
 * Socket objects are managed by NakamaProvider because they have a real
 * lifecycle (authenticate, refresh, reconnect).
 */

/**
 * Key used to persist the per-browser device identifier in localStorage.
 * Bumping this value effectively signs every existing browser out.
 */
const DEVICE_ID_STORAGE_KEY = "tictactoe.deviceId";

/**
 * Minimum byte length Nakama accepts for a device ID. The server rejects
 * anything shorter, so we generate a full UUID-length identifier and
 * enforce it here before handing it off.
 */
const MIN_DEVICE_ID_LENGTH = 10;

export interface NakamaConnectionConfig {
  host: string;
  port: string;
  serverKey: string;
  useSSL: boolean;
}

/**
 * readConnectionConfig resolves environment variables into a strongly-typed
 * struct, throwing loudly if anything is missing. Failing at module load is
 * preferable to a blank screen with a cryptic WebSocket error later.
 */
export function readConnectionConfig(): NakamaConnectionConfig {
  const { VITE_NAKAMA_HOST, VITE_NAKAMA_PORT, VITE_NAKAMA_SERVER_KEY, VITE_NAKAMA_USE_SSL } =
    import.meta.env;

  const host = VITE_NAKAMA_HOST?.trim();
  const port = VITE_NAKAMA_PORT?.trim();
  const serverKey = VITE_NAKAMA_SERVER_KEY?.trim();
  const useSSL = (VITE_NAKAMA_USE_SSL ?? "false").trim().toLowerCase() === "true";

  if (!host || !port || !serverKey) {
    throw new Error(
      "Missing Nakama env vars — copy client/.env.example to client/.env and fill it in.",
    );
  }

  return { host, port, serverKey, useSSL };
}

/**
 * createClient builds a Nakama HTTP client with the supplied config. The
 * client is safe to hold onto for the lifetime of the app — it does not
 * keep a persistent connection.
 */
export function createClient(config: NakamaConnectionConfig): Client {
  return new Client(config.serverKey, config.host, config.port, config.useSSL);
}

/**
 * ensureDeviceId returns a stable identifier for this browser, generating
 * and persisting one on first call. Uses crypto.randomUUID when available
 * (all evergreen browsers) and falls back to a crypto-random string for
 * older runtimes.
 */
export function ensureDeviceId(): string {
  const existing = localStorage.getItem(DEVICE_ID_STORAGE_KEY);
  if (existing && existing.length >= MIN_DEVICE_ID_LENGTH) {
    return existing;
  }
  const fresh = mintDeviceId();
  localStorage.setItem(DEVICE_ID_STORAGE_KEY, fresh);
  return fresh;
}

function mintDeviceId(): string {
  // crypto.randomUUID is standard in every evergreen browser; keep the
  // fallback narrow so we aren't pulling in a uuid polyfill for no reason.
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Test-only: clear the persisted device identity. Useful for reproducing
 * first-visit flows without opening a fresh incognito window each time.
 * Not exported from the app entry — callable from the devtools console
 * via `localStorage.removeItem("tictactoe.deviceId")`.
 */
export function clearDeviceId(): void {
  localStorage.removeItem(DEVICE_ID_STORAGE_KEY);
}

/** String used as the prefix for display names derived from device IDs. */
export const GUEST_USERNAME_PREFIX = "guest-";

/**
 * guestUsernameFor derives a short, human-scannable placeholder name from
 * the first segment of a device ID. The user is invited to change it on
 * the home screen; this is just a non-empty default.
 */
export function guestUsernameFor(deviceId: string): string {
  return `${GUEST_USERNAME_PREFIX}${deviceId.slice(0, 6)}`;
}
