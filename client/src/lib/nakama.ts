import { Client } from "@heroiclabs/nakama-js";

// Bumping this storage key effectively signs every existing browser out.
const DEVICE_ID_STORAGE_KEY = "tictactoe.deviceId";

// Nakama rejects device IDs shorter than this.
const MIN_DEVICE_ID_LENGTH = 10;

export interface NakamaConnectionConfig {
  host: string;
  port: string;
  serverKey: string;
  useSSL: boolean;
}

// Fails loudly at module load rather than surfacing a cryptic WebSocket error later.
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

export function createClient(config: NakamaConnectionConfig): Client {
  return new Client(config.serverKey, config.host, config.port, config.useSSL);
}

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
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Test-only — reproduce first-visit flows without opening incognito.
export function clearDeviceId(): void {
  localStorage.removeItem(DEVICE_ID_STORAGE_KEY);
}

export const GUEST_USERNAME_PREFIX = "guest-";

export function guestUsernameFor(deviceId: string): string {
  return `${GUEST_USERNAME_PREFIX}${deviceId.slice(0, 6)}`;
}
