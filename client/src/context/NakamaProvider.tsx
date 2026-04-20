import type { Client, Session, Socket } from "@heroiclabs/nakama-js";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  createClient,
  ensureDeviceId,
  guestUsernameFor,
  readConnectionConfig,
} from "@/lib/nakama";
import { clearSession, restoreSession, saveSession } from "@/lib/session";
import type { GetCurrentMatchResponse } from "@/types/match";

// Wires the Nakama client, session, and socket into one React context.
// After the first successful connect a disconnect flips `isReconnecting`
// and runs an exponential-backoff loop (1s → 30s) rather than dropping
// the user back to the error screen.

export type NakamaStatus = "connecting" | "ready" | "error";

export interface NakamaContextValue {
  status: NakamaStatus;
  error: string | null;
  isReconnecting: boolean;
  // Bumped on every successful (re)connect — key rehydrate/refresh effects on this.
  reconnectGeneration: number;
  client: Client;
  session: Session | null;
  socket: Socket | null;
  deviceId: string;
  displayName: string;
  setDisplayName(name: string): Promise<void>;
  fetchCurrentMatch(): Promise<GetCurrentMatchResponse>;
  // Multiplexed registries — prefer these over assigning socket.on* directly
  // so reconnects don't silently drop existing subscribers.
  registerMatchDataHandler(
    handler: (md: Parameters<NonNullable<Socket["onmatchdata"]>>[0]) => void,
  ): () => void;
  registerMatchPresenceHandler(
    handler: (e: Parameters<NonNullable<Socket["onmatchpresence"]>>[0]) => void,
  ): () => void;
  registerMatchmakerMatchedHandler(
    handler: (m: Parameters<NonNullable<Socket["onmatchmakermatched"]>>[0]) => void,
  ): () => void;
}

const NakamaContext = createContext<NakamaContextValue | null>(null);

const RECONNECT_INITIAL_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30_000;

export function NakamaProvider({ children }: { children: ReactNode }) {
  const clientRef = useRef<Client | null>(null);
  if (clientRef.current === null) {
    clientRef.current = createClient(readConnectionConfig());
  }
  const client = clientRef.current;

  const [status, setStatus] = useState<NakamaStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [reconnectGeneration, setReconnectGeneration] = useState(0);

  const deviceId = useRef<string>(ensureDeviceId()).current;

  // Seed with the guest name so the masthead doesn't flash empty while
  // getAccount resolves in the background.
  const [displayName, setDisplayNameState] = useState<string>(() =>
    guestUsernameFor(deviceId),
  );

  const dataHandlers = useRef(
    new Set<(md: Parameters<NonNullable<Socket["onmatchdata"]>>[0]) => void>(),
  );
  const presenceHandlers = useRef(
    new Set<(e: Parameters<NonNullable<Socket["onmatchpresence"]>>[0]) => void>(),
  );
  const matchmakerHandlers = useRef(
    new Set<(m: Parameters<NonNullable<Socket["onmatchmakermatched"]>>[0]) => void>(),
  );

  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    // Guards against a stale socket's ondisconnect firing mid-retry.
    let reconnecting = false;

    const useSSL = readConnectionConfig().useSSL;

    function wireSocket(sock: Socket) {
      sock.onmatchdata = (md) => {
        for (const handler of dataHandlers.current) handler(md);
      };
      sock.onmatchpresence = (e) => {
        for (const handler of presenceHandlers.current) handler(e);
      };
      sock.onmatchmakermatched = (m) => {
        for (const handler of matchmakerHandlers.current) handler(m);
      };
    }

    function handleDisconnect(sess: Session) {
      if (cancelled) return;
      setIsReconnecting(true);
      scheduleReconnect(sess, 0);
    }

    function scheduleReconnect(sess: Session, attempt: number) {
      if (cancelled || reconnecting) return;
      reconnecting = true;

      const attemptOne = async (att: number) => {
        if (cancelled) {
          reconnecting = false;
          return;
        }
        try {
          const nextSocket = client.createSocket(useSSL, false);
          nextSocket.ondisconnect = () => handleDisconnect(sess);
          wireSocket(nextSocket);
          await nextSocket.connect(sess, true);
          if (cancelled) {
            nextSocket.disconnect(false);
            reconnecting = false;
            return;
          }
          setSocket(nextSocket);
          setIsReconnecting(false);
          setError(null);
          setReconnectGeneration((g) => g + 1);
          reconnecting = false;
        } catch {
          const delay = Math.min(
            RECONNECT_INITIAL_DELAY_MS * 2 ** att,
            RECONNECT_MAX_DELAY_MS,
          );
          reconnectTimer = setTimeout(() => attemptOne(att + 1), delay);
        }
      };

      const delay = Math.min(
        RECONNECT_INITIAL_DELAY_MS * 2 ** attempt,
        RECONNECT_MAX_DELAY_MS,
      );
      reconnectTimer = setTimeout(() => attemptOne(attempt), delay);
    }

    async function connect() {
      try {
        // Reuse the cached session when possible — skips one ~200ms auth hop.
        let next = restoreSession();
        if (!next) {
          next = await client.authenticateDevice(
            deviceId,
            true,
            guestUsernameFor(deviceId),
          );
        }
        if (cancelled) return;
        saveSession(next);

        const liveSocket = client.createSocket(useSSL, false);
        liveSocket.ondisconnect = () => handleDisconnect(next);
        wireSocket(liveSocket);

        await liveSocket.connect(next, true);
        if (cancelled) {
          liveSocket.disconnect(false);
          return;
        }

        setSession(next);
        setSocket(liveSocket);
        setStatus("ready");
        setError(null);
        setIsReconnecting(false);
        setReconnectGeneration((g) => g + 1);

        // Off the splash critical path — seed name stays visible until this resolves.
        client
          .getAccount(next)
          .then((account) => {
            if (cancelled) return;
            const resolvedName =
              account.user?.display_name || account.user?.username || "";
            if (resolvedName) setDisplayNameState(resolvedName);
          })
          .catch(() => {});
      } catch (err) {
        if (cancelled) return;
        // Drop the cached session — server key rotation or a deleted
        // account lands here and needs a fresh authenticate on next load.
        clearSession();
        const message =
          err instanceof Error ? err.message : "Unable to reach the server.";
        setError(message);
        setStatus("error");
      }
    }

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [client, deviceId]);

  const setDisplayName = useCallback(
    async (name: string) => {
      if (!session) {
        throw new Error("not connected");
      }
      const trimmed = name.trim().slice(0, 24);
      if (!trimmed) {
        throw new Error("display name cannot be empty");
      }
      await client.updateAccount(session, { display_name: trimmed });
      setDisplayNameState(trimmed);
    },
    [client, session],
  );

  const fetchCurrentMatch = useCallback(async (): Promise<GetCurrentMatchResponse> => {
    if (!session) return { active: false };
    const resp = await client.rpc(session, "get_current_match", {});
    const payload = resp.payload;
    if (payload == null) return { active: false };
    if (typeof payload === "string") {
      return JSON.parse(payload) as GetCurrentMatchResponse;
    }
    return payload as GetCurrentMatchResponse;
  }, [client, session]);

  const registerMatchDataHandler = useCallback<
    NakamaContextValue["registerMatchDataHandler"]
  >((handler) => {
    dataHandlers.current.add(handler);
    return () => {
      dataHandlers.current.delete(handler);
    };
  }, []);

  const registerMatchPresenceHandler = useCallback<
    NakamaContextValue["registerMatchPresenceHandler"]
  >((handler) => {
    presenceHandlers.current.add(handler);
    return () => {
      presenceHandlers.current.delete(handler);
    };
  }, []);

  const registerMatchmakerMatchedHandler = useCallback<
    NakamaContextValue["registerMatchmakerMatchedHandler"]
  >((handler) => {
    matchmakerHandlers.current.add(handler);
    return () => {
      matchmakerHandlers.current.delete(handler);
    };
  }, []);

  const value = useMemo<NakamaContextValue>(
    () => ({
      status,
      error,
      isReconnecting,
      reconnectGeneration,
      client,
      session,
      socket,
      deviceId,
      displayName,
      setDisplayName,
      fetchCurrentMatch,
      registerMatchDataHandler,
      registerMatchPresenceHandler,
      registerMatchmakerMatchedHandler,
    }),
    [
      status,
      error,
      isReconnecting,
      reconnectGeneration,
      client,
      session,
      socket,
      deviceId,
      displayName,
      setDisplayName,
      fetchCurrentMatch,
      registerMatchDataHandler,
      registerMatchPresenceHandler,
      registerMatchmakerMatchedHandler,
    ],
  );

  return <NakamaContext.Provider value={value}>{children}</NakamaContext.Provider>;
}

export function useNakama(): NakamaContextValue {
  const ctx = useContext(NakamaContext);
  if (!ctx) {
    throw new Error("useNakama must be used within <NakamaProvider>");
  }
  return ctx;
}
