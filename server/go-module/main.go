package main

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/heroiclabs/nakama-common/runtime"
)

const MatchModuleName = "tictactoe"

const GlobalWinsLeaderboard = "global_wins"

// Signature must stay byte-identical to nakama-common's expectation or the
// plugin fails to load.
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
	if err := initializer.RegisterRpc("get_stats", RpcGetStats); err != nil {
		return fmt.Errorf("register rpc get_stats: %w", err)
	}

	if err := initializer.RegisterMatchmakerMatched(matchmakerMatched); err != nil {
		return fmt.Errorf("register matchmaker_matched: %w", err)
	}

	// Idempotent; empty resetSchedule means wins never reset.
	if err := nk.LeaderboardCreate(
		ctx,
		GlobalWinsLeaderboard,
		true,
		"desc",
		"incr",
		"",
		nil,
		true,
	); err != nil {
		return fmt.Errorf("create leaderboard %q: %w", GlobalWinsLeaderboard, err)
	}

	logger.Info("tic-tac-toe module: ready")
	return nil
}
