/*
 * Wire protocol shared with the Go server. Keep these types in lockstep with
 * server/go-module/state.go — both sides reference the same opcodes, status
 * values, and JSON field names. A drift here will produce silent no-ops, not
 * loud failures, so changes should come in matched pairs of commits.
 */

// ---- Opcodes ----------------------------------------------------------------

export const OpCode = {
  /** Client → server: place a mark. Payload: { cell: 0..8 } */
  Move: 1,
  /** Server → client: authoritative state snapshot. Payload: MatchStateMessage */
  StateUpdate: 2,
  /** Server → client: terminal notification. Payload: MatchEndedMessage */
  MatchEnded: 3,
  /** Client → server: rematch request (future milestone). Payload: {} */
  Rematch: 4,
  /** Server → offending client only: validation error. Payload: ErrorMessage */
  Error: 5,
} as const;
export type OpCode = (typeof OpCode)[keyof typeof OpCode];

// ---- Enumerations -----------------------------------------------------------

export type Mark = "X" | "O";

export type MatchStatus = "waiting" | "playing" | "finished";

export type GameMode = "classic" | "timed";

export type WinReason =
  | "line"
  | "draw"
  | "timeout"
  | "forfeit"
  | "abandoned";

// ---- Messages ---------------------------------------------------------------

export interface MoveMessage {
  cell: number;
}

/**
 * MatchStateMessage is the authoritative snapshot broadcast by the server on
 * every change. The client renders directly from this and never computes
 * any game-ending condition locally.
 */
export interface MatchStateMessage {
  matchId: string;
  mode: GameMode;
  board: [string, string, string, string, string, string, string, string, string];
  turnMark?: Mark | "";
  markByUserId: Record<string, Mark>;
  userIdByMark: Record<Mark | string, string>;
  usernames: Record<string, string>;
  movesCount: number;
  status: MatchStatus;
  winner?: string;
  winReason?: WinReason;
  winningLine?: number[];
  turnDeadlineMs?: number;
  serverTimeMs: number;
}

export interface MatchEndedMessage {
  reason: WinReason;
  winner?: string;
  winningLine?: number[];
}

export interface ErrorMessage {
  code: string;
  message: string;
}

// ---- Private-room RPC payloads ---------------------------------------------

export interface CreatePrivateMatchRequest {
  mode: GameMode;
}

export interface CreatePrivateMatchResponse {
  matchId: string;
  code: string;
  mode: GameMode;
}

export interface JoinPrivateMatchRequest {
  code: string;
}

export interface JoinPrivateMatchResponse {
  matchId: string;
  mode: GameMode;
}
