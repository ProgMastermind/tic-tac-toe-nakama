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
import type { GetCurrentMatchResponse } from "@/types/match";

/*
 * NakamaProvider wires the Nakama client, session, and socket into a single
 * React context. Every consumer receives the same singletons and an
 * explicit `status` field that drives top-level UI state (splash, error
 * banner, ready).
 *
 * Design decisions:
 *
 * - The client is created once, synchronously, from env vars. A failure to
 *   read env vars throws immediately so we never show a blank mounted app
 *   with a cryptic network error later.
 * - authenticateDevice + createSocket + socket.connect run in one effect,
 *   serially. If either step fails we surface the error and let the user
 *   retry rather than silently retrying in the background.
 * - After the initial connect, a disconnect does NOT flip the user into
 *   the full-screen error state. Instead we flip `isReconnecting` and
 *   run an exponential-backoff loop (1s, 2s, 4s, … capped at 30s) until
 *   the socket re-attaches, then bump `reconnectGeneration` so consumers
 *   (rehydrate, reconnect-aware views) can react.
 * - Socket-level handlers (onmatchdata, onmatchpresence, onmatchmakermatched)
 *   are attached through a single `wireSocket` helper so the same handler
 *   registries are multiplexed whether we are on the first socket or a
 *   reconnected one.
 */

export type NakamaStatus = "connecting" | "ready" | "error";

export interface NakamaContextValue {
  /** Connection lifecycle state. "ready" is the only state where session
   *  and socket are non-null and usable. Once ready we stay ready even
   *  across socket drops — `isReconnecting` signals a transient outage. */
  status: NakamaStatus;
  /** Human-readable error string when status is "error". */
  error: string | null;
  /** True while the socket is detached and the backoff loop is retrying. */
  isReconnecting: boolean;
  /** Bumped on every successful (re)connect. Consumers that need to
   *  re-run an action after reconnect (rehydrate, refresh-list) should
   *  key on this value. */
  reconnectGeneration: number;
  /** The shared HTTP client. Safe to reference even while connecting. */
  client: Client;
  /** Authenticated session — null until status becomes "ready". */
  session: Session | null;
  /** Live WebSocket — null until status becomes "ready". */
  socket: Socket | null;
  /** User's stable device id. Exposed for debug affordances. */
  deviceId: string;
  /** The display name Nakama holds for the current account. */
  displayName: string;
  /** Update the display name on the account and refresh local state. */
  setDisplayName(name: string): Promise<void>;
  /** Call the `get_current_match` RPC and return the parsed payload. */
  fetchCurrentMatch(): Promise<GetCurrentMatchResponse>;
  /**
   * Register a function to receive every inbound match-data message.
   * Returns an unregister function. Prefer this to poking `socket.onmatchdata`
   * directly because the provider multiplexes a single assignment.
   */
  registerMatchDataHandler(
    handler: (md: Parameters<NonNullable<Socket["onmatchdata"]>>[0]) => void,
  ): () => void;
  /**
   * Same multiplexing contract for presence events (joins and leaves on
   * active matches the user is part of).
   */
  registerMatchPresenceHandler(
    handler: (e: Parameters<NonNullable<Socket["onmatchpresence"]>>[0]) => void,
  ): () => void;
  /**
   * Same multiplexing contract for matchmaker_matched notifications. Fired
   * when the Nakama matchmaker pairs the caller with an opponent — the
   * payload carries the authoritative match id and a short-lived join
   * token. Only one consumer tends to listen at a time (the lobby) but
   * multiplexing keeps the API shape consistent.
   */
  registerMatchmakerMatchedHandler(
    handler: (m: Parameters<NonNullable<Socket["onmatchmakermatched"]>>[0]) => void,
  ): () => void;
}

const NakamaContext = createContext<NakamaContextValue | null>(null);

const RECONNECT_INITIAL_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30_000;

export function NakamaProvider({ children }: { children: ReactNode }) {
  // ---- Client is created synchronously from env vars. -----------------
  const clientRef = useRef<Client | null>(null);
  if (clientRef.current === null) {
    clientRef.current = createClient(readConnectionConfig());
  }
  const client = clientRef.current;

  const [status, setStatus] = useState<NakamaStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [displayName, setDisplayNameState] = useState<string>("");
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [reconnectGeneration, setReconnectGeneration] = useState(0);

  // Device identity is resolved once and never mutates for the lifetime
  // of the app. Stable across reloads via localStorage.
  const deviceId = useRef<string>(ensureDeviceId()).current;

  // Handler registries. We keep Sets so a page can register and
  // unregister its handler without stepping on any other subscriber.
  const dataHandlers = useRef(
    new Set<(md: Parameters<NonNullable<Socket["onmatchdata"]>>[0]) => void>(),
  );
  const presenceHandlers = useRef(
    new Set<(e: Parameters<NonNullable<Socket["onmatchpresence"]>>[0]) => void>(),
  );
  const matchmakerHandlers = useRef(
    new Set<(m: Parameters<NonNullable<Socket["onmatchmakermatched"]>>[0]) => void>(),
  );

  // ---- Initial connect + reconnect loop. Effect runs once on mount. ---
  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    // Guards against concurrent reconnect loops when a stale socket's
    // ondisconnect fires while we are already retrying.
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
      // Fresh "socket is gone" signal — flip the banner flag and start
      // the backoff loop. The loop itself guards against duplicate entry.
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
          const nextSocket = client.createSocket(useSSL, /*verbose*/ false);
          nextSocket.ondisconnect = () => handleDisconnect(sess);
          wireSocket(nextSocket);
          await nextSocket.connect(sess, /*appearOnline*/ true);
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
        const next = await client.authenticateDevice(
          deviceId,
          true,
          guestUsernameFor(deviceId),
        );
        if (cancelled) return;

        const account = await client.getAccount(next);
        if (cancelled) return;
        const resolvedName = account.user?.display_name || account.user?.username || "";

        const liveSocket = client.createSocket(useSSL, /*verbose*/ false);
        liveSocket.ondisconnect = () => handleDisconnect(next);
        wireSocket(liveSocket);

        await liveSocket.connect(next, /*appearOnline*/ true);
        if (cancelled) {
          liveSocket.disconnect(false);
          return;
        }

        setSession(next);
        setSocket(liveSocket);
        setDisplayNameState(resolvedName);
        setStatus("ready");
        setError(null);
        setIsReconnecting(false);
        // First successful connect counts as generation 1 so a rehydrate
        // consumer keyed on reconnectGeneration runs once at boot too.
        setReconnectGeneration((g) => g + 1);
      } catch (err) {
        if (cancelled) return;
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

  // ---- Exposed mutators. ----------------------------------------------
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

/**
 * useNakama is the canonical way to reach the provider. Throws if consumed
 * outside NakamaProvider — the error identifies the wiring mistake rather
 * than deferring to a silent undefined-read later.
 */
export function useNakama(): NakamaContextValue {
  const ctx = useContext(NakamaContext);
  if (!ctx) {
    throw new Error("useNakama must be used within <NakamaProvider>");
  }
  return ctx;
}
