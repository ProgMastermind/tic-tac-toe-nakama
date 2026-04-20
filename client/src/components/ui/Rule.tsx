import styles from "./Rule.module.css";

interface RuleProps {
  variant?: "single" | "double";
  label?: string;
  className?: string;
}

/**
 * Horizontal hairline divider. With a label, renders as a centered chip
 * flanked by two rules (the editorial "or play with a friend" treatment).
 * Without, a plain <hr>. `variant="double"` stacks two hairlines with a
 * thin gap for a heavier break.
 */
export function Rule({ variant = "single", label, className }: RuleProps) {
  const base = `${styles.rule} ${variant === "double" ? styles.double : ""} ${className ?? ""}`.trim();
  if (label) {
    return (
      <div className={`${base} ${styles.labeled}`} role="separator" aria-orientation="horizontal">
        <span className={styles.label}>{label}</span>
      </div>
    );
  }
  return <hr className={base} />;
}
