import styles from "./Home.module.css";

// Placeholder home screen so the scaffold renders something deliberate
// while the Nakama client and RPC flows are wired in follow-up commits.
// The layout and copy land NOW because they drive the visual language
// the rest of the UI will inherit.
export default function Home() {
  return (
    <main className={`app-shell ${styles.screen}`}>
      <header className={styles.masthead}>
        <span className={`eyebrow ${styles.eyebrow}`}>
          <span className={styles.eyebrowDot} aria-hidden />
          A classic, reimagined
        </span>
        <h1 className={styles.title}>
          Tic tac toe,
          <br />
          <span className={styles.titleItalic}>played properly.</span>
        </h1>
        <p className={styles.subtitle}>
          A two-player board game where every move is validated on the
          server. No turns stolen, no cells overwritten, no races won by
          tab-mashing. Just a well-kept ruleset and a friend.
        </p>
      </header>

      <section className={styles.card} aria-label="Start playing">
        <h2 className={styles.cardTitle}>Ready when you are</h2>
        <p className={styles.cardBody}>
          The match flow lands in the next step — pick a mode, create a
          private room, or drop a friend&rsquo;s code. This card will grow
          into the lobby.
        </p>
      </section>

      <footer className={styles.footer}>
        <span>© Tic Tac Toe · Nakama authoritative backend</span>
        <span className={styles.statusDot}>
          <span className={styles.statusDotMark} data-state="pending" />
          client idle
        </span>
      </footer>
    </main>
  );
}
