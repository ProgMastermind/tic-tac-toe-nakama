import type { Mark } from "@/types/match";

import styles from "./PlayerBadge.module.css";

interface PlayerBadgeProps {
  mark: Mark;
  name: string;
  isSelf: boolean;
  active: boolean;
}

export function PlayerBadge({ mark, name, isSelf, active }: PlayerBadgeProps) {
  return (
    <div
      className={`${styles.badge} ${active ? styles.badgeActive : ""}`}
      aria-current={active ? "true" : undefined}
    >
      <span className={`${styles.mark} ${mark === "O" ? styles.markO : ""}`}>{mark}</span>
      <div className={styles.meta}>
        <span className={styles.name}>
          {name || "Opponent"} {isSelf ? "(you)" : ""}
        </span>
        <span className={`${styles.sub} ${active ? styles.subActive : ""}`}>
          {active ? "thinking…" : "waiting"}
        </span>
      </div>
    </div>
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
      <span className={styles.vs}>vs</span>
      <PlayerBadge {...right} />
    </div>
  );
}
