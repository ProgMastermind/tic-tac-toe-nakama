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

	// Subsequent commits register the private-room RPCs, the matchmaker
	// hook, and the global leaderboard here.

	logger.Info("tic-tac-toe module: ready")
	return nil
}
