package main

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/heroiclabs/nakama-common/runtime"
)

// -----------------------------------------------------------------------------
// Wire protocol.
//
// Opcodes travel in the `op_code` field of every match data message. Keep the
// numeric values stable — they are public protocol between client and server.
// -----------------------------------------------------------------------------

const (
	// OpMove is sent by a client to place their mark in a cell. Payload is
	// JSON: {"cell": 0-8}. Server validates and either applies it and
	// broadcasts a state update, or echoes an error only to the sender.
	OpMove int64 = 1

	// OpStateUpdate is the server's authoritative snapshot of the match as
	// it is visible to both players. Clients render directly from it and do
	// not derive any game-ending conditions locally.
	OpStateUpdate int64 = 2

	// OpMatchEnded is broadcast once the match reaches a terminal state.
	// The payload carries the finish reason and the winner (if any) so
	// clients can drive post-match UI without re-deriving it from state.
	OpMatchEnded int64 = 3

	// OpRematch is a client request for a rematch. Placeholder for a later
	// milestone — handler does not yet act on it.
	OpRematch int64 = 4

	// OpError is sent to a single offending client when its message fails
	// validation. It is never broadcast to both players because a peer
	// should not be able to observe the other player's mis-inputs.
	OpError int64 = 5
)

// -----------------------------------------------------------------------------
// Enumerations. Use typed strings rather than magic literals everywhere in
// the handler so a typo fails at compile time.
// -----------------------------------------------------------------------------

const (
	StatusWaiting  = "waiting"
	StatusPlaying  = "playing"
	StatusFinished = "finished"

	ModeClassic = "classic"
	ModeTimed   = "timed"

	MarkX = "X"
	MarkO = "O"

	WinReasonLine      = "line"
	WinReasonDraw      = "draw"
	WinReasonTimeout   = "timeout"
	WinReasonForfeit   = "forfeit"
	WinReasonAbandoned = "abandoned"
)

// TurnSeconds is the per-turn time limit enforced in timed mode. A fixed
// constant keeps the contract obvious; if we ever expose this as a knob it
// should become a field on MatchState populated from match create params.
const TurnSeconds = 30

// JoinDeadlineSeconds is how long a match waits in the waiting state for
// both players to actually attach. Sized for the real human-in-the-loop
// flow of a private room: creator opens room → copies 4-char code →
// pastes it into a chat/email/whatever → friend reads, opens the app,
// types the code, clicks Join. 15s was fine for automated testing; 120s
// is right for real sharing. An orphaned waiting match is cheap in
// memory, so the generous window costs nothing.
//
// For the matchmaker flow in M2 the effective wait will be much shorter
// anyway — matched clients attach immediately on notification.
const JoinDeadlineSeconds = 120

// DisconnectGraceSeconds is the window a dropped player has to reconnect
// before the match is forfeited in their opponent's favour.
const DisconnectGraceSeconds = 20

// TickRate is how many times per second MatchLoop runs. 20Hz gives ~50ms
// worst-case latency on move propagation (messages queue between ticks),
// which is below the human "instant" threshold. Our loop does O(1) work
// per tick so the CPU cost is negligible at any realistic match count.
const TickRate = 20

// EmptyMatchSeconds is the wall-clock window a finished match stays alive
// with zero attached presences before Nakama tears it down. Expressed in
// seconds so a future TickRate change doesn't silently retune the timeout.
const EmptyMatchSeconds = 30

// EmptyMatchTicks is EmptyMatchSeconds translated into MatchLoop iterations.
const EmptyMatchTicks = EmptyMatchSeconds * TickRate

// -----------------------------------------------------------------------------
// Match state. This is the authoritative server-side representation. Only a
// projection of it (see PublicState) is broadcast to clients.
// -----------------------------------------------------------------------------

// MatchState is held in memory by the Nakama runtime for the lifetime of a
// single match and passed to every handler callback. Field names are stable
// because Nakama treats the state as an opaque interface{} and we round-trip
// it through type assertions.
type MatchState struct {
	// MatchID is populated in MatchInit from the context so handlers can
	// reference the match in storage writes and logs without threading it
	// through every call.
	MatchID string

	Mode string // ModeClassic | ModeTimed

	// Code is the private-room share code, if this match was opened via
	// create_private_match. Empty for matches created by the matchmaker
	// hook. Round-tripped through the match label so MatchList lookups by
	// code work end-to-end.
	Code string

	// Creator is the userId who opened a private room, surfaced on the
	// label so the join RPC can reject a caller trying to join their own
	// room (symptom of two browser tabs sharing a localStorage device id).
	Creator string

	// Board is row-major — indices 0..2 top, 3..5 middle, 6..8 bottom.
	Board [9]string

	// Mark bookkeeping. Two maps rather than one indirection; the handler
	// reads both directions frequently and the cost of keeping them in
	// sync is local to MatchJoin.
	MarkByUserID map[string]string // userId -> "X"|"O"
	UserIDByMark map[string]string // "X"|"O" -> userId

	// Usernames snapshotted at join time — convenient for leaderboard writes
	// in MatchTerminate without having to pull the account again.
	Usernames map[string]string // userId -> username

	TurnMark   string // "X" | "O"
	MovesCount int
	Status     string // StatusWaiting | StatusPlaying | StatusFinished

	Winner      string // winning userId, empty on draw/abandoned
	WinReason   string // WinReason*
	WinningLine []int  // board indices forming the winning line, or nil

	// Presences is keyed by userId so reconnects replace rather than
	// duplicate. SessionId reuse on reconnect is not guaranteed.
	Presences map[string]runtime.Presence

	// ExpectedUsers is the list of userIds the matchmaker paired — used by
	// MatchJoinAttempt to accept only the intended players into public
	// matches. Empty for private (code-based) rooms.
	ExpectedUsers []string

	JoinDeadlineMs int64            // set in MatchInit, checked in MatchLoop
	TurnDeadlineMs int64            // ModeTimed only
	DisconnectAtMs map[string]int64 // userId -> unix ms of last observed leave

	// StatsWritten guards against double-counting a match into the
	// leaderboard. MatchLoop writes on transition to finished; MatchTerminate
	// writes only if this is still false (covers crash paths).
	StatsWritten bool

	// EmptyTicks counts consecutive ticks where no presences are attached.
	EmptyTicks int
}

// NewMatchState returns a fully-initialised state with all maps allocated.
// Using a constructor keeps MatchInit short and ensures every field has a
// zero value that is safe to dereference.
func NewMatchState(matchID, mode string, expectedUsers []string) *MatchState {
	return &MatchState{
		MatchID:        matchID,
		Mode:           mode,
		Board:          [9]string{},
		MarkByUserID:   make(map[string]string, 2),
		UserIDByMark:   make(map[string]string, 2),
		Usernames:      make(map[string]string, 2),
		TurnMark:       "",
		Status:         StatusWaiting,
		Presences:      make(map[string]runtime.Presence, 2),
		ExpectedUsers:  append([]string(nil), expectedUsers...),
		DisconnectAtMs: make(map[string]int64, 2),
	}
}

// -----------------------------------------------------------------------------
// Match label. Used by MatchList queries (for private room code lookup) and
// as a discovery hint in the Nakama developer console.
// -----------------------------------------------------------------------------

// MatchLabel is written as the match's label JSON. Field names are camelCase
// so Nakama's label query language (`+label.code:ABCD`) reads naturally on
// the client.
type MatchLabel struct {
	Mode string `json:"mode"`
	Code string `json:"code,omitempty"` // 4-char private room code, empty for public matches
	// Creator userId of the player who opened the room. Exposed in the
	// label so the join RPC can refuse a caller trying to join their own
	// room (typically caused by two tabs sharing a localStorage device id).
	Creator string `json:"creator,omitempty"`
	Open    bool   `json:"open"` // false once two players have joined
}

// Encode marshals the label for MatchDispatcher.MatchLabelUpdate. A non-nil
// error is only ever from a programmer mistake (map-typed state, etc.) so we
// return it rather than swallowing it.
func (l MatchLabel) Encode() (string, error) {
	b, err := json.Marshal(l)
	if err != nil {
		return "", fmt.Errorf("marshal match label: %w", err)
	}
	return string(b), nil
}

// -----------------------------------------------------------------------------
// Public state. This is the client-facing projection broadcast on OpStateUpdate.
// Anything that would leak server-only bookkeeping (e.g. disconnect timers)
// stays out of it.
// -----------------------------------------------------------------------------

// PublicState mirrors the fields the UI needs and no others. The omitempty
// tags keep the wire payload small — 90% of ticks during a game send a 200
// byte message.
type PublicState struct {
	MatchID      string            `json:"matchId"`
	Mode         string            `json:"mode"`
	Board        [9]string         `json:"board"`
	TurnMark     string            `json:"turnMark,omitempty"`
	MarkByUserID map[string]string `json:"markByUserId"`
	UserIDByMark map[string]string `json:"userIdByMark"`
	Usernames    map[string]string `json:"usernames"`
	MovesCount   int               `json:"movesCount"`
	Status       string            `json:"status"`
	Winner       string            `json:"winner,omitempty"`
	WinReason    string            `json:"winReason,omitempty"`
	WinningLine  []int             `json:"winningLine,omitempty"`
	TurnDeadline int64             `json:"turnDeadlineMs,omitempty"` // unix ms, timed mode only
	ServerTimeMs int64             `json:"serverTimeMs"`             // used by client to align its clock
}

// Project copies the broadcast-safe subset of the match state. Called once
// per state change so allocations are deliberately kept shallow.
func (s *MatchState) Project(serverTimeMs int64) PublicState {
	return PublicState{
		MatchID:      s.MatchID,
		Mode:         s.Mode,
		Board:        s.Board,
		TurnMark:     s.TurnMark,
		MarkByUserID: s.MarkByUserID,
		UserIDByMark: s.UserIDByMark,
		Usernames:    s.Usernames,
		MovesCount:   s.MovesCount,
		Status:       s.Status,
		Winner:       s.Winner,
		WinReason:    s.WinReason,
		WinningLine:  s.WinningLine,
		TurnDeadline: s.TurnDeadlineMs,
		ServerTimeMs: serverTimeMs,
	}
}

// -----------------------------------------------------------------------------
// Move decoding and validation. Pure functions so they are trivially testable.
// -----------------------------------------------------------------------------

// MoveMessage is the JSON payload clients send on OpMove.
type MoveMessage struct {
	Cell int `json:"cell"`
}

// MatchEndedMessage is the payload broadcast on OpMatchEnded.
type MatchEndedMessage struct {
	Reason      string `json:"reason"`
	Winner      string `json:"winner,omitempty"`
	WinningLine []int  `json:"winningLine,omitempty"`
}

// ErrorMessage is the payload sent to a single client on OpError.
type ErrorMessage struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Sentinel errors for move validation. The handler inspects them to decide
// which OpError code to send back to the client.
var (
	ErrNotPlaying    = errors.New("match is not currently playing")
	ErrNotYourTurn   = errors.New("it is not your turn")
	ErrCellOutRange  = errors.New("cell index out of range")
	ErrCellOccupied  = errors.New("cell is already occupied")
	ErrUnknownPlayer = errors.New("sender is not a player in this match")
	ErrBadPayload    = errors.New("malformed move payload")
)

// ValidateMove checks that the sender may legally play the supplied cell.
// It does NOT mutate state — callers that pass validation should separately
// call ApplyMove. Splitting these steps keeps the validation easy to reason
// about and test in isolation.
func ValidateMove(s *MatchState, senderUserID string, cell int) error {
	if s.Status != StatusPlaying {
		return ErrNotPlaying
	}
	mark, ok := s.MarkByUserID[senderUserID]
	if !ok {
		return ErrUnknownPlayer
	}
	if mark != s.TurnMark {
		return ErrNotYourTurn
	}
	if cell < 0 || cell >= 9 {
		return ErrCellOutRange
	}
	if s.Board[cell] != "" {
		return ErrCellOccupied
	}
	return nil
}

// ApplyMove mutates state in place after a successful ValidateMove. It sets
// the cell, increments the move count, evaluates end conditions, and either
// flips the turn or transitions to finished.
//
// Returns (finished, winReason). finished is true when the match reaches a
// terminal state as a result of this move, in which case s.Winner and
// s.WinningLine are populated.
func ApplyMove(s *MatchState, cell int) (finished bool, winReason string) {
	s.Board[cell] = s.TurnMark
	s.MovesCount++

	if mark, line, won := CheckWinner(s.Board); won {
		s.Status = StatusFinished
		s.WinReason = WinReasonLine
		s.Winner = s.UserIDByMark[mark]
		s.WinningLine = line
		return true, WinReasonLine
	}
	if s.MovesCount == 9 {
		s.Status = StatusFinished
		s.WinReason = WinReasonDraw
		s.Winner = "" // draw
		return true, WinReasonDraw
	}
	// Flip turn. No timer reset here — the handler owns that so it can
	// use the same timestamp it's using for the state update broadcast.
	if s.TurnMark == MarkX {
		s.TurnMark = MarkO
	} else {
		s.TurnMark = MarkX
	}
	return false, ""
}

// winLines enumerates the 8 possible three-in-a-row positions on the board.
// Package-level so CheckWinner does not re-allocate per call.
var winLines = [8][3]int{
	{0, 1, 2}, {3, 4, 5}, {6, 7, 8}, // rows
	{0, 3, 6}, {1, 4, 7}, {2, 5, 8}, // columns
	{0, 4, 8}, {2, 4, 6}, // diagonals
}

// CheckWinner scans for three identical non-empty marks on any line. Returns
// the winning mark, the three board indices that form the line (for UI
// highlighting), and true on a win. Otherwise returns ("", nil, false).
func CheckWinner(board [9]string) (mark string, line []int, ok bool) {
	for _, l := range winLines {
		a := board[l[0]]
		if a == "" {
			continue
		}
		if a == board[l[1]] && a == board[l[2]] {
			return a, []int{l[0], l[1], l[2]}, true
		}
	}
	return "", nil, false
}
