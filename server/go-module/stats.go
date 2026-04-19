package main

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/heroiclabs/nakama-common/runtime"
)

// -----------------------------------------------------------------------------
// Per-user stats.
//
// Every finished match updates a single storage row per player and, if there
// was a decisive winner, increments the global leaderboard for them. The row
// is owner-written (server-only) and world-readable so the Leaderboard page
// can enrich each leaderboard entry with the owner's streak and per-mode
// breakdown without a second lookup per user.
//
// We deliberately read-modify-write rather than using a Lua/SQL-style
// increment op:
//   - the write is serialised per-user by Nakama's storage engine on the
//     same owner+collection+key;
//   - two concurrent finishes on the *same* user are impossible (a user is
//     only in one authoritative match at a time);
//   - the logic (currentStreak, bestStreak) is stateful enough that an
//     incr-style API would not help even if it existed.
// -----------------------------------------------------------------------------

const (
	statsCollection = "stats"
	statsKey        = "summary"
)

// StatsSummary is the JSON shape persisted per user. Field names are the
// same on the wire so the get_stats RPC and the leaderboard page can
// consume this value directly without a server-side translation layer.
type StatsSummary struct {
	Wins          int `json:"wins"`
	Losses        int `json:"losses"`
	Draws         int `json:"draws"`
	CurrentStreak int `json:"currentStreak"`
	BestStreak    int `json:"bestStreak"`
	ClassicWins   int `json:"classicWins"`
	TimedWins     int `json:"timedWins"`
}

// outcome is a three-way classification of the per-player result of a
// finished match. Abandoned matches produce outcomeSkip so the caller can
// short-circuit the whole stats write without special-casing at each use.
type outcome int

const (
	outcomeSkip outcome = iota // match didn't really start — do nothing
	outcomeWin
	outcomeLoss
	outcomeDraw
)

// classify turns the match-ended state into a per-player outcome. Returns
// outcomeSkip when the match ended in a way that should not be recorded —
// currently only WinReasonAbandoned, where neither player meaningfully
// participated in a game.
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

// applyOutcome mutates summary in place to reflect one match's result.
// BestStreak is the running high-water mark, independent of whether the
// current streak is still alive.
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

// readStats loads a user's stats row. Returns a zero-valued StatsSummary
// (and no error) when the row is absent or malformed — both cases can
// legitimately occur for a first-time player, and blocking the match-end
// write on either would be disproportionate.
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
		// Treat corrupt rows as a fresh start. A loud failure here would
		// prevent the match from recording its result; silent reset costs
		// one player a tiny amount of history on an extremely rare edge.
		return StatsSummary{}, nil
	}
	return summary, nil
}

// writeStatsRow persists a summary for one user. Owner-write only and
// world-readable so the leaderboard UI can cheaply annotate other players'
// rows with their streaks.
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
		PermissionRead:  2, // public — leaderboard pairs rows with records
		PermissionWrite: 0, // server-only
	}}); err != nil {
		return fmt.Errorf("storage write stats user=%s: %w", userID, err)
	}
	return nil
}

// writeMatchStats is the single entry point the match handler calls when a
// match transitions to finished. It iterates both players, applies the
// outcome to each row, persists them, and (if there was a winner)
// increments the global leaderboard for that user.
//
// Errors on individual players are logged and swallowed: a storage blip
// for player A should not prevent player B's row from being updated, and
// match-end UI should not stall on a transient infra hiccup.
func writeMatchStats(
	ctx context.Context,
	logger runtime.Logger,
	nk runtime.NakamaModule,
	s *MatchState,
) {
	// Abandoned matches never started — both players get nothing written.
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
			// Fall through with the zero value — losing one match of
			// history is better than skipping the write entirely.
		}
		applyOutcome(&summary, s.Mode, o)
		if err := writeStatsRow(ctx, nk, userID, summary); err != nil {
			logger.Warn("match=%s stats write user=%s err=%v", s.MatchID, userID, err)
		}
	}

	// Leaderboard is winner-only. Draws and abandoned matches are filtered
	// above by the WinReason check and the Winner == "" guard.
	if s.Winner != "" {
		username := s.Usernames[s.Winner]
		if _, err := nk.LeaderboardRecordWrite(
			ctx,
			GlobalWinsLeaderboard,
			s.Winner,
			username,
			/*score*/ 1,
			/*subscore*/ 0,
			/*metadata*/ nil,
			/*overrideOperator*/ nil,
		); err != nil {
			logger.Warn("match=%s leaderboard write winner=%s err=%v",
				s.MatchID, s.Winner, err)
		}
	}
}
