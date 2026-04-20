import type { Mark } from "@/types/match";

import styles from "./Cell.module.css";

interface CellProps {
  index: number;
  mark: string;
  interactive: boolean;
  winning: boolean;
  onPlay(index: number): void;
}

export function Cell({ index, mark, interactive, winning, onPlay }: CellProps) {
  const empty = mark === "";
  const disabled = !interactive || !empty;

  const classes = [
    styles.cell,
    disabled ? styles.cellDisabled : "",
    interactive && empty ? styles.cellInteractive : "",
    winning ? styles.cellWinning : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type="button"
      className={classes}
      disabled={disabled}
      aria-label={`Cell ${index + 1}${mark ? `, ${mark}` : ""}`}
      onClick={() => interactive && empty && onPlay(index)}
    >
      {mark ? <MarkSvg mark={mark as Mark} /> : null}
    </button>
  );
}

function MarkSvg({ mark }: { mark: Mark }) {
  return (
    <svg
      viewBox="0 0 100 100"
      className={`${styles.mark} ${mark === "X" ? styles.markX : styles.markO}`}
      role="img"
      aria-label={mark}
    >
      {mark === "X" ? (
        <>
          <path d="M20 20 L80 80" className={styles.markStroke} />
          <path d="M80 20 L20 80" className={styles.markStroke} />
        </>
      ) : (
        <circle
          cx="50"
          cy="50"
          r="30"
          className={styles.markStroke}
          style={{ strokeDasharray: 200, strokeDashoffset: 200 }}
        />
      )}
    </svg>
  );
}
