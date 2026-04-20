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

// Visually unambiguous subset (no I/L/1, no O/0). 31^4 ≈ 923k codes.
const codeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

const codeLength = 4

const maxCodeCollisions = 5

const createCooldown = 5 * time.Second

// In-memory last-hit map — fine for a single Nakama instance; clustered
// deployments would want a distributed token bucket.
type rateLimiter struct {
	mu   sync.Mutex
	last map[string]time.Time
}

var createLimiter = &rateLimiter{last: make(map[string]time.Time)}

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

func RpcCreatePrivateMatch(
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

	var req createPrivateMatchRequest
	if payload != "" {
		if err := json.Unmarshal([]byte(payload), &req); err != nil {
			return "", runtime.NewError("malformed payload: "+err.Error(), 3)
		}
	}
	mode, err := normaliseMode(req.Mode)
	if err != nil {
		return "", runtime.NewError(err.Error(), 3)
	}

	if !createLimiter.allow(userID, createCooldown) {
		return "", runtime.NewError(
			"please wait a few seconds before creating another room",
			8,
		)
	}

	code, err := mintUniqueCode(ctx, nk)
	if err != nil {
		logger.Error("create_private_match: mintUniqueCode user=%s err=%v", userID, err)
		return "", runtime.NewError("could not generate a unique room code", 13)
	}

	// Leave expected_users empty — populating it would trip the matchmaker
	// gate in MatchJoinAttempt and reject any joiner. Creator is carried
	// via the label for self-join detection instead.
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
		return "", runtime.NewError(err.Error(), 5)
	}

	// Two tabs sharing a device id (same Chrome profile) would otherwise
	// crash into a waiting room that can never start. Give a clear message.
	if creator := matchCreatorFromLabel(match); creator == userID {
		logger.Warn("join_private_match: user=%s tried to join their own room code=%s",
			userID, code)
		return "", runtime.NewError(
			"you already created this room — open the second browser in incognito so it has a different identity",
			9,
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

func normaliseMode(raw string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case ModeClassic, "":
		return ModeClassic, nil
	case ModeTimed:
		return ModeTimed, nil
	default:
		return "", fmt.Errorf("unsupported mode %q (want %q or %q)", raw, ModeClassic, ModeTimed)
	}
}

// Rejects anything outside the alphabet to prevent injection into the
// MatchList query.
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

// Modulo bias is fine — the code is a lookup handle, not a security token.
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

// maxSize=1 excludes full rooms. A boolean label filter would be cleaner,
// but Bleve's JSON-bool indexing is inconsistent across Nakama versions.
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

func extractLabelMode(labelJSON string) string {
	l, ok := decodeLabel(labelJSON)
	if !ok {
		return ""
	}
	return l.Mode
}

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
