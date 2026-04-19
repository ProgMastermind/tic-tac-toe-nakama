// Package main is the entry point for the tic-tac-toe Nakama Go plugin.
//
// Nakama loads shared-object plugins at startup and invokes InitModule, which
// is the only exported symbol required by the runtime. Everything the game
// offers — the authoritative match handler, the matchmaker hook, private
// room RPCs, and the leaderboard initialisation — is wired up from here.
package main

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/heroiclabs/nakama-common/runtime"
)

// MatchModuleName is the identifier passed to nk.MatchCreate when opening
// a new authoritative tic-tac-toe match. Keep it in sync with client code
// paths and any matchmaker hooks that create matches on behalf of users.
const MatchModuleName = "tictactoe"

// GlobalWinsLeaderboard is the id of the single leaderboard maintained by
// this module. Winner writes are keyed on it; the Leaderboard page reads
// from the same id. Defined here rather than on stats.go because both
// InitModule and the stats writer reference it.
const GlobalWinsLeaderboard = "global_wins"

// InitModule is called exactly once by the Nakama runtime when the plugin
// is loaded. The signature must remain byte-identical to the one expected
// by nakama-common — any drift will cause the plugin to fail to load.
func InitModule(
	ctx context.Context,
	logger runtime.Logger,
	db *sql.DB,
	nk runtime.NakamaModule,
	initializer runtime.Initializer,
) error {
	logger.Info("tic-tac-toe module: loading (match=%q)", MatchModuleName)

	if err := initializer.RegisterMatch(MatchModuleName, NewMatch); err != nil {
		return fmt.Errorf("register match %q: %w", MatchModuleName, err)
	}

	if err := initializer.RegisterRpc("create_private_match", RpcCreatePrivateMatch); err != nil {
		return fmt.Errorf("register rpc create_private_match: %w", err)
	}
	if err := initializer.RegisterRpc("join_private_match", RpcJoinPrivateMatch); err != nil {
		return fmt.Errorf("register rpc join_private_match: %w", err)
	}
	if err := initializer.RegisterRpc("get_current_match", RpcGetCurrentMatch); err != nil {
		return fmt.Errorf("register rpc get_current_match: %w", err)
	}

	if err := initializer.RegisterMatchmakerMatched(matchmakerMatched); err != nil {
		return fmt.Errorf("register matchmaker_matched: %w", err)
	}

	// Authoritative, descending, increment operator. Empty reset schedule
	// means the leaderboard never resets — wins accumulate for the
	// lifetime of the deployment. enableRanks=true causes Nakama to
	// compute rank positions server-side so the client can render them
	// without an extra round-trip. LeaderboardCreate is idempotent on
	// repeated boots with identical args.
	if err := nk.LeaderboardCreate(
		ctx,
		GlobalWinsLeaderboard,
		/*authoritative*/ true,
		/*sortOrder*/ "desc",
		/*operator*/ "incr",
		/*resetSchedule*/ "",
		/*metadata*/ nil,
		/*enableRanks*/ true,
	); err != nil {
		return fmt.Errorf("create leaderboard %q: %w", GlobalWinsLeaderboard, err)
	}

	logger.Info("tic-tac-toe module: ready")
	return nil
}
