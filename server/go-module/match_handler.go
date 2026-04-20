package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/heroiclabs/nakama-common/runtime"
)

// Match holds no per-match data — state lives on *MatchState which Nakama
// threads through every callback — so one *Match serves many concurrent matches.
type Match struct{}

func NewMatch(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule) (runtime.Match, error) {
	return &Match{}, nil
}

func (m *Match) MatchInit(
	ctx context.Context,
	logger runtime.Logger,
	db *sql.DB,
	nk runtime.NakamaModule,
	params map[string]interface{},
) (interface{}, int, string) {
	matchID, _ := ctx.Value(runtime.RUNTIME_CTX_MATCH_ID).(string)

	mode, ok := params["mode"].(string)
	if !ok || (mode != ModeClassic && mode != ModeTimed) {
		logger.Error("MatchInit refused: missing or invalid mode param (match=%s)", matchID)
		return nil, 0, ""
	}

	code, _ := params["code"].(string)
	creator, _ := params["creator"].(string)

	expectedUsers := readStringSlice(params, "expected_users")

	state := NewMatchState(matchID, mode, expectedUsers)
	state.Code = code
	state.Creator = creator
	state.JoinDeadlineMs = time.Now().UnixMilli() + int64(JoinDeadlineSeconds*1000)

	if state.Creator == "" && len(expectedUsers) > 0 {
		state.Creator = expectedUsers[0]
	}

	labelJSON, err := (MatchLabel{Mode: mode, Code: code, Creator: state.Creator, Open: true}).Encode()
	if err != nil {
		logger.Error("MatchInit label encode failed (match=%s): %v", matchID, err)
		labelJSON = ""
	}

	logger.Info("MatchInit match=%s mode=%s code=%q expected=%v",
		matchID, mode, code, expectedUsers)

	return state, TickRate, labelJSON
}

// nk.MatchCreate passes params through JSON, so []string arrives as []interface{}.
func readStringSlice(params map[string]interface{}, key string) []string {
	v, ok := params[key]
	if !ok || v == nil {
		return nil
	}
	switch xs := v.(type) {
	case []string:
		return append([]string(nil), xs...)
	case []interface{}:
		out := make([]string, 0, len(xs))
		for _, x := range xs {
			if s, ok := x.(string); ok {
				out = append(out, s)
			}
		}
		return out
	default:
		return nil
	}
}

func (m *Match) MatchJoinAttempt(
	ctx context.Context,
	logger runtime.Logger,
	db *sql.DB,
	nk runtime.NakamaModule,
	dispatcher runtime.MatchDispatcher,
	tick int64,
	state interface{},
	presence runtime.Presence,
	metadata map[string]string,
) (interface{}, bool, string) {
	s := state.(*MatchState)
	userID := presence.GetUserId()

	// Reconnecting player — always let them back into their own slot.
	if _, hasMark := s.MarkByUserID[userID]; hasMark {
		return s, true, ""
	}

	// Matchmaker matches carry an ExpectedUsers list; reject anyone else
	// so a stranger can't snipe a paired slot.
	if len(s.ExpectedUsers) > 0 {
		for _, expected := range s.ExpectedUsers {
			if expected == userID {
				return s, true, ""
			}
		}
		logger.Warn("match=%s rejected join from user=%s (not in expected list)",
			s.MatchID, userID)
		return s, false, "not invited to this match"
	}

	if len(s.MarkByUserID) < 2 {
		return s, true, ""
	}
	return s, false, "match is full"
}

func (m *Match) MatchJoin(
	ctx context.Context,
	logger runtime.Logger,
	db *sql.DB,
	nk runtime.NakamaModule,
	dispatcher runtime.MatchDispatcher,
	tick int64,
	state interface{},
	presences []runtime.Presence,
) interface{} {
	s := state.(*MatchState)
	nowMs := time.Now().UnixMilli()

	for _, p := range presences {
		userID := p.GetUserId()
		s.Presences[userID] = p
		delete(s.DisconnectAtMs, userID)

		newPlayer := false
		if _, already := s.MarkByUserID[userID]; !already {
			mark := MarkX
			if _, taken := s.UserIDByMark[MarkX]; taken {
				mark = MarkO
			}
			s.MarkByUserID[userID] = mark
			s.UserIDByMark[mark] = userID
			newPlayer = true
		}

		if _, have := s.Usernames[userID]; !have {
			// Fall back to presence username if the account lookup fails.
			s.Usernames[userID] = p.GetUsername()
			if accounts, err := nk.AccountsGetId(ctx, []string{userID}, nil); err == nil && len(accounts) == 1 {
				if u := accounts[0].GetUser(); u != nil && u.Username != "" {
					s.Usernames[userID] = u.Username
				}
			}
		}

		if newPlayer {
			if err := writeActiveMatch(ctx, nk, userID, s.MatchID, s.MarkByUserID[userID], s.Mode); err != nil {
				// Rehydrate is a convenience, not correctness — don't fail the join.
				logger.Warn("match=%s active_match write user=%s err=%v",
					s.MatchID, userID, err)
			}
		}
	}

	if s.Status == StatusWaiting && len(s.UserIDByMark) == 2 && len(s.Presences) == 2 {
		s.Status = StatusPlaying
		s.TurnMark = MarkX
		if s.Mode == ModeTimed {
			s.TurnDeadlineMs = nowMs + int64(TurnSeconds*1000)
		}
		if err := dispatcher.MatchLabelUpdate(labelFor(logger, s, false)); err != nil {
			logger.Warn("match=%s label update on start failed: %v", s.MatchID, err)
		}
		logger.Info("match=%s started mode=%s X=%s O=%s",
			s.MatchID, s.Mode, s.UserIDByMark[MarkX], s.UserIDByMark[MarkO])
	}

	broadcastState(logger, dispatcher, s, nowMs)
	return s
}

func labelFor(logger runtime.Logger, s *MatchState, open bool) string {
	j, err := (MatchLabel{
		Mode:    s.Mode,
		Code:    s.Code,
		Creator: s.Creator,
		Open:    open,
	}).Encode()
	if err != nil {
		logger.Warn("label encode failed: %v", err)
		return ""
	}
	return j
}

// Presence drop arms a grace window; MatchLoop forfeits if it elapses.
func (m *Match) MatchLeave(
	ctx context.Context,
	logger runtime.Logger,
	db *sql.DB,
	nk runtime.NakamaModule,
	dispatcher runtime.MatchDispatcher,
	tick int64,
	state interface{},
	presences []runtime.Presence,
) interface{} {
	s := state.(*MatchState)
	nowMs := time.Now().UnixMilli()

	for _, p := range presences {
		userID := p.GetUserId()
		delete(s.Presences, userID)
		if _, isPlayer := s.MarkByUserID[userID]; !isPlayer {
			continue
		}
		if s.Status == StatusFinished {
			// Clear the rehydrate pointer eagerly — MatchTerminate's 30-tick
			// grace is too long; a client landing on "/" would bounce back.
			if err := clearActiveMatch(ctx, nk, userID); err != nil {
				logger.Warn("match=%s active_match clear on leave user=%s err=%v",
					s.MatchID, userID, err)
			}
			continue
		}
		s.DisconnectAtMs[userID] = nowMs
		logger.Info("match=%s user=%s left, grace=%ds",
			s.MatchID, userID, DisconnectGraceSeconds)
	}
	return s
}

func (m *Match) MatchLoop(
	ctx context.Context,
	logger runtime.Logger,
	db *sql.DB,
	nk runtime.NakamaModule,
	dispatcher runtime.MatchDispatcher,
	tick int64,
	state interface{},
	messages []runtime.MatchData,
) interface{} {
	s := state.(*MatchState)
	nowMs := time.Now().UnixMilli()
	changed := false

	if s.Status == StatusWaiting && nowMs > s.JoinDeadlineMs {
		s.Status = StatusFinished
		s.WinReason = WinReasonAbandoned
		changed = true
		logger.Info("match=%s abandoned: join deadline expired", s.MatchID)
	}

	if s.Status == StatusPlaying {
		for userID, droppedAt := range s.DisconnectAtMs {
			if _, reconnected := s.Presences[userID]; reconnected {
				delete(s.DisconnectAtMs, userID)
				continue
			}
			if nowMs-droppedAt >= int64(DisconnectGraceSeconds*1000) {
				s.Status = StatusFinished
				s.WinReason = WinReasonForfeit
				s.Winner = opponentOf(s, userID)
				changed = true
				logger.Info("match=%s forfeit by user=%s (disconnect grace expired)",
					s.MatchID, userID)
				break
			}
		}
	}

	for _, msg := range messages {
		if s.Status != StatusPlaying {
			continue
		}
		if msg.GetOpCode() != OpMove {
			sendError(dispatcher, msg, "unknown_op", "unsupported op code")
			continue
		}
		var mv MoveMessage
		if err := json.Unmarshal(msg.GetData(), &mv); err != nil {
			sendError(dispatcher, msg, "bad_payload", ErrBadPayload.Error())
			continue
		}
		if err := ValidateMove(s, msg.GetUserId(), mv.Cell); err != nil {
			sendError(dispatcher, msg, validationCode(err), err.Error())
			continue
		}
		finished, reason := ApplyMove(s, mv.Cell)
		changed = true
		if finished {
			logger.Info("match=%s finished: reason=%s winner=%s",
				s.MatchID, reason, s.Winner)
		} else if s.Mode == ModeTimed {
			s.TurnDeadlineMs = nowMs + int64(TurnSeconds*1000)
		}
	}

	if s.Status == StatusPlaying && s.Mode == ModeTimed && nowMs > s.TurnDeadlineMs {
		losingUser := s.UserIDByMark[s.TurnMark]
		s.Status = StatusFinished
		s.WinReason = WinReasonTimeout
		s.Winner = opponentOf(s, losingUser)
		changed = true
		logger.Info("match=%s timeout: losing=%s winner=%s",
			s.MatchID, losingUser, s.Winner)
	}

	if changed {
		broadcastState(logger, dispatcher, s, nowMs)
		if s.Status == StatusFinished && !s.StatsWritten {
			broadcastEnded(logger, dispatcher, s)
			// Write synchronously so the leaderboard reflects the win
			// before the user navigates to it from the end overlay.
			writeMatchStats(ctx, logger, nk, s)
			s.StatsWritten = true
		}
	}

	if s.Status == StatusFinished {
		if len(s.Presences) == 0 {
			s.EmptyTicks++
		} else {
			s.EmptyTicks = 0
		}
		if s.EmptyTicks >= EmptyMatchTicks {
			logger.Info("match=%s terminating: empty for %d ticks",
				s.MatchID, s.EmptyTicks)
			return nil
		}
	}

	return s
}

func (m *Match) MatchTerminate(
	ctx context.Context,
	logger runtime.Logger,
	db *sql.DB,
	nk runtime.NakamaModule,
	dispatcher runtime.MatchDispatcher,
	tick int64,
	state interface{},
	graceSeconds int,
) interface{} {
	s := state.(*MatchState)
	logger.Info("MatchTerminate match=%s grace=%d status=%s statsWritten=%v",
		s.MatchID, graceSeconds, s.Status, s.StatsWritten)

	// Iterate MarkByUserID (not Presences) so players who dropped mid-match
	// and never returned still get their rehydrate pointer cleared.
	for userID := range s.MarkByUserID {
		if err := clearActiveMatch(ctx, nk, userID); err != nil {
			logger.Warn("match=%s active_match clear user=%s err=%v",
				s.MatchID, userID, err)
		}
	}

	// Safety net if MatchLoop's finish branch didn't run (panic, forced shutdown).
	if !s.StatsWritten && s.Status == StatusFinished {
		writeMatchStats(ctx, logger, nk, s)
		s.StatsWritten = true
	}
	return s
}

// Unused by tic-tac-toe; required to satisfy runtime.Match.
func (m *Match) MatchSignal(
	ctx context.Context,
	logger runtime.Logger,
	db *sql.DB,
	nk runtime.NakamaModule,
	dispatcher runtime.MatchDispatcher,
	tick int64,
	state interface{},
	data string,
) (interface{}, string) {
	return state, ""
}

// Returns "" if userID isn't a player, so callers can record a degenerate end.
func opponentOf(s *MatchState, userID string) string {
	for uid := range s.MarkByUserID {
		if uid != userID {
			return uid
		}
	}
	return ""
}

func broadcastState(logger runtime.Logger, dispatcher runtime.MatchDispatcher, s *MatchState, nowMs int64) {
	payload, err := json.Marshal(s.Project(nowMs))
	if err != nil {
		logger.Error("match=%s broadcast state marshal failed: %v", s.MatchID, err)
		return
	}
	if err := dispatcher.BroadcastMessage(OpStateUpdate, payload, nil, nil, true); err != nil {
		logger.Warn("match=%s broadcast state failed: %v", s.MatchID, err)
	}
}

// Separate from the final OpStateUpdate so clients can drive end-of-match UI
// (confetti, rematch) without re-interpreting a state diff.
func broadcastEnded(logger runtime.Logger, dispatcher runtime.MatchDispatcher, s *MatchState) {
	payload, err := json.Marshal(MatchEndedMessage{
		Reason:      s.WinReason,
		Winner:      s.Winner,
		WinningLine: s.WinningLine,
	})
	if err != nil {
		logger.Error("match=%s broadcast ended marshal failed: %v", s.MatchID, err)
		return
	}
	if err := dispatcher.BroadcastMessage(OpMatchEnded, payload, nil, nil, true); err != nil {
		logger.Warn("match=%s broadcast ended failed: %v", s.MatchID, err)
	}
}

// Reply only to the sender — errors are per-sender diagnostics, never broadcast.
func sendError(dispatcher runtime.MatchDispatcher, msg runtime.MatchData, code, message string) {
	payload, err := json.Marshal(ErrorMessage{Code: code, Message: message})
	if err != nil {
		payload = []byte(fmt.Sprintf(`{"code":%q,"message":%q}`, code, message))
	}
	_ = dispatcher.BroadcastMessage(OpError, payload, []runtime.Presence{msg}, nil, true)
}

func validationCode(err error) string {
	switch err {
	case ErrNotPlaying:
		return "not_playing"
	case ErrNotYourTurn:
		return "not_your_turn"
	case ErrCellOutRange:
		return "cell_out_of_range"
	case ErrCellOccupied:
		return "cell_occupied"
	case ErrUnknownPlayer:
		return "unknown_player"
	case ErrBadPayload:
		return "bad_payload"
	default:
		return "invalid_move"
	}
}
