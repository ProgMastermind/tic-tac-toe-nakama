import type { Mark } from "@/types/match";

import styles from "./PlayerBadge.module.css";

interface PlayerBadgeProps {
  mark: Mark;
  name: string;
  isSelf: boolean;
  active: boolean;
}

export function PlayerBadge({ mark, name, isSelf, active }: PlayerBadgeProps) {
  const rootClass = `${styles.badge} ${active ? styles.badgeActive : ""} ${
    mark === "O" ? styles.badgeO : styles.badgeX
  }`;
  return (
    <div className={rootClass} aria-current={active ? "true" : undefined}>
      <PlayerMark mark={mark} />
      <div className={styles.meta}>
        <span className={styles.name}>
          {name || "Opponent"}
          {isSelf ? <span className={styles.self}> (you)</span> : null}
        </span>
        <span className={`${styles.sub} ${active ? styles.subActive : ""}`}>
          {active ? (
            <>
              <span className={styles.pulse} aria-hidden />
              thinking…
            </>
          ) : (
            "waiting"
          )}
        </span>
      </div>
    </div>
  );
}

function PlayerMark({ mark }: { mark: Mark }) {
  return (
    <span className={`${styles.mark} ${mark === "O" ? styles.markO : styles.markX}`}>
      <svg viewBox="0 0 100 100" role="img" aria-label={mark}>
        {mark === "X" ? (
          <>
            <path d="M22 22 L78 78" className={styles.markStroke} />
            <path d="M78 22 L22 78" className={styles.markStroke} />
          </>
        ) : (
          <circle cx="50" cy="50" r="28" className={styles.markStroke} />
        )}
      </svg>
    </span>
  );
}

interface PlayerRowProps {
  left: PlayerBadgeProps;
  right: PlayerBadgeProps;
}

export function PlayerRow({ left, right }: PlayerRowProps) {
  return (
    <div className={styles.row}>
      <PlayerBadge {...left} />
      <span className={styles.vs} aria-hidden>
        vs
      </span>
      <PlayerBadge {...right} />
    </div>
  );
}
