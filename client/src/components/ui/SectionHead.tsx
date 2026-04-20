import type { ReactNode } from "react";

import styles from "./SectionHead.module.css";

type Numeral = "I" | "II" | "III" | "IV" | "V";

interface SectionHeadProps {
  numeral?: Numeral;
  eyebrow: string;
  title?: ReactNode;
  rule?: boolean;
  align?: "start" | "center";
  className?: string;
}

/**
 * Editorial section head: tiny Roman numeral in mono caps, an eyebrow
 * label, optional display title, optional hairline rule underneath.
 * Drops in wherever a page section used to hand-roll its own eyebrow.
 */
export function SectionHead({
  numeral,
  eyebrow,
  title,
  rule = false,
  align = "start",
  className,
}: SectionHeadProps) {
  const cls = `${styles.head} ${styles[`align_${align}`]} ${className ?? ""}`.trim();
  return (
    <header className={cls}>
      <div className={styles.topRow}>
        {numeral ? (
          <span className={styles.numeral} aria-hidden>
            {numeral}
          </span>
        ) : null}
        <span className={styles.eyebrow}>{eyebrow}</span>
      </div>
      {title ? <h2 className={styles.title}>{title}</h2> : null}
      {rule ? <span className={styles.rule} aria-hidden /> : null}
    </header>
  );
}
