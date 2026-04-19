package main

import (
	"context"
	"database/sql"

	"github.com/heroiclabs/nakama-common/runtime"
)

// -----------------------------------------------------------------------------
// Public matchmaker hook.
//
// Nakama's matchmaker groups two users with compatible tickets and invokes
// this callback exactly once per match. Returning a non-empty match id
// causes Nakama to auto-deliver a matchmaker_matched event to each matched
// client carrying that id plus a short-lived token — the client then calls
// socket.joinMatch(id, token) to attach. Returning "" accepts the grouping
// without opening an authoritative match, which isn't what we want.
//
// The entries all share the same string_properties.mode because the query
// "+properties.mode:<mode>" is the only compatibility axis we use; we
// still defensively read mode from the first entry rather than assuming.
// -----------------------------------------------------------------------------

// matchmakerMatched opens an authoritative tic-tac-toe match for the two
// users the matchmaker paired. expected_users is populated so
// MatchJoinAttempt's allow-list gate admits only those two users — anyone
// else trying to join the same match id is rejected.
func matchmakerMatched(
	ctx context.Context,
	logger runtime.Logger,
	db *sql.DB,
	nk runtime.NakamaModule,
	entries []runtime.MatchmakerEntry,
) (string, error) {
	if len(entries) == 0 {
		// Defensive: the runtime shouldn't deliver an empty slice, but
		// silently accepting prevents a spurious error being surfaced to
		// both clients.
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
		// Map to a runtime error so Nakama returns a structured code to the
		// paired clients rather than an opaque 500.
		return "", runtime.NewError("could not create match", 13) // INTERNAL
	}

	logger.Info("matchmaker_matched: match=%s mode=%s users=%v",
		matchID, mode, userIDs)
	return matchID, nil
}

// modeFromEntries reads the requested mode from the first matchmaker entry.
// Unknown or missing values fall through to ModeClassic so a buggy client
// still gets a playable match instead of a dead ticket.
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
