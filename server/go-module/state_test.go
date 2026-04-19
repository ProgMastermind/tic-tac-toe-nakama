package main

import (
	"errors"
	"testing"
)

// Pure game-rule tests. Every move validation path and every winning line
// is exercised here — these are the rules the server will enforce a
// thousand times per match over the life of the server, so being sure
// they're correct is worth the ten minutes of table-driven tests.

func TestCheckWinner_AllEightLines(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name   string
		cells  []int // indices to fill with MarkX
		expect []int
	}{
		{"row 0", []int{0, 1, 2}, []int{0, 1, 2}},
		{"row 1", []int{3, 4, 5}, []int{3, 4, 5}},
		{"row 2", []int{6, 7, 8}, []int{6, 7, 8}},
		{"col 0", []int{0, 3, 6}, []int{0, 3, 6}},
		{"col 1", []int{1, 4, 7}, []int{1, 4, 7}},
		{"col 2", []int{2, 5, 8}, []int{2, 5, 8}},
		{"diag ↘", []int{0, 4, 8}, []int{0, 4, 8}},
		{"diag ↙", []int{2, 4, 6}, []int{2, 4, 6}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var b [9]string
			for _, i := range tc.cells {
				b[i] = MarkX
			}
			mark, line, ok := CheckWinner(b)
			if !ok {
				t.Fatalf("expected a win, got none for cells=%v", tc.cells)
			}
			if mark != MarkX {
				t.Fatalf("expected winner %q, got %q", MarkX, mark)
			}
			if !intSliceEqual(line, tc.expect) {
				t.Fatalf("expected line %v, got %v", tc.expect, line)
			}
		})
	}
}

func TestCheckWinner_NoWin(t *testing.T) {
	t.Parallel()
	cases := map[string][9]string{
		"empty":        {},
		"single mark":  {MarkX},
		"scattered":    {MarkX, MarkX, "", MarkX, MarkO, "", "", MarkO, ""},
		"draw shape":   {MarkX, MarkO, MarkX, MarkX, MarkO, MarkO, MarkO, MarkX, MarkX},
		"two together": {MarkX, MarkX, "", "", "", "", "", "", ""},
	}
	for name, b := range cases {
		t.Run(name, func(t *testing.T) {
			_, _, ok := CheckWinner(b)
			if ok {
				t.Fatalf("did not expect a winner for %q", name)
			}
		})
	}
}

func TestValidateMove_HappyPath(t *testing.T) {
	t.Parallel()
	s := makePlayingState(t)
	if err := ValidateMove(s, "user-x", 4); err != nil {
		t.Fatalf("expected nil, got %v", err)
	}
}

func TestValidateMove_Rejections(t *testing.T) {
	t.Parallel()
	base := makePlayingState(t)

	cases := []struct {
		name       string
		mutate     func(s *MatchState)
		sender     string
		cell       int
		wantSentinel error
	}{
		{
			name:         "wrong status",
			mutate:       func(s *MatchState) { s.Status = StatusWaiting },
			sender:       "user-x",
			cell:         0,
			wantSentinel: ErrNotPlaying,
		},
		{
			name:         "unknown sender",
			mutate:       func(_ *MatchState) {},
			sender:       "ghost",
			cell:         0,
			wantSentinel: ErrUnknownPlayer,
		},
		{
			name:         "out of turn",
			mutate:       func(_ *MatchState) {},
			sender:       "user-o",
			cell:         0,
			wantSentinel: ErrNotYourTurn,
		},
		{
			name:         "cell negative",
			mutate:       func(_ *MatchState) {},
			sender:       "user-x",
			cell:         -1,
			wantSentinel: ErrCellOutRange,
		},
		{
			name:         "cell too high",
			mutate:       func(_ *MatchState) {},
			sender:       "user-x",
			cell:         9,
			wantSentinel: ErrCellOutRange,
		},
		{
			name:         "occupied",
			mutate:       func(s *MatchState) { s.Board[3] = MarkO },
			sender:       "user-x",
			cell:         3,
			wantSentinel: ErrCellOccupied,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := cloneState(base)
			tc.mutate(s)
			err := ValidateMove(s, tc.sender, tc.cell)
			if !errors.Is(err, tc.wantSentinel) {
				t.Fatalf("want %v, got %v", tc.wantSentinel, err)
			}
		})
	}
}

func TestApplyMove_Win(t *testing.T) {
	t.Parallel()
	s := makePlayingState(t)
	// X plays 0, 1, 2 — draws a row.
	s.Board[0] = MarkX
	s.Board[1] = MarkX
	s.MovesCount = 4
	s.TurnMark = MarkX
	finished, reason := ApplyMove(s, 2)
	if !finished || reason != WinReasonLine {
		t.Fatalf("expected line win, got finished=%v reason=%q", finished, reason)
	}
	if s.Winner != "user-x" {
		t.Fatalf("expected winner user-x, got %q", s.Winner)
	}
	if !intSliceEqual(s.WinningLine, []int{0, 1, 2}) {
		t.Fatalf("expected winning line [0,1,2], got %v", s.WinningLine)
	}
	if s.Status != StatusFinished {
		t.Fatalf("expected status finished, got %q", s.Status)
	}
}

func TestApplyMove_Draw(t *testing.T) {
	t.Parallel()
	s := makePlayingState(t)
	// Set up a board with 8 moves, the 9th fills cell 8 without a win.
	// X O X
	// X O O
	// O X _
	s.Board = [9]string{MarkX, MarkO, MarkX, MarkX, MarkO, MarkO, MarkO, MarkX, ""}
	s.MovesCount = 8
	s.TurnMark = MarkX
	finished, reason := ApplyMove(s, 8)
	if !finished || reason != WinReasonDraw {
		t.Fatalf("expected draw, got finished=%v reason=%q", finished, reason)
	}
	if s.Winner != "" {
		t.Fatalf("expected no winner on draw, got %q", s.Winner)
	}
}

func TestApplyMove_FlipsTurn(t *testing.T) {
	t.Parallel()
	s := makePlayingState(t)
	finished, _ := ApplyMove(s, 4)
	if finished {
		t.Fatalf("expected match to continue after single move")
	}
	if s.TurnMark != MarkO {
		t.Fatalf("expected turn to flip to O, got %q", s.TurnMark)
	}
}

// ---- helpers ------------------------------------------------------

func makePlayingState(t *testing.T) *MatchState {
	t.Helper()
	s := NewMatchState("match-1", ModeClassic, nil)
	s.Status = StatusPlaying
	s.TurnMark = MarkX
	s.MarkByUserID = map[string]string{"user-x": MarkX, "user-o": MarkO}
	s.UserIDByMark = map[string]string{MarkX: "user-x", MarkO: "user-o"}
	return s
}

func cloneState(s *MatchState) *MatchState {
	c := *s
	c.Board = s.Board
	c.MarkByUserID = map[string]string{}
	for k, v := range s.MarkByUserID {
		c.MarkByUserID[k] = v
	}
	c.UserIDByMark = map[string]string{}
	for k, v := range s.UserIDByMark {
		c.UserIDByMark[k] = v
	}
	return &c
}

func intSliceEqual(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
