package main

import (
	"context"
	"database/sql"

	"github.com/heroiclabs/nakama-common/runtime"
)

// Returning a match id here triggers Nakama to deliver matchmaker_matched
// + a short-lived token to each client, which they use for socket.joinMatch.
func matchmakerMatched(
	ctx context.Context,
	logger runtime.Logger,
	db *sql.DB,
	nk runtime.NakamaModule,
	entries []runtime.MatchmakerEntry,
) (string, error) {
	if len(entries) == 0 {
		return "", nil
	}

	mode := modeFromEntries(entries)

	userIDs := make([]string, 0, len(entries))
	for _, e := range entries {
		if pres := e.GetPresence(); pres != nil {
			userIDs = append(userIDs, pres.GetUserId())
		}
	}

	matchID, err := nk.MatchCreate(ctx, MatchModuleName, map[string]interface{}{
		"mode":           mode,
		"expected_users": userIDs,
	})
	if err != nil {
		logger.Error("matchmaker_matched: MatchCreate mode=%s users=%v err=%v",
			mode, userIDs, err)
		return "", runtime.NewError("could not create match", 13)
	}

	logger.Info("matchmaker_matched: match=%s mode=%s users=%v",
		matchID, mode, userIDs)
	return matchID, nil
}

// Unknown/missing falls through to ModeClassic so a buggy client still gets
// a playable match rather than a dead ticket.
func modeFromEntries(entries []runtime.MatchmakerEntry) string {
	if len(entries) == 0 {
		return ModeClassic
	}
	raw, ok := entries[0].GetProperties()["mode"].(string)
	if !ok {
		return ModeClassic
	}
	switch raw {
	case ModeTimed:
		return ModeTimed
	case ModeClassic:
		return ModeClassic
	default:
		return ModeClassic
	}
}
