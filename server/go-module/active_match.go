package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/heroiclabs/nakama-common/runtime"
)

// -----------------------------------------------------------------------------
// Active match storage.
//
// Each player attached to a live match has a single storage row written
// under (collection=active_match, key=current, owner=userId). The row is
// the source of truth for "where was this user last playing" and drives
// the rehydrate flow: on page load, the client asks the server for its
// row, and if one exists it navigates directly to the game page and
// reconnects.
//
// Written: in MatchJoin, the first time each player acquires a mark.
// Cleared: in MatchTerminate, for every player the match knew about.
//
// The row is owner-readable so a compromised or curious client from a
// different account can't look up someone else's current match. The
// server holds sole write authority (PermissionWrite = 0) since stale or
// forged rows would break rehydrate for the owning user.
// -----------------------------------------------------------------------------

const (
	activeMatchCollection = "active_match"
	activeMatchKey        = "current"
)

// activeMatchRecord is the JSON shape written to storage and returned
// verbatim by the get_current_match RPC. Keep field names camelCase so
// the client can consume them directly.
type activeMatchRecord struct {
	MatchID string `json:"matchId"`
	Mark    string `json:"mark"`
	Mode    string `json:"mode"`
}

// writeActiveMatch records the player's current match. Safe to call
// multiple times for the same player — the row is upserted by key.
func writeActiveMatch(
	ctx context.Context,
	nk runtime.NakamaModule,
	userID, matchID, mark, mode string,
) error {
	rec := activeMatchRecord{MatchID: matchID, Mark: mark, Mode: mode}
	value, err := json.Marshal(rec)
	if err != nil {
		return fmt.Errorf("marshal active match: %w", err)
	}
	_, err = nk.StorageWrite(ctx, []*runtime.StorageWrite{{
		Collection:      activeMatchCollection,
		Key:             activeMatchKey,
		UserID:          userID,
		Value:           string(value),
		PermissionRead:  1, // owner reads only
		PermissionWrite: 0, // server-only writes
	}})
	if err != nil {
		return fmt.Errorf("storage write active match: %w", err)
	}
	return nil
}

// clearActiveMatch deletes the current-match row for userID. Missing rows
// are treated as a no-op — the caller does not need to pre-check existence.
func clearActiveMatch(
	ctx context.Context,
	nk runtime.NakamaModule,
	userID string,
) error {
	err := nk.StorageDelete(ctx, []*runtime.StorageDelete{{
		Collection: activeMatchCollection,
		Key:        activeMatchKey,
		UserID:     userID,
	}})
	if err != nil {
		return fmt.Errorf("storage delete active match: %w", err)
	}
	return nil
}

// readActiveMatch loads the current-match row for userID. Returns a nil
// record (no error) when the row is absent — the common steady-state
// case for a user not currently in a match.
func readActiveMatch(
	ctx context.Context,
	nk runtime.NakamaModule,
	userID string,
) (*activeMatchRecord, error) {
	objs, err := nk.StorageRead(ctx, []*runtime.StorageRead{{
		Collection: activeMatchCollection,
		Key:        activeMatchKey,
		UserID:     userID,
	}})
	if err != nil {
		return nil, fmt.Errorf("storage read active match: %w", err)
	}
	if len(objs) == 0 {
		return nil, nil
	}
	var rec activeMatchRecord
	if err := json.Unmarshal([]byte(objs[0].GetValue()), &rec); err != nil {
		// A malformed row blocks rehydrate — treat as absent rather than
		// propagating a hard error that would show the user a scary
		// toast. The row will be overwritten next time they join a match.
		return nil, nil
	}
	return &rec, nil
}

// -----------------------------------------------------------------------------
// get_current_match RPC.
// -----------------------------------------------------------------------------

type getCurrentMatchResponse struct {
	Active  bool   `json:"active"`
	MatchID string `json:"matchId,omitempty"`
	Mark    string `json:"mark,omitempty"`
	Mode    string `json:"mode,omitempty"`
}

// RpcGetCurrentMatch is registered under "get_current_match". Clients call
// it once on app boot to learn whether they need to resume an in-flight
// match before rendering the lobby.
func RpcGetCurrentMatch(
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

	rec, err := readActiveMatch(ctx, nk, userID)
	if err != nil {
		logger.Error("get_current_match: read user=%s err=%v", userID, err)
		return "", runtime.NewError("could not read active match", 13)
	}

	resp := getCurrentMatchResponse{Active: rec != nil}
	if rec != nil {
		resp.MatchID = rec.MatchID
		resp.Mark = rec.Mark
		resp.Mode = rec.Mode
	}

	out, err := json.Marshal(resp)
	if err != nil {
		return "", runtime.NewError("response marshal: "+err.Error(), 13)
	}
	return string(out), nil
}
