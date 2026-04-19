package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/heroiclabs/nakama-common/runtime"
)

// Match is the authoritative tic-tac-toe match handler. It holds no per-match
// data — all state lives on *MatchState which Nakama threads through every
// callback — so the same *Match instance can serve many concurrent matches.
type Match struct{}

// NewMatch is the factory Nakama calls once per match it spins up. It is
// registered in InitModule under the MatchModuleName identifier.
func NewMatch(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule) (runtime.Match, error) {
	return &Match{}, nil
}

// -----------------------------------------------------------------------------
// MatchInit
//
// Called once when nk.MatchCreate returns. Params carry everything the match
// needs to know about its origin: the requested mode, the users the
// matchmaker (or a private-room RPC) expects to join, and the private-room
// code if any. We fail loudly on malformed input since the caller of
// MatchCreate is always our own code.
// -----------------------------------------------------------------------------
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
		// Returning nil state aborts match creation.
		return nil, 0, ""
	}

	code, _ := params["code"].(string) // optional — only set for private rooms

	expectedUsers := readStringSlice(params, "expected_users")

	state := NewMatchState(matchID, mode, expectedUsers)
	state.Code = code
	state.JoinDeadlineMs = time.Now().UnixMilli() + int64(JoinDeadlineSeconds*1000)

	labelJSON, err := (MatchLabel{Mode: mode, Code: code, Open: true}).Encode()
	if err != nil {
		logger.Error("MatchInit label encode failed (match=%s): %v", matchID, err)
		labelJSON = ""
	}

	logger.Info("MatchInit match=%s mode=%s code=%q expected=%v",
		matchID, mode, code, expectedUsers)

	// tickRate=1 — moves arrive as messages regardless of tick, and the
	// only job the tick has is checking time-based deadlines. ±1s resolution
	// is imperceptible in a 30-second turn timer.
	return state, 1, labelJSON
}

// readStringSlice coerces a []interface{} or []string param into []string.
// nk.MatchCreate passes params through JSON, which turns slices into
// []interface{} even when the caller supplied []string.
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

// -----------------------------------------------------------------------------
// MatchJoinAttempt
//
// Gate users before they fully join. For matchmaker-initiated matches we
// accept only the users the matchmaker listed; for private rooms we accept
// the first two users who arrive. Either way we refuse a third — the
// dispatcher will silently reuse the existing slot on reconnect, so we
// don't need special-case logic for that here.
// -----------------------------------------------------------------------------
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

	// If the user is a known player reconnecting (still has a mark in our
	// bookkeeping), always let them back in. They rejoin their own slot.
	if _, hasMark := s.MarkByUserID[userID]; hasMark {
		return s, true, ""
	}

	// Matchmaker-origin matches carry an ExpectedUsers list. Anyone not on
	// it is rejected — this is how we prevent third parties from sniping a
	// public match out from under a paired opponent.
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

	// Private room: accept until two unique players have a mark.
	if len(s.MarkByUserID) < 2 {
		return s, true, ""
	}
	return s, false, "match is full"
}

// -----------------------------------------------------------------------------
// MatchJoin
//
// Presences have been accepted and are now attached. This is the point at
// which we assign marks, load usernames for later leaderboard writes, and
// transition from waiting to playing once the second player arrives.
// -----------------------------------------------------------------------------
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
		// A reconnect clears any pending forfeit timer.
		delete(s.DisconnectAtMs, userID)

		if _, already := s.MarkByUserID[userID]; !already {
			mark := MarkX
			if _, taken := s.UserIDByMark[MarkX]; taken {
				mark = MarkO
			}
			s.MarkByUserID[userID] = mark
			s.UserIDByMark[mark] = userID
		}

		if _, have := s.Usernames[userID]; !have {
			// Username is best-effort — a lookup failure should not block
			// the join. Fall back to the presence's supplied username.
			s.Usernames[userID] = p.GetUsername()
			if accounts, err := nk.AccountsGetId(ctx, []string{userID}); err == nil && len(accounts) == 1 {
				if u := accounts[0].GetUser(); u != nil && u.Username != "" {
					s.Usernames[userID] = u.Username
				}
			}
		}
	}

	// Transition from waiting to playing once two distinct players are in.
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

// labelFor re-serialises the current match label. The `open` flag reflects
// whether the room still accepts a second player and is flipped to false
// once both players have joined.
func labelFor(logger runtime.Logger, s *MatchState, open bool) string {
	j, err := (MatchLabel{Mode: s.Mode, Code: s.Code, Open: open}).Encode()
	if err != nil {
		logger.Warn("label encode failed: %v", err)
		return ""
	}
	return j
}

// -----------------------------------------------------------------------------
// MatchLeave
//
// A presence disappears. We don't immediately forfeit — the grace window
// lets a flaky network recover. MatchLoop handles the eventual forfeit.
// -----------------------------------------------------------------------------
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
		// Only arm the grace clock for players that are actually in the
		// match — this avoids tracking someone whose join we rejected.
		if _, isPlayer := s.MarkByUserID[userID]; isPlayer && s.Status != StatusFinished {
			s.DisconnectAtMs[userID] = nowMs
			logger.Info("match=%s user=%s left, grace=%ds",
				s.MatchID, userID, DisconnectGraceSeconds)
		}
	}
	return s
}

// -----------------------------------------------------------------------------
// MatchLoop
//
// One tick per second. Responsibilities, in order:
//
//	1. Abort a match that never had both players join.
//	2. Forfeit a player whose disconnect grace window has elapsed.
//	3. Validate and apply inbound move messages, per sender.
//	4. Forfeit a turn that timed out in timed mode.
//	5. Broadcast a state update if any of the above changed state.
//	6. Emit OpMatchEnded on transition to finished.
//	7. Terminate the match once it has been idle-finished long enough.
// -----------------------------------------------------------------------------
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

	// (1) Abort orphaned waiting matches.
	if s.Status == StatusWaiting && nowMs > s.JoinDeadlineMs {
		s.Status = StatusFinished
		s.WinReason = WinReasonAbandoned
		changed = true
		logger.Info("match=%s abandoned: join deadline expired", s.MatchID)
	}

	// (2) Disconnect grace window.
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
				break // One forfeit is enough to end the match.
			}
		}
	}

	// (3) Process inbound messages.
	for _, msg := range messages {
		if s.Status != StatusPlaying {
			// Silently drop — no point error-spamming players whose match
			// ended mid-tick.
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

	// (4) Turn-timer forfeit.
	if s.Status == StatusPlaying && s.Mode == ModeTimed && nowMs > s.TurnDeadlineMs {
		losingUser := s.UserIDByMark[s.TurnMark]
		s.Status = StatusFinished
		s.WinReason = WinReasonTimeout
		s.Winner = opponentOf(s, losingUser)
		changed = true
		logger.Info("match=%s timeout: losing=%s winner=%s",
			s.MatchID, losingUser, s.Winner)
	}

	// (5 & 6) Broadcast state + end event.
	if changed {
		broadcastState(logger, dispatcher, s, nowMs)
		if s.Status == StatusFinished {
			broadcastEnded(logger, dispatcher, s)
			// Stats writes land here in a later milestone. We still set
			// the guard so MatchTerminate doesn't double-write once that
			// code arrives.
			s.StatsWritten = true
		}
	}

	// (7) Tear down long-idle finished matches.
	if s.Status == StatusFinished {
		if len(s.Presences) == 0 {
			s.EmptyTicks++
		} else {
			s.EmptyTicks = 0
		}
		if s.EmptyTicks >= EmptyMatchTicks {
			logger.Info("match=%s terminating: empty for %d ticks",
				s.MatchID, s.EmptyTicks)
			return nil // Returning nil tells Nakama to shut the match down.
		}
	}

	return s
}

// -----------------------------------------------------------------------------
// MatchTerminate
//
// Final cleanup when Nakama tears the match down (either because we returned
// nil from MatchLoop, or the server is shutting down). We do not rely on
// this as the primary place to emit match-ended side effects because it is
// not guaranteed to execute with the full grace window in all crash paths.
// -----------------------------------------------------------------------------
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
	// Stats / active-match cleanup plug into here when those subsystems land.
	return s
}

// -----------------------------------------------------------------------------
// MatchSignal
//
// Not used by tic-tac-toe. Defined so the *Match satisfies runtime.Match.
// -----------------------------------------------------------------------------
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

// -----------------------------------------------------------------------------
// Internal helpers.
// -----------------------------------------------------------------------------

// opponentOf returns the userId of the other player. If the caller isn't a
// player we return the empty string so downstream logic can still record a
// degenerate end without panicking.
func opponentOf(s *MatchState, userID string) string {
	for uid := range s.MarkByUserID {
		if uid != userID {
			return uid
		}
	}
	return ""
}

// broadcastState marshals the public projection and fans it out to all
// presences as a reliable message. Called on every state-changing tick.
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

// broadcastEnded sends a terminal notification once the match is finished.
// Separate from the last OpStateUpdate so clients can drive distinct UI
// (confetti, rematch prompt) without re-interpreting a state diff.
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

// sendError replies to exactly one presence (the sender of msg) with an
// OpError payload. Never broadcast errors — they are per-sender diagnostics.
func sendError(dispatcher runtime.MatchDispatcher, msg runtime.MatchData, code, message string) {
	payload, err := json.Marshal(ErrorMessage{Code: code, Message: message})
	if err != nil {
		// Falling back to an ad-hoc string keeps the client from hanging
		// on a silent drop if Marshal somehow fails on a string literal.
		payload = []byte(fmt.Sprintf(`{"code":%q,"message":%q}`, code, message))
	}
	_ = dispatcher.BroadcastMessage(OpError, payload, []runtime.Presence{msg}, nil, true)
}

// validationCode maps a ValidateMove sentinel error to a short machine code
// the client can dispatch on.
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
