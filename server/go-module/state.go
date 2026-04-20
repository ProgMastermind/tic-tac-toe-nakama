package main

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/heroiclabs/nakama-common/runtime"
)

// Opcodes are public wire protocol — don't renumber.
const (
	OpMove        int64 = 1
	OpStateUpdate int64 = 2
	OpMatchEnded  int64 = 3
	OpRematch     int64 = 4 // placeholder; not yet handled
	OpError       int64 = 5
)

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

const TurnSeconds = 30

// 120s allows the real private-room flow (creator copies code → shares → friend
// opens app → types code → joins). Orphan waiting matches are cheap.
const JoinDeadlineSeconds = 120

const DisconnectGraceSeconds = 20

// 20Hz → ~50ms worst-case move latency, below the human "instant" threshold.
const TickRate = 20

// Seconds-based so a future TickRate change doesn't silently retune the timeout.
const EmptyMatchSeconds = 30
const EmptyMatchTicks = EmptyMatchSeconds * TickRate

// Authoritative server state for one match. Nakama threads it through every
// handler callback as an opaque interface{}, so field names must stay stable.
type MatchState struct {
	MatchID string
	Mode    string

	// Private-room share code, round-tripped through the label for MatchList lookup.
	Code string

	// Creator userId — surfaced on the label so join_private_match can
	// reject self-join from two tabs sharing a device id.
	Creator string

	Board [9]string

	// Both directions kept in sync — the handler reads both frequently.
	MarkByUserID map[string]string
	UserIDByMark map[string]string

	// Snapshotted at join time so leaderboard writes don't need another account fetch.
	Usernames map[string]string

	TurnMark   string
	MovesCount int
	Status     string

	Winner      string
	WinReason   string
	WinningLine []int

	// Keyed by userId (not sessionId) so reconnects replace rather than duplicate.
	Presences map[string]runtime.Presence

	// Populated for matchmaker matches, empty for private rooms.
	ExpectedUsers []string

	JoinDeadlineMs int64
	TurnDeadlineMs int64
	DisconnectAtMs map[string]int64

	// Guards against double-writing stats: MatchLoop writes on finish,
	// MatchTerminate is a fallback for crash paths.
	StatsWritten bool

	EmptyTicks int
}

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

// Used by MatchList (`+label.code:ABCD`) and visible in the Nakama console.
type MatchLabel struct {
	Mode    string `json:"mode"`
	Code    string `json:"code,omitempty"`
	Creator string `json:"creator,omitempty"`
	Open    bool   `json:"open"`
}

func (l MatchLabel) Encode() (string, error) {
	b, err := json.Marshal(l)
	if err != nil {
		return "", fmt.Errorf("marshal match label: %w", err)
	}
	return string(b), nil
}

// Client-facing projection broadcast on OpStateUpdate. Server-only bookkeeping
// (disconnect timers, expected users) is deliberately excluded.
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
	TurnDeadline int64             `json:"turnDeadlineMs,omitempty"`
	ServerTimeMs int64             `json:"serverTimeMs"`
}

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

type MoveMessage struct {
	Cell int `json:"cell"`
}

type MatchEndedMessage struct {
	Reason      string `json:"reason"`
	Winner      string `json:"winner,omitempty"`
	WinningLine []int  `json:"winningLine,omitempty"`
}

type ErrorMessage struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Sentinels — the handler maps these to OpError codes via validationCode().
var (
	ErrNotPlaying    = errors.New("match is not currently playing")
	ErrNotYourTurn   = errors.New("it is not your turn")
	ErrCellOutRange  = errors.New("cell index out of range")
	ErrCellOccupied  = errors.New("cell is already occupied")
	ErrUnknownPlayer = errors.New("sender is not a player in this match")
	ErrBadPayload    = errors.New("malformed move payload")
)

// Pure — does NOT mutate state. Callers call ApplyMove separately on success.
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

// Mutates state. Caller is responsible for resetting TurnDeadlineMs after.
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
		s.Winner = ""
		return true, WinReasonDraw
	}
	if s.TurnMark == MarkX {
		s.TurnMark = MarkO
	} else {
		s.TurnMark = MarkX
	}
	return false, ""
}

// Package-level so CheckWinner doesn't re-allocate per call.
var winLines = [8][3]int{
	{0, 1, 2}, {3, 4, 5}, {6, 7, 8},
	{0, 3, 6}, {1, 4, 7}, {2, 5, 8},
	{0, 4, 8}, {2, 4, 6},
}

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
