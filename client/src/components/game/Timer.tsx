import { useEffect, useState } from "react";

import styles from "./Timer.module.css";

interface TimerProps {
  deadlineMs: number;
  turnSeconds: number;
}

// Display-only; OpMatchEnded from the server is the sole authority on forfeit.
export function Timer({ deadlineMs, turnSeconds }: TimerProps) {
  const [remaining, setRemaining] = useState(() => Math.max(0, deadlineMs - Date.now()));

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setRemaining(Math.max(0, deadlineMs - Date.now()));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [deadlineMs]);

  const seconds = Math.ceil(remaining / 1000);
  const ratio = Math.max(0, Math.min(1, remaining / (turnSeconds * 1000)));
  const danger = seconds <= 10;

  return (
    <div
      className={`${styles.timer} ${danger ? styles.timerDanger : ""}`}
      role="timer"
      aria-live={danger ? "polite" : "off"}
    >
      <span>{String(seconds).padStart(2, "0")}s</span>
      <span className={styles.bar} aria-hidden>
        <span className={styles.barFill} style={{ transform: `scaleX(${ratio})` }} />
      </span>
    </div>
  );
}
