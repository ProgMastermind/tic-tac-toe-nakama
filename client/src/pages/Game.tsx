import { useCallback, useEffect, useMemo, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { Board } from "@/components/game/Board";
import { EndOverlay } from "@/components/game/EndOverlay";
import { PlayerRow } from "@/components/game/PlayerBadge";
import { Timer } from "@/components/game/Timer";
import { Rule } from "@/components/ui/Rule";
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
  const reduceMotion = useReducedMotion();

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

  const isTimed = state?.mode === "timed";
  const modeLabel = isTimed ? "Timed · 30s" : "Classic";

  // Shared topbar so the breadcrumb stays consistent across waiting,
  // playing, and finished states.
  const topbar = (
    <div className={styles.topbar}>
      <nav className={styles.crumbs} aria-label="Breadcrumb">
        <button type="button" className={styles.crumbBack} onClick={onBackToLobby}>
          ← Lobby
        </button>
        <span className={styles.crumbSep} aria-hidden>
          /
        </span>
        <span className={styles.crumbCurrent}>
          Match
          <span
            className={`${styles.modeChip} ${isTimed ? styles.modeChipTimed : ""}`}
            style={{ marginLeft: "var(--space-3)" }}
          >
            {modeLabel}
          </span>
        </span>
      </nav>

      {codeFromLobby ? (
        <span className={styles.roomCode} aria-live="polite">
          <span className="mono">{codeFromLobby}</span>
          <button type="button" onClick={copyCode}>
            {copied ? "copied" : "copy"}
          </button>
        </span>
      ) : null}
    </div>
  );

  const enterAnim = reduceMotion
    ? { initial: false, animate: { opacity: 1, y: 0 } }
    : {
        initial: { opacity: 0, y: 6 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.24, ease: [0.2, 0.8, 0.2, 1] as const },
      };

  // Before the first state update, show the same connecting shell — but
  // keep the back button available so users are never stuck.
  if (!joined || !state) {
    return (
      <main className={`app-shell ${styles.screen}`}>
        {topbar}
        <Rule />
        <motion.section className={styles.stage} {...enterAnim}>
          <WaitingState
            title="Opening the room…"
            body="Joining the match and syncing state."
          />
        </motion.section>
      </main>
    );
  }

  const isMyTurn = !!myMark && state.status === "playing" && state.turnMark === myMark;
  const showTimer = isTimed && state.status === "playing" && !!state.turnDeadlineMs;
  const isWaiting = state.status === "waiting";
  const isFinished = state.status === "finished";

  return (
    <main className={`app-shell ${styles.screen}`}>
      {topbar}
      <Rule />

      <motion.section className={styles.stage} {...enterAnim}>
        {isWaiting ? (
          <WaitingState
            title="Waiting on the other player"
            body={
              codeFromLobby
                ? "Share the code below. The match starts the second they join."
                : "Hold tight — the opponent hasn't joined yet."
            }
            {...(codeFromLobby ? { code: codeFromLobby } : {})}
          />
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
      </motion.section>
    </main>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Shared empty/loading state. The ghost board is a faint SVG that
 * echoes the real grid so the wait reads as intentional framing rather
 * than a missing component. One cell softly pulses a mark in accent to
 * hint at the board coming online.
 */
function WaitingState({
  title,
  body,
  code,
}: {
  title: string;
  body: string;
  code?: string;
}) {
  return (
    <div className={styles.waitingState}>
      <GhostBoard />
      <h2 className={styles.waitingTitle}>{title}</h2>
      <p className={styles.waitingBody}>{body}</p>
      {code ? <span className={styles.waitingCode}>{code}</span> : null}
    </div>
  );
}

function GhostBoard() {
  return (
    <svg
      viewBox="0 0 120 120"
      className={styles.ghostBoard}
      role="img"
      aria-hidden
    >
      {[0, 1, 2].flatMap((row) =>
        [0, 1, 2].map((col) => (
          <rect
            key={`${row}-${col}`}
            x={col * 40 + 4}
            y={row * 40 + 4}
            width={32}
            height={32}
            rx={6}
            className={styles.ghostCell}
          />
        )),
      )}
      {/* Accent mark inside the center cell — a quiet O that breathes. */}
      <circle cx="60" cy="60" r="10" className={styles.ghostMark} />
    </svg>
  );
}
