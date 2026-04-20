package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/heroiclabs/nakama-common/runtime"
)

// One row per player under (active_match, current, userId) drives the
// rehydrate flow — the client reads it at boot to resume an in-flight match.
// Owner-readable and server-only-writable so another account can't snoop or
// forge it.

const (
	activeMatchCollection = "active_match"
	activeMatchKey        = "current"
)

type activeMatchRecord struct {
	MatchID string `json:"matchId"`
	Mark    string `json:"mark"`
	Mode    string `json:"mode"`
}

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
		PermissionRead:  1,
		PermissionWrite: 0,
	}})
	if err != nil {
		return fmt.Errorf("storage write active match: %w", err)
	}
	return nil
}

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

// Returns (nil, nil) when the row is absent — the common case.
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
		// Treat a malformed row as absent — the next MatchJoin overwrites it.
		return nil, nil
	}
	return &rec, nil
}

type getCurrentMatchResponse struct {
	Active  bool   `json:"active"`
	MatchID string `json:"matchId,omitempty"`
	Mark    string `json:"mark,omitempty"`
	Mode    string `json:"mode,omitempty"`
}

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
