import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { useNakama } from "@/context/NakamaProvider";
import type {
  ErrorMessage,
  MatchEndedMessage,
  MatchStateMessage,
  MoveMessage,
} from "@/types/match";
import { OpCode } from "@/types/match";

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
  state: MatchStateMessage | null;
  myUserId: string | null;
  myMark: "X" | "O" | null;
  endReason: MatchEndedMessage | null;
  pendingError: ErrorMessage | null;
  joined: boolean;
  makeMove(cell: number): Promise<void>;
  leave(): Promise<void>;
}

const ERROR_CLEAR_MS = 2200;

// joinToken is required for the first attach of a matchmaker-origin match;
// rehydrate reconnects go through without it.
export function useMatch(
  matchId: string | undefined,
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

  // Tracks the most recently joined matchId so cleanup doesn't race
  // a fresh navigation into a different match.
  const joinedMatchIdRef = useRef<string | null>(null);

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

  useEffect(() => {
    if (!socket || !matchId) return;
    let cancelled = false;

    (async () => {
      try {
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
        socket.leaveMatch(joinedMatchIdRef.current).catch(() => {});
        joinedMatchIdRef.current = null;
      }
      setJoined(false);
    };
    // joinToken excluded on purpose — a stale token mid-mount shouldn't re-join.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, matchId]);

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

// WS delivers Uint8Array; long-poll fallback delivers base64. nakama-js's
// type is loose so we handle both paths.
function decodePayload(raw: unknown): unknown {
  if (raw == null) return null;
  try {
    if (raw instanceof Uint8Array) {
      return JSON.parse(new TextDecoder().decode(raw));
    }
    if (typeof raw === "string") {
      try {
        return JSON.parse(atob(raw));
      } catch {
        return JSON.parse(raw);
      }
    }
    return raw;
  } catch {
    return null;
  }
}
