package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/heroiclabs/nakama-common/api"
	"github.com/heroiclabs/nakama-common/runtime"
)

// -----------------------------------------------------------------------------
// Private-room RPCs.
//
// create_private_match opens a fresh authoritative match with a short human-
// readable share code stored in its label. join_private_match resolves a
// code back to a match ID via MatchList. No separate storage row is used —
// the label is the canonical place the code lives, so it disappears with
// the match rather than orphaning a reference when the match ends.
// -----------------------------------------------------------------------------

// codeAlphabet is a 32-character subset with visually ambiguous glyphs
// removed (I/L/1, O/0). 32^4 = 1,048,576 possible codes — more than enough
// for many concurrent rooms while keeping collisions rare.
const codeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

const codeLength = 4

// maxCodeCollisions is how many times we re-roll before giving up on a
// new private room. Reaching this is virtually impossible unless the
// server has roughly a million concurrent rooms, but we cap it for
// belt-and-braces safety.
const maxCodeCollisions = 5

// createCooldown is the per-user minimum wait between create_private_match
// calls. The cost of creating a match is low individually, but a loop of
// creations from a single client could exhaust match IDs quickly, so we
// add a soft ceiling.
const createCooldown = 5 * time.Second

// rateLimiter is a trivial in-memory last-hit map. Fine for a single
// Nakama instance — clustered setups would want a distributed token
// bucket. Mutex is shared across both RPCs since they both touch it.
type rateLimiter struct {
	mu   sync.Mutex
	last map[string]time.Time
}

var createLimiter = &rateLimiter{last: make(map[string]time.Time)}

// allow returns true if `key` is permitted to proceed, recording the
// current time on success. A denied call leaves the map untouched so
// the existing cooldown window continues to count down.
func (r *rateLimiter) allow(key string, window time.Duration) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	if last, ok := r.last[key]; ok && now.Sub(last) < window {
		return false
	}
	r.last[key] = now
	return true
}

// -----------------------------------------------------------------------------
// Input/output payload shapes. JSON-typed for self-documenting wire format.
// -----------------------------------------------------------------------------

type createPrivateMatchRequest struct {
	Mode string `json:"mode"`
}

type createPrivateMatchResponse struct {
	MatchID string `json:"matchId"`
	Code    string `json:"code"`
	Mode    string `json:"mode"`
}

type joinPrivateMatchRequest struct {
	Code string `json:"code"`
}

type joinPrivateMatchResponse struct {
	MatchID string `json:"matchId"`
	Mode    string `json:"mode"`
}

// -----------------------------------------------------------------------------
// Handlers.
// -----------------------------------------------------------------------------

// RpcCreatePrivateMatch is registered under the id "create_private_match". It
// MUST be called by an authenticated user; ctx carries the session's user id.
func RpcCreatePrivateMatch(
	ctx context.Context,
	logger runtime.Logger,
	db *sql.DB,
	nk runtime.NakamaModule,
	payload string,
) (string, error) {
	userID, ok := ctx.Value(runtime.RUNTIME_CTX_USER_ID).(string)
	if !ok || userID == "" {
		return "", runtime.NewError("unauthenticated", 16) // UNAUTHENTICATED
	}

	var req createPrivateMatchRequest
	if payload != "" {
		if err := json.Unmarshal([]byte(payload), &req); err != nil {
			return "", runtime.NewError("malformed payload: "+err.Error(), 3) // INVALID_ARGUMENT
		}
	}
	mode, err := normaliseMode(req.Mode)
	if err != nil {
		return "", runtime.NewError(err.Error(), 3)
	}

	if !createLimiter.allow(userID, createCooldown) {
		return "", runtime.NewError(
			"please wait a few seconds before creating another room",
			8, // RESOURCE_EXHAUSTED
		)
	}

	code, err := mintUniqueCode(ctx, nk)
	if err != nil {
		logger.Error("create_private_match: mintUniqueCode user=%s err=%v", userID, err)
		return "", runtime.NewError("could not generate a unique room code", 13) // INTERNAL
	}

	// NOTE: expected_users stays empty for private rooms. The creator is
	// tracked via the match label (Creator field) so self-join can be
	// refused, but populating expected_users here would trigger the
	// matchmaker-gate in MatchJoinAttempt and reject any joiner who
	// wasn't on the list. For private rooms the first two unique
	// socket.joinMatch calls win the slots — creator is just the first.
	matchID, err := nk.MatchCreate(ctx, MatchModuleName, map[string]interface{}{
		"mode":    mode,
		"code":    code,
		"creator": userID,
	})
	if err != nil {
		logger.Error("create_private_match: MatchCreate user=%s err=%v", userID, err)
		return "", runtime.NewError("could not open a new match", 13)
	}

	logger.Info("create_private_match: user=%s mode=%s code=%s match=%s",
		userID, mode, code, matchID)

	out, err := json.Marshal(createPrivateMatchResponse{
		MatchID: matchID,
		Code:    code,
		Mode:    mode,
	})
	if err != nil {
		return "", runtime.NewError("response marshal: "+err.Error(), 13)
	}
	return string(out), nil
}

// RpcJoinPrivateMatch is registered under the id "join_private_match".
func RpcJoinPrivateMatch(
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

	var req joinPrivateMatchRequest
	if err := json.Unmarshal([]byte(payload), &req); err != nil {
		return "", runtime.NewError("malformed payload: "+err.Error(), 3)
	}
	code, err := normaliseCode(req.Code)
	if err != nil {
		return "", runtime.NewError(err.Error(), 3)
	}

	match, err := findOpenMatchByCode(ctx, nk, code)
	if err != nil {
		logger.Warn("join_private_match: user=%s code=%s err=%v", userID, code, err)
		return "", runtime.NewError(err.Error(), 5) // NOT_FOUND
	}

	// Guard against a user trying to join their own room. This happens when
	// the two tabs share a device id (e.g. two regular Chrome windows on the
	// same profile). Give a clear message instead of letting them crash into
	// a waiting room that can never start.
	if creator := matchCreatorFromLabel(match); creator == userID {
		logger.Warn("join_private_match: user=%s tried to join their own room code=%s",
			userID, code)
		return "", runtime.NewError(
			"you already created this room — open the second browser in incognito so it has a different identity",
			9, // FAILED_PRECONDITION
		)
	}

	mode := ""
	if lv := match.GetLabel(); lv != nil {
		mode = extractLabelMode(lv.GetValue())
	}

	logger.Info("join_private_match: user=%s code=%s match=%s",
		userID, code, match.GetMatchId())

	out, err := json.Marshal(joinPrivateMatchResponse{
		MatchID: match.GetMatchId(),
		Mode:    mode,
	})
	if err != nil {
		return "", runtime.NewError("response marshal: "+err.Error(), 13)
	}
	return string(out), nil
}

// -----------------------------------------------------------------------------
// Helpers.
// -----------------------------------------------------------------------------

// normaliseMode validates the mode string against the supported set.
// Unknown modes are rejected outright rather than silently defaulted —
// a typo on the client should surface loudly during development.
func normaliseMode(raw string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case ModeClassic, "":
		return ModeClassic, nil // "" defaults to classic so callers don't have to specify
	case ModeTimed:
		return ModeTimed, nil
	default:
		return "", fmt.Errorf("unsupported mode %q (want %q or %q)", raw, ModeClassic, ModeTimed)
	}
}

// normaliseCode uppercases, trims whitespace, enforces the fixed length,
// and verifies every character is from the configured alphabet. Rejecting
// anything else prevents injection into the MatchList query string.
func normaliseCode(raw string) (string, error) {
	code := strings.ToUpper(strings.TrimSpace(raw))
	if len(code) != codeLength {
		return "", fmt.Errorf("room code must be %d characters", codeLength)
	}
	for _, r := range code {
		if !strings.ContainsRune(codeAlphabet, r) {
			return "", fmt.Errorf("room code contains invalid characters")
		}
	}
	return code, nil
}

// mintUniqueCode generates codes in a loop until one is not held by any
// currently open private match. Collisions are checked via MatchList on
// the label field — authoritative=true, min/max=1..2 so the call captures
// both waiting rooms (1 presence) and active ones (2 presences).
func mintUniqueCode(ctx context.Context, nk runtime.NakamaModule) (string, error) {
	for attempt := 0; attempt < maxCodeCollisions; attempt++ {
		code, err := randomCode()
		if err != nil {
			return "", fmt.Errorf("random: %w", err)
		}
		min := 0
		max := 2
		matches, err := nk.MatchList(ctx, 1, true, "", &min, &max,
			fmt.Sprintf("+label.code:%s", code))
		if err != nil {
			return "", fmt.Errorf("list matches: %w", err)
		}
		if len(matches) == 0 {
			return code, nil
		}
	}
	return "", errors.New("code collision limit exceeded")
}

// randomCode pulls cryptographically secure bytes and maps each to the
// codeAlphabet. The modulo bias is negligible given the small range and
// the fact that codes are not used as a security token — a slightly
// non-uniform code distribution will not let anyone guess a specific room.
func randomCode() (string, error) {
	buf := make([]byte, codeLength)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	out := make([]byte, codeLength)
	for i, b := range buf {
		out[i] = codeAlphabet[int(b)%len(codeAlphabet)]
	}
	return string(out), nil
}

// findOpenMatchByCode returns the first open private match carrying the
// supplied code. Full rooms are excluded via maxSize=1 rather than a
// boolean label filter — Bleve's indexing of JSON booleans is
// inconsistent across Nakama versions, and since the creator's presence
// is attached only after their own socket.joinMatch, a room that's
// waiting for the second player has presence size in {0, 1}. Two
// presences means the match has filled up from the server's point of
// view and is not join-able.
func findOpenMatchByCode(ctx context.Context, nk runtime.NakamaModule, code string) (*api.Match, error) {
	min := 0
	max := 1
	matches, err := nk.MatchList(ctx, 5, true, "", &min, &max,
		fmt.Sprintf("+label.code:%s", code))
	if err != nil {
		return nil, fmt.Errorf("room lookup failed: %w", err)
	}
	if len(matches) == 0 {
		return nil, fmt.Errorf("no open room with code %s", code)
	}
	return matches[0], nil
}

// extractLabelMode reads the mode field out of a label JSON blob. Returns
// the empty string if the label is missing or malformed, so callers can
// continue without treating a parse failure as fatal.
func extractLabelMode(labelJSON string) string {
	l, ok := decodeLabel(labelJSON)
	if !ok {
		return ""
	}
	return l.Mode
}

// matchCreatorFromLabel returns the creator userId encoded in the match
// label, or the empty string if the label is malformed or predates the
// field. Used by join_private_match to guard against same-user self-join.
func matchCreatorFromLabel(match *api.Match) string {
	if match == nil {
		return ""
	}
	lv := match.GetLabel()
	if lv == nil {
		return ""
	}
	l, ok := decodeLabel(lv.GetValue())
	if !ok {
		return ""
	}
	return l.Creator
}

func decodeLabel(labelJSON string) (MatchLabel, bool) {
	var l MatchLabel
	if labelJSON == "" {
		return l, false
	}
	if err := json.Unmarshal([]byte(labelJSON), &l); err != nil {
		return l, false
	}
	return l, true
}
