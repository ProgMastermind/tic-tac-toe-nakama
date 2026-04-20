import { Session } from "@heroiclabs/nakama-js";

/*
 * Session persistence — caches the access + refresh tokens in localStorage
 * so that a page refresh can skip the authenticate round trip. Knocks
 * one ~200ms HTTP hop off the cold-load splash on repeat visits.
 *
 * The token itself is a signed JWT; storing it in localStorage is no more
 * dangerous than storing it in a cookie without HttpOnly — an attacker who
 * already has XSS on the page can exfiltrate either. The trade-off is
 * acceptable for a device-ID-auth game client, and the server rotates
 * session keys regularly.
 */

const STORAGE_KEY = "tictactoe.session";

interface StoredSession {
  token: string;
  refreshToken: string;
}

/**
 * Persist the session's tokens to localStorage. Silent no-op if storage
 * is disabled (private-mode Safari, full disk, etc.) — the app falls
 * back to re-authenticating on next load.
 */
export function saveSession(session: Session): void {
  const token = session.token;
  const refreshToken = session.refresh_token ?? "";
  if (!token || !refreshToken) return;
  const payload: StoredSession = { token, refreshToken };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // storage full or disabled — fall through, re-authenticate next time
  }
}

/**
 * Rehydrate a Session from localStorage if one is present and not
 * already expired. A 30-second expiry buffer prevents us from returning
 * a session that will reject during the socket handshake.
 */
export function restoreSession(): Session | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: StoredSession;
  try {
    parsed = JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }
  if (!parsed.token || !parsed.refreshToken) return null;

  const session = Session.restore(parsed.token, parsed.refreshToken);
  // Session.isexpired takes a unix-seconds timestamp; treat anything
  // within the next 30s as already expired so we don't hand out a token
  // that will reject mid-handshake.
  const nowSec = Math.floor(Date.now() / 1000) + 30;
  if (session.isexpired(nowSec)) {
    return null;
  }
  return session;
}

/** Drop the cached session. Call this when a restored token is rejected. */
export function clearSession(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
