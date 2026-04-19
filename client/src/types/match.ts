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

// ---- Active-match rehydrate RPC --------------------------------------------

/**
 * Response from `get_current_match`. `active: false` means the caller is
 * not in a tracked match (the common boot-time case). When `active: true`,
 * the remaining fields identify where to rehydrate.
 */
export interface GetCurrentMatchResponse {
  active: boolean;
  matchId?: string;
  mark?: Mark;
  mode?: GameMode;
}

// ---- Stats + leaderboard ----------------------------------------------------

/**
 * Per-user match summary written by the server on every finished match.
 * Mirrors the Go StatsSummary. A first-time player reads a zero-valued
 * row rather than a 404, so the client never branches on existence.
 */
export interface StatsSummary {
  wins: number;
  losses: number;
  draws: number;
  currentStreak: number;
  bestStreak: number;
  classicWins: number;
  timedWins: number;
}

/**
 * One row of the top-10 leaderboard view, combining the authoritative
 * leaderboard record with the public stats row for the owner. Streak and
 * per-mode splits come from stats; rank and score come from the record.
 */
export interface LeaderboardEntry {
  ownerId: string;
  username: string;
  rank: number;
  wins: number;
  stats: StatsSummary | null;
}
