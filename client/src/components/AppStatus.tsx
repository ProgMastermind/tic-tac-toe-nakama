import { useEffect, useState } from "react";

import styles from "./AppStatus.module.css";

// Suppress the splash on fast connects — if the socket attaches within
// 250ms (warm cache, persisted session) the user never sees it at all.
const SPLASH_REVEAL_MS = 250;

export function Connecting() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), SPLASH_REVEAL_MS);
    return () => clearTimeout(t);
  }, []);
  if (!visible) return null;
  return (
    <div className={styles.wrap} role="status" aria-live="polite">
      <div className={styles.inner}>
        <span className={styles.pulse} aria-hidden />
        <h1 className={styles.title}>Finding the server</h1>
        <p className={styles.body}>
          Signing you in and opening a socket. This usually takes a breath.
        </p>
      </div>
    </div>
  );
}

export function ConnectionError({ message }: { message: string }) {
  return (
    <div className={styles.wrap} role="alert">
      <div className={styles.inner}>
        <h1 className={styles.title}>Can&rsquo;t reach the game server</h1>
        <p className={styles.body}>{message}</p>
        <button
          type="button"
          className={styles.retry}
          onClick={() => window.location.reload()}
        >
          Try again
        </button>
      </div>
    </div>
  );
}
