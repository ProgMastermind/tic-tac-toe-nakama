import { useEffect } from "react";
import confetti from "canvas-confetti";

import { Button } from "@/components/ui/Button";
import { useStats } from "@/hooks/useStats";
import type { Mark, MatchEndedMessage, MatchStateMessage } from "@/types/match";

import styles from "./EndOverlay.module.css";

interface EndOverlayProps {
  state: MatchStateMessage;
  end: MatchEndedMessage;
  myUserId: string | null;
  onBackToLobby(): void;
  onPlayAgain?(): void;
}

/**
 * End-of-match overlay. Derives "did I win" from the server's winner
 * field (never derives anything from the board locally). Confetti fires
 * once on mount for the winner only — losing and drawing stay quiet.
 * Refreshes the stats hook on mount so the "Your record" echo shows the
 * counts including this match.
 */
export function EndOverlay({
  state,
  end,
  myUserId,
  onBackToLobby,
  onPlayAgain,
}: EndOverlayProps) {
  const { stats, refresh } = useStats();
  const winnerUserId = end.winner ?? state.winner ?? "";
  const isDraw = !winnerUserId;
  const isWin = !!myUserId && winnerUserId === myUserId;
  const winnerName = winnerUserId ? state.usernames[winnerUserId] ?? "Winner" : "";
  const winnerMark: Mark | null =
    (winnerUserId && (state.markByUserId[winnerUserId] as Mark)) || null;

  // Re-pull the record so the echo reflects this match. The server writes
  // stats in the same tick as OpMatchEnded, so by the time we mount the
  // row on disk is already updated.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!isWin) return;
    // Keep the celebration brief and considered — two small bursts that
    // fade instead of a firehose so the page stays elegant.
    const burst = (origin: { x: number; y: number }) => {
      confetti({
        particleCount: 36,
        startVelocity: 30,
        spread: 55,
        ticks: 160,
        origin,
        colors: ["#B2342C", "#11110F", "#FAFAF7"],
        scalar: 0.9,
        disableForReducedMotion: true,
      });
    };
    burst({ x: 0.2, y: 0.35 });
    setTimeout(() => burst({ x: 0.8, y: 0.35 }), 180);
  }, [isWin]);

  const eyebrow = isDraw ? "A tie" : isWin ? "You won" : "Well played";

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true">
      <div className={styles.card}>
        <span className={styles.eyebrow}>{eyebrow}</span>
        <h2 className={styles.title}>{headline(end, isWin, isDraw, winnerName, winnerMark)}</h2>
        <p className={styles.body}>{bodyCopy(end)}</p>

        <dl className={styles.record} aria-label="Your record">
          <div className={styles.recordItem}>
            <dt>W / L / D</dt>
            <dd>
              <span className={styles.recordStrong}>{stats.wins}</span>
              <span className={styles.recordSep}> · </span>
              {stats.losses}
              <span className={styles.recordSep}> · </span>
              {stats.draws}
            </dd>
          </div>
          <div className={styles.recordDivider} aria-hidden />
          <div className={styles.recordItem}>
            <dt>Streak</dt>
            <dd>
              <span
                className={`${styles.recordStrong} ${stats.currentStreak > 0 ? styles.recordAccent : ""}`}
              >
                {stats.currentStreak}
              </span>
              <span className={styles.recordSep}> / </span>
              {stats.bestStreak}
            </dd>
          </div>
        </dl>

        <div className={styles.actions}>
          {onPlayAgain ? (
            <Button onClick={onPlayAgain} size="md">
              Play again
            </Button>
          ) : null}
          <Button
            onClick={onBackToLobby}
            size="md"
            variant={onPlayAgain ? "secondary" : "primary"}
          >
            Back to lobby
          </Button>
        </div>
      </div>
    </div>
  );
}

function headline(
  end: MatchEndedMessage,
  isWin: boolean,
  isDraw: boolean,
  winnerName: string,
  winnerMark: Mark | null,
): React.ReactNode {
  if (isDraw) return <>All nine, no winner.</>;
  if (isWin) return <>The board is <span className={styles.italic}>yours.</span></>;
  const trailing = winnerMark ? `(${winnerMark})` : "";
  if (end.reason === "timeout") return `${winnerName} ${trailing} — you ran out of time.`.trim();
  if (end.reason === "forfeit") return `${winnerName} ${trailing} wins on forfeit.`.trim();
  if (end.reason === "abandoned") return `The match never quite got going.`;
  return `${winnerName} ${trailing} takes it.`.trim();
}

function bodyCopy(end: MatchEndedMessage): string {
  switch (end.reason) {
    case "timeout":
      return "Turn timers are strict — the server forfeits anyone who lingers.";
    case "forfeit":
      return "An opponent dropped out long enough to forfeit. Happens.";
    case "abandoned":
      return "Nobody joined in time. Try opening a fresh room.";
    case "draw":
      return "Eleven moves in a rectangle. We'll call it a draw.";
    case "line":
    default:
      return "Three in a row. Rematch is one click away in the lobby.";
  }
}
