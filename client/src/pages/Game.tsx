import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { Board } from "@/components/game/Board";
import { EndOverlay } from "@/components/game/EndOverlay";
import { PlayerRow } from "@/components/game/PlayerBadge";
import { Timer } from "@/components/game/Timer";
import { Button } from "@/components/ui/Button";
import { useMatch } from "@/hooks/useMatch";
import type { Mark } from "@/types/match";

import styles from "./Game.module.css";

// Matches TurnSeconds in the Go handler. If the server changes, this
// stays a visual concern only — the forfeit is decided server-side.
const TURN_SECONDS = 30;

export default function Game() {
  const { matchId } = useParams<{ matchId: string }>();
  const [searchParams] = useSearchParams();
  const codeFromLobby = searchParams.get("code") ?? "";
  // Matchmaker-origin matches arrive with a short-lived `t` token in the
  // URL. useMatch uses it on its single initial joinMatch call. On
  // reload / rehydrate there is no token but the user is a known
  // presence so the server accepts the join as a reconnect.
  const matchmakerToken = searchParams.get("t") ?? undefined;
  const navigate = useNavigate();

  const { state, myUserId, myMark, endReason, pendingError, joined, makeMove, leave } =
    useMatch(matchId, matchmakerToken);

  const [copied, setCopied] = useState(false);

  const onBackToLobby = useCallback(async () => {
    try {
      await leave();
    } finally {
      navigate("/");
    }
  }, [leave, navigate]);

  // Copy the room code to the clipboard for the creator's convenience.
  const copyCode = useCallback(async () => {
    if (!codeFromLobby) return;
    try {
      await navigator.clipboard.writeText(codeFromLobby);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }, [codeFromLobby]);

  // Reset "copied" indicator after a moment so the chip doesn't lie
  // forever once the user has stopped paying attention to it.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);

  // Build the pair of player rows. The current player is always shown on
  // the left for a stable mental model.
  const players = useMemo(() => {
    if (!state) return null;
    const xId = state.userIdByMark.X ?? "";
    const oId = state.userIdByMark.O ?? "";
    const mkProps = (mark: Mark, uid: string, turnMark: string) => ({
      mark,
      name: state.usernames[uid] ?? "",
      isSelf: !!uid && uid === myUserId,
      active: state.status === "playing" && turnMark === mark,
    });
    const selfIsX = myMark === "X";
    const leftMark: Mark = selfIsX ? "X" : "O";
    const rightMark: Mark = selfIsX ? "O" : "X";
    const leftId = selfIsX ? xId : oId;
    const rightId = selfIsX ? oId : xId;
    return {
      left: mkProps(leftMark, leftId, state.turnMark ?? ""),
      right: mkProps(rightMark, rightId, state.turnMark ?? ""),
    };
  }, [state, myUserId, myMark]);

  if (!matchId) {
    navigate("/", { replace: true });
    return null;
  }

  // Before the first state update, show the same connecting shell — but
  // keep the back button available so users are never stuck.
  if (!joined || !state) {
    return (
      <main className={`app-shell ${styles.screen}`}>
        <div className={styles.topbar}>
          <div className={styles.backRow}>
            <Button variant="ghost" size="sm" onClick={onBackToLobby}>
              ← Lobby
            </Button>
          </div>
        </div>
        <div className={styles.stage}>
          <div className={styles.waitingState}>
            <h2 className={styles.waitingTitle}>Opening the room…</h2>
            <p className={styles.waitingBody}>Joining the match and syncing state.</p>
          </div>
        </div>
      </main>
    );
  }

  const isMyTurn = !!myMark && state.status === "playing" && state.turnMark === myMark;
  const isTimed = state.mode === "timed";
  const showTimer = isTimed && state.status === "playing" && !!state.turnDeadlineMs;
  const isWaiting = state.status === "waiting";
  const isFinished = state.status === "finished";

  return (
    <main className={`app-shell ${styles.screen}`}>
      <div className={styles.topbar}>
        <div className={styles.backRow}>
          <Button variant="ghost" size="sm" onClick={onBackToLobby}>
            ← Lobby
          </Button>
          <span
            className={`${styles.modeChip} ${isTimed ? styles.modeChipTimed : ""}`}
          >
            {isTimed ? "Timed · 30s" : "Classic"}
          </span>
        </div>

        {codeFromLobby ? (
          <span className={styles.roomCode} aria-live="polite">
            <span className="mono">{codeFromLobby}</span>
            <button type="button" onClick={copyCode}>
              {copied ? "copied" : "copy"}
            </button>
          </span>
        ) : null}
      </div>

      <section className={styles.stage}>
        {isWaiting ? (
          <div className={styles.waitingState}>
            <h2 className={styles.waitingTitle}>Waiting on the other player</h2>
            <p className={styles.waitingBody}>
              {codeFromLobby
                ? "Share the code below. The match starts the second they join."
                : "Hold tight — the opponent hasn't joined yet."}
            </p>
            {codeFromLobby ? (
              <span className={styles.waitingCode}>{codeFromLobby}</span>
            ) : null}
          </div>
        ) : (
          <>
            {players ? <PlayerRow left={players.left} right={players.right} /> : null}

            <div className={styles.statusRow}>
              <span className={styles.statusLabel}>
                {isFinished ? (
                  "Match finished"
                ) : isMyTurn ? (
                  <>
                    <span className={styles.statusLabelStrong}>Your move</span>
                    {" — "} place an {myMark}.
                  </>
                ) : (
                  `Opponent is thinking.`
                )}
              </span>

              {showTimer && state.turnDeadlineMs ? (
                <Timer deadlineMs={state.turnDeadlineMs} turnSeconds={TURN_SECONDS} />
              ) : null}

              {pendingError ? (
                <span role="alert" className={styles.errorToast}>
                  {pendingError.message}
                </span>
              ) : null}
            </div>

            <Board
              state={state}
              interactive={isMyTurn && !isFinished}
              onPlay={(cell) => {
                makeMove(cell).catch(() => {
                  // Errors from the socket are rare; the server-echoed
                  // OpError provides the per-rule validation messages.
                });
              }}
            />
          </>
        )}

        {isFinished && endReason ? (
          <EndOverlay
            state={state}
            end={endReason}
            myUserId={myUserId}
            onBackToLobby={onBackToLobby}
          />
        ) : null}
      </section>
    </main>
  );
}
