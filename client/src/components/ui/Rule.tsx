import styles from "./Rule.module.css";

interface RuleProps {
  variant?: "single" | "double";
  label?: string;
  className?: string;
}

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
