import { Session } from "@heroiclabs/nakama-js";

// Caches tokens in localStorage so refresh skips the ~200ms authenticate hop.
// XSS on the page could exfiltrate these; device-ID-auth makes that acceptable.

const STORAGE_KEY = "tictactoe.session";

interface StoredSession {
  token: string;
  refreshToken: string;
}

export function saveSession(session: Session): void {
  const token = session.token;
  const refreshToken = session.refresh_token ?? "";
  if (!token || !refreshToken) return;
  const payload: StoredSession = { token, refreshToken };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {}
}

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
  // 30s buffer so a token that expires mid-handshake doesn't reach the socket.
  const nowSec = Math.floor(Date.now() / 1000) + 30;
  if (session.isexpired(nowSec)) {
    return null;
  }
  return session;
}

export function clearSession(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}
