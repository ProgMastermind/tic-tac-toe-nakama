import type { GameMode } from "@/types/match";

import styles from "./ModeToggle.module.css";

interface ModeToggleProps {
  value: GameMode;
  onChange(next: GameMode): void;
  disabled?: boolean;
}

/**
 * Segmented control for selecting between the two game modes. Copy is
 * carefully chosen — "Classic" stays neutral, "Timed" gets a brief
 * 30s-per-turn annotation so players know what they're signing up for.
 */
export function ModeToggle({ value, onChange, disabled }: ModeToggleProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Game mode"
      className={styles.root}
      aria-disabled={disabled || undefined}
    >
      <span
        aria-hidden
        className={`${styles.thumb} ${value === "timed" ? styles.thumbRight : ""}`}
      />
      <button
        type="button"
        role="radio"
        aria-checked={value === "classic"}
        disabled={disabled}
        onClick={() => onChange("classic")}
        className={`${styles.option} ${value === "classic" ? styles.optionActive : ""}`}
      >
        Classic
        <span className={styles.sub}>take your time</span>
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={value === "timed"}
        disabled={disabled}
        onClick={() => onChange("timed")}
        className={`${styles.option} ${value === "timed" ? styles.optionActive : ""}`}
      >
        Timed
        <span className={styles.sub}>30s per turn</span>
      </button>
    </div>
  );
}
