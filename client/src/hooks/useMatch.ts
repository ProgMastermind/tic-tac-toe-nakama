import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { useNakama } from "@/context/NakamaProvider";
import type {
  ErrorMessage,
  MatchEndedMessage,
  MatchStateMessage,
  MoveMessage,
} from "@/types/match";
import { OpCode } from "@/types/match";

/*
 * useMatch owns the client-side match lifecycle for a given match id:
 *
 *   1. joinMatch on mount, leaveMatch on unmount.
 *   2. Subscribe to opcode-1..5 messages via the NakamaProvider multiplex,
 *      route them through a reducer that never derives game-ending logic
 *      — the server is the only source of truth for that.
 *   3. Expose an imperative `makeMove(cell)` that sends OpMove over the
 *      socket, and a `pendingError` field for transient per-user errors
 *      (server echoes these on OpError and we surface them briefly).
 */

interface MatchHookState {
  state: MatchStateMessage | null;
  endReason: MatchEndedMessage | null;
  pendingError: ErrorMessage | null;
}

type Action =
  | { type: "state"; payload: MatchStateMessage }
  | { type: "ended"; payload: MatchEndedMessage }
  | { type: "error"; payload: ErrorMessage }
  | { type: "clearError" };

function reducer(prev: MatchHookState, action: Action): MatchHookState {
  switch (action.type) {
    case "state":
      return { ...prev, state: action.payload };
    case "ended":
      return { ...prev, endReason: action.payload };
    case "error":
      return { ...prev, pendingError: action.payload };
    case "clearError":
      return { ...prev, pendingError: null };
    default:
      return prev;
  }
}

export interface UseMatchResult {
  /** Latest authoritative state from the server, or null before first STATE_UPDATE. */
  state: MatchStateMessage | null;
  /** Caller's own user id, convenient for deriving "am I X or O" without extra wiring. */
  myUserId: string | null;
  /** The mark assigned to the caller, once both players have joined. */
  myMark: "X" | "O" | null;
  /** Terminal broadcast, populated on MATCH_ENDED. */
  endReason: MatchEndedMessage | null;
  /** The most recent per-user error from the server (invalid move, etc.). Auto-clears after ~2s. */
  pendingError: ErrorMessage | null;
  /** True once joinMatch has resolved successfully for the current match id. */
  joined: boolean;
  /** Send OpMove with a cell index. Rejects optimistically on obviously invalid inputs. */
  makeMove(cell: number): Promise<void>;
  /** Leave the match cleanly — used when navigating back to the lobby. */
  leave(): Promise<void>;
}

const ERROR_CLEAR_MS = 2200;

export function useMatch(
  matchId: string | undefined,
  /**
   * Optional matchmaker-issued join token. Required the first time a
   * matchmaker-origin match is attached; ignored on subsequent calls (e.g.
   * a refresh-triggered rehydrate, where the user is already a known
   * presence and Nakama treats the join as a reconnect).
   */
  joinToken?: string,
): UseMatchResult {
  const { socket, session, registerMatchDataHandler } = useNakama();
  const [{ state, endReason, pendingError }, dispatch] = useReducer(reducer, {
    state: null,
    endReason: null,
    pendingError: null,
  });
  const [joined, setJoined] = useState(false);

  const myUserId = session?.user_id ?? null;
  const myMark = (myUserId && state?.markByUserId[myUserId]) || null;

  // Track latest joined matchId so the leave call in cleanup doesn't race
  // a fresh navigation into a different match.
  const joinedMatchIdRef = useRef<string | null>(null);

  // Route inbound match-data messages through the reducer. Registered
  // once per matchId so we don't hold stale closures.
  useEffect(() => {
    if (!matchId) return;
    const unsubscribe = registerMatchDataHandler((md) => {
      if (md.match_id !== matchId) return;
      const payload = decodePayload(md.data);
      switch (md.op_code) {
        case OpCode.StateUpdate:
          if (payload) dispatch({ type: "state", payload: payload as MatchStateMessage });
          break;
        case OpCode.MatchEnded:
          if (payload) dispatch({ type: "ended", payload: payload as MatchEndedMessage });
          break;
        case OpCode.Error:
          if (payload) dispatch({ type: "error", payload: payload as ErrorMessage });
          break;
        default:
          break;
      }
    });
    return unsubscribe;
  }, [matchId, registerMatchDataHandler]);

  // Join/leave lifecycle.
  useEffect(() => {
    if (!socket || !matchId) return;
    let cancelled = false;

    (async () => {
      try {
        // The nakama-js typings accept (id, token?, metadata?). Passing
        // undefined as token is safe and is the normal path for private
        // rooms and rehydrate reconnects.
        await socket.joinMatch(matchId, joinToken);
        if (cancelled) return;
        joinedMatchIdRef.current = matchId;
        setJoined(true);
      } catch (err) {
        if (cancelled) return;
        const message =
          err instanceof Error ? err.message : "Couldn't join that match.";
        dispatch({
          type: "error",
          payload: { code: "join_failed", message },
        });
      }
    })();

    return () => {
      cancelled = true;
      if (joinedMatchIdRef.current && socket) {
        // Fire-and-forget — the server cleans up presence on disconnect
        // anyway, but being explicit is nicer for debugging.
        socket.leaveMatch(joinedMatchIdRef.current).catch(() => {});
        joinedMatchIdRef.current = null;
      }
      setJoined(false);
    };
    // joinToken intentionally excluded: changing it mid-mount should not
    // re-trigger a join, and for a fresh matchId the caller passes a
    // fresh token naturally.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, matchId]);

  // Auto-clear transient per-user errors so they don't stick around.
  useEffect(() => {
    if (!pendingError) return;
    const t = setTimeout(() => dispatch({ type: "clearError" }), ERROR_CLEAR_MS);
    return () => clearTimeout(t);
  }, [pendingError]);

  const makeMove = useCallback(
    async (cell: number) => {
      if (!socket || !matchId) throw new Error("not connected");
      if (cell < 0 || cell > 8 || !Number.isInteger(cell)) {
        throw new Error("invalid cell");
      }
      const body: MoveMessage = { cell };
      await socket.sendMatchState(
        matchId,
        OpCode.Move,
        JSON.stringify(body),
      );
    },
    [socket, matchId],
  );

  const leave = useCallback(async () => {
    if (!socket || !joinedMatchIdRef.current) return;
    await socket.leaveMatch(joinedMatchIdRef.current);
    joinedMatchIdRef.current = null;
    setJoined(false);
  }, [socket]);

  return {
    state,
    myUserId,
    myMark,
    endReason,
    pendingError,
    joined,
    makeMove,
    leave,
  };
}

/**
 * Match data messages carry a Uint8Array on WebSocket and a base64 string
 * on the older long-poll fallback. nakama-js normalises to one of these
 * but the TS type is loose, so we defensively handle both.
 */
function decodePayload(raw: unknown): unknown {
  if (raw == null) return null;
  try {
    if (raw instanceof Uint8Array) {
      return JSON.parse(new TextDecoder().decode(raw));
    }
    if (typeof raw === "string") {
      // Some transports deliver base64; probe by decoding with atob and
      // parsing, fall back to treating raw as direct JSON.
      try {
        return JSON.parse(atob(raw));
      } catch {
        return JSON.parse(raw);
      }
    }
    // Already an object.
    return raw;
  } catch {
    return null;
  }
}
