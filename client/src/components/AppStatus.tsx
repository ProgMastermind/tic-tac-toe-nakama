import styles from "./AppStatus.module.css";

// AppStatus renders a quiet full-screen indicator while NakamaProvider is
// connecting, or a retry prompt if the connection failed. Kept here rather
// than inside NakamaProvider so routing / app shell concerns do not leak
// into the connection logic.

export function Connecting() {
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
