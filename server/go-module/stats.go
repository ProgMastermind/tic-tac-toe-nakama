package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/heroiclabs/nakama-common/runtime"
)

// Read-modify-write is safe here: a user is in at most one authoritative
// match at a time, and currentStreak/bestStreak need full state anyway.
// Rows are world-readable so the leaderboard page can annotate entries
// with streaks without a second lookup per user.

const (
	statsCollection = "stats"
	statsKey        = "summary"
)

type StatsSummary struct {
	Wins          int `json:"wins"`
	Losses        int `json:"losses"`
	Draws         int `json:"draws"`
	CurrentStreak int `json:"currentStreak"`
	BestStreak    int `json:"bestStreak"`
	ClassicWins   int `json:"classicWins"`
	TimedWins     int `json:"timedWins"`
}

type outcome int

const (
	outcomeSkip outcome = iota
	outcomeWin
	outcomeLoss
	outcomeDraw
)

func classify(s *MatchState, userID string) outcome {
	if s.WinReason == WinReasonAbandoned {
		return outcomeSkip
	}
	if s.Winner == "" {
		return outcomeDraw
	}
	if s.Winner == userID {
		return outcomeWin
	}
	return outcomeLoss
}

// BestStreak is a high-water mark, not reset when currentStreak breaks.
func applyOutcome(summary *StatsSummary, mode string, o outcome) {
	switch o {
	case outcomeWin:
		summary.Wins++
		summary.CurrentStreak++
		if summary.CurrentStreak > summary.BestStreak {
			summary.BestStreak = summary.CurrentStreak
		}
		if mode == ModeTimed {
			summary.TimedWins++
		} else {
			summary.ClassicWins++
		}
	case outcomeLoss:
		summary.Losses++
		summary.CurrentStreak = 0
	case outcomeDraw:
		summary.Draws++
		summary.CurrentStreak = 0
	}
}

// Absent or malformed rows return a zero summary — a first-time player is
// the common absent case; a corrupt row would otherwise block the match-end write.
func readStats(
	ctx context.Context,
	nk runtime.NakamaModule,
	userID string,
) (StatsSummary, error) {
	objs, err := nk.StorageRead(ctx, []*runtime.StorageRead{{
		Collection: statsCollection,
		Key:        statsKey,
		UserID:     userID,
	}})
	if err != nil {
		return StatsSummary{}, fmt.Errorf("storage read stats user=%s: %w", userID, err)
	}
	if len(objs) == 0 {
		return StatsSummary{}, nil
	}
	var summary StatsSummary
	if err := json.Unmarshal([]byte(objs[0].GetValue()), &summary); err != nil {
		return StatsSummary{}, nil
	}
	return summary, nil
}

func writeStatsRow(
	ctx context.Context,
	nk runtime.NakamaModule,
	userID string,
	summary StatsSummary,
) error {
	value, err := json.Marshal(summary)
	if err != nil {
		return fmt.Errorf("marshal stats user=%s: %w", userID, err)
	}
	if _, err := nk.StorageWrite(ctx, []*runtime.StorageWrite{{
		Collection:      statsCollection,
		Key:             statsKey,
		UserID:          userID,
		Value:           string(value),
		PermissionRead:  2,
		PermissionWrite: 0,
	}}); err != nil {
		return fmt.Errorf("storage write stats user=%s: %w", userID, err)
	}
	return nil
}

// Per-player errors are logged and swallowed so one storage blip doesn't
// block the other player's write or stall the end-of-match UI.
func writeMatchStats(
	ctx context.Context,
	logger runtime.Logger,
	nk runtime.NakamaModule,
	s *MatchState,
) {
	if s.WinReason == WinReasonAbandoned {
		return
	}

	for userID := range s.MarkByUserID {
		o := classify(s, userID)
		if o == outcomeSkip {
			continue
		}
		summary, err := readStats(ctx, nk, userID)
		if err != nil {
			logger.Warn("match=%s stats read user=%s err=%v", s.MatchID, userID, err)
		}
		applyOutcome(&summary, s.Mode, o)
		if err := writeStatsRow(ctx, nk, userID, summary); err != nil {
			logger.Warn("match=%s stats write user=%s err=%v", s.MatchID, userID, err)
		}
	}

	if s.Winner != "" {
		username := s.Usernames[s.Winner]
		if _, err := nk.LeaderboardRecordWrite(
			ctx,
			GlobalWinsLeaderboard,
			s.Winner,
			username,
			1,
			0,
			nil,
			nil,
		); err != nil {
			logger.Warn("match=%s leaderboard write winner=%s err=%v",
				s.MatchID, s.Winner, err)
		}
	}
}

func RpcGetStats(
	ctx context.Context,
	logger runtime.Logger,
	db *sql.DB,
	nk runtime.NakamaModule,
	payload string,
) (string, error) {
	userID, ok := ctx.Value(runtime.RUNTIME_CTX_USER_ID).(string)
	if !ok || userID == "" {
		return "", runtime.NewError("unauthenticated", 16)
	}

	summary, err := readStats(ctx, nk, userID)
	if err != nil {
		logger.Error("get_stats: read user=%s err=%v", userID, err)
		return "", runtime.NewError("could not read stats", 13)
	}

	out, err := json.Marshal(summary)
	if err != nil {
		return "", runtime.NewError("response marshal: "+err.Error(), 13)
	}
	return string(out), nil
}
