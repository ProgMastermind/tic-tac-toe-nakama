import styles from "./Wordmark.module.css";

interface WordmarkProps {
  size?: "sm" | "md" | "lg";
  variant?: "full" | "mark";
  className?: string;
}

/**
 * A compact brand lockup: a 3×3 dot grid (echoing the board) beside the
 * wordmark in Fraunces with the closing syllable italicised. Used as the
 * masthead anchor on every page, and on its own in footers.
 */
export function Wordmark({ size = "md", variant = "full", className }: WordmarkProps) {
  const rootClass = `${styles.root} ${styles[`size_${size}`]} ${className ?? ""}`;
  return (
    <span className={rootClass.trim()} aria-label="Tic Tac Toe">
      <svg
        className={styles.mark}
        viewBox="0 0 24 24"
        role="img"
        aria-hidden
        focusable="false"
      >
        {[0, 1, 2].flatMap((row) =>
          [0, 1, 2].map((col) => {
            const isCenter = row === 1 && col === 1;
            return (
              <circle
                key={`${row}-${col}`}
                cx={4 + col * 8}
                cy={4 + row * 8}
                r={1.8}
                className={isCenter ? styles.dotAccent : styles.dot}
              />
            );
          }),
        )}
      </svg>
      {variant === "full" ? (
        <span className={styles.word}>
          Tic Tac <span className={styles.wordItalic}>Toe</span>
        </span>
      ) : null}
    </span>
  );
}
