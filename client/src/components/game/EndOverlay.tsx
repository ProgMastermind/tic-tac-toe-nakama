import { useEffect } from "react";
import confetti from "canvas-confetti";

import { Button } from "@/components/ui/Button";
import type { Mark, MatchEndedMessage, MatchStateMessage } from "@/types/match";

import styles from "./EndOverlay.module.css";

interface EndOverlayProps {
  state: MatchStateMessage;
  end: MatchEndedMessage;
  myUserId: string | null;
  onBackToLobby(): void;
}

/**
 * End-of-match overlay. Derives "did I win" from the server's winner
 * field (never derives anything from the board locally). Confetti fires
 * once on mount for the winner only — losing and drawing stay quiet.
 */
export function EndOverlay({ state, end, myUserId, onBackToLobby }: EndOverlayProps) {
  const winnerUserId = end.winner ?? state.winner ?? "";
  const isDraw = !winnerUserId;
  const isWin = !!myUserId && winnerUserId === myUserId;
  const winnerName = winnerUserId ? state.usernames[winnerUserId] ?? "Winner" : "";
  const winnerMark: Mark | null =
    (winnerUserId && (state.markByUserId[winnerUserId] as Mark)) || null;

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
        <div className={styles.actions}>
          <Button onClick={onBackToLobby} size="md">
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
