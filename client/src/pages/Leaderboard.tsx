import { useCallback, useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/Button";
import { Rule } from "@/components/ui/Rule";
import { SectionHead } from "@/components/ui/SectionHead";
import { useNakama } from "@/context/NakamaProvider";
import type { LeaderboardEntry, StatsSummary } from "@/types/match";

import styles from "./Leaderboard.module.css";

const LEADERBOARD_ID = "global_wins";
const TOP_N = 10;

/**
 * Leaderboard lists the top players by cumulative wins. The top three
 * sit on a podium (rank 2 / rank 1 / rank 3 in silver-gold-bronze
 * arrangement), and ranks 4–10 fill a compact table below. Each row
 * pairs the authoritative leaderboard record (score = total wins, rank)
 * with the owner's public stats row (streak, per-mode split). The
 * pairing is a single batched storage read so page load stays O(1) in
 * round trips regardless of list size.
 *
 * Empty state: a fresh server with zero finished matches shows a soft
 * "be the first" message rather than an empty table.
 */
export default function Leaderboard() {
  const { client, session, status, reconnectGeneration } = useNakama();
  const [entries, setEntries] = useState<LeaderboardEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reduceMotion = useReducedMotion();

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setError(null);
    try {
      const list = await client.listLeaderboardRecords(
        session,
        LEADERBOARD_ID,
        /*ownerIds*/ undefined,
        TOP_N,
      );
      const records = list.records ?? [];
      if (records.length === 0) {
        setEntries([]);
        return;
      }

      // Pair each record with its stats row. Storage reads of a public row
      // (permission_read=2) don't require ownership, so this single batched
      // request hydrates every row in the list.
      const objectIds = records
        .map((r) => r.owner_id)
        .filter((id): id is string => Boolean(id))
        .map((ownerId) => ({
          collection: "stats",
          key: "summary",
          user_id: ownerId,
        }));
      const statsByOwner = new Map<string, StatsSummary>();
      if (objectIds.length > 0) {
        const statsResp = await client.readStorageObjects(session, {
          object_ids: objectIds,
        });
        // nakama-js hydrates `value` directly into an object (not a JSON
        // string), so no parse step is required here.
        for (const obj of statsResp.objects ?? []) {
          if (!obj.user_id || !obj.value) continue;
          statsByOwner.set(obj.user_id, obj.value as StatsSummary);
        }
      }

      const rows: LeaderboardEntry[] = records.map((r, idx) => ({
        ownerId: r.owner_id ?? "",
        username: r.username || shortenId(r.owner_id),
        rank: r.rank ?? idx + 1,
        wins: r.score ?? 0,
        stats: r.owner_id ? (statsByOwner.get(r.owner_id) ?? null) : null,
      }));
      setEntries(rows);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Couldn't load the leaderboard.",
      );
    } finally {
      setLoading(false);
    }
  }, [client, session]);

  // Initial load and refetch after every reconnect. Keeps the view live
  // after a laptop wakes from sleep without a manual refresh.
  useEffect(() => {
    if (status !== "ready") return;
    void load();
  }, [status, reconnectGeneration, load]);

  const podium = entries ? entries.slice(0, 3) : [];
  const rest = entries ? entries.slice(3) : [];

  return (
    <main className={`app-shell ${styles.screen}`}>
      <header className={styles.masthead}>
        <SectionHead numeral="I" eyebrow="Top of the board" title="Leaderboard" />
        <p className={styles.subtitle}>
          The top players by cumulative wins. Draws don&rsquo;t count;
          streaks reset on a loss. Refreshes automatically whenever you
          reconnect.
        </p>
        <div className={styles.actions}>
          <Link to="/" className={styles.backLink}>
            ← Back to lobby
          </Link>
          <Button variant="ghost" size="md" onClick={load} loading={loading}>
            Refresh
          </Button>
        </div>
      </header>

      {error ? (
        <section className={styles.card} aria-label="Top players">
          <p role="alert" className={styles.stateMessage}>
            {error}
          </p>
        </section>
      ) : entries === null ? (
        <section className={styles.card} aria-label="Top players">
          <p className={styles.stateMessage}>Loading the top ten…</p>
        </section>
      ) : entries.length === 0 ? (
        <section className={styles.card} aria-label="Top players">
          <EmptyState />
        </section>
      ) : (
        <>
          <Podium entries={podium} reduceMotion={!!reduceMotion} />
          {rest.length > 0 ? (
            <section className={styles.card} aria-label="Ranks four to ten">
              <header className={styles.cardHead}>
                <span className={styles.cardTitle}>The chasing pack</span>
                <span className={styles.cardTail}>
                  ranks 4–{3 + rest.length}
                </span>
              </header>
              <Table rows={rest} />
            </section>
          ) : null}
        </>
      )}

      <Rule />
    </main>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Top-3 cards. Arranged silver-gold-bronze on desktop by placing rank 1
 * in the center column via the DOM order [2, 1, 3]. Stagger is ordered
 * smallest-first so the champion lands last and the eye comes to rest
 * on them.
 */
function Podium({
  entries,
  reduceMotion,
}: {
  entries: LeaderboardEntry[];
  reduceMotion: boolean;
}) {
  const byRank = new Map<number, LeaderboardEntry>();
  entries.forEach((e, idx) => byRank.set(e.rank ?? idx + 1, e));
  const first = byRank.get(1) ?? entries[0];
  const second = byRank.get(2) ?? entries[1];
  const third = byRank.get(3) ?? entries[2];
  const ordered: Array<[LeaderboardEntry | undefined, boolean, number]> = [
    [second, false, 0.06],
    [first, true, 0.18],
    [third, false, 0.12],
  ];

  return (
    <div className={styles.podium}>
      {ordered.map(([entry, isGold, delay], idx) =>
        entry ? (
          <PodiumCard
            key={entry.ownerId || idx}
            entry={entry}
            gold={isGold}
            delay={reduceMotion ? 0 : delay}
          />
        ) : (
          <div key={idx} aria-hidden />
        ),
      )}
    </div>
  );
}

function PodiumCard({
  entry,
  gold,
  delay,
}: {
  entry: LeaderboardEntry;
  gold: boolean;
  delay: number;
}) {
  const anim = {
    initial: { opacity: 0, y: 12 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.32, delay, ease: [0.2, 0.8, 0.2, 1] as const },
  };
  return (
    <motion.article
      className={`${styles.podiumCard} ${gold ? styles.podiumGold : ""}`}
      {...anim}
    >
      <span className={`${styles.podiumRank} ${gold ? styles.podiumRankGold : ""}`}>
        {formatRank(entry.rank)}
      </span>
      <span
        className={`${styles.podiumMonogram} ${gold ? styles.podiumMonogramGold : ""}`}
        aria-hidden
      >
        {monogramOf(entry.username)}
      </span>
      <span className={styles.podiumName} title={entry.username}>
        {entry.username}
      </span>
      <span className={styles.podiumWinsLabel}>Wins</span>
      <span className={styles.podiumWins}>{entry.wins}</span>
      <span className={styles.podiumStreak}>
        streak {entry.stats?.currentStreak ?? 0} · best {entry.stats?.bestStreak ?? 0}
      </span>
    </motion.article>
  );
}

function Table({ rows }: { rows: LeaderboardEntry[] }) {
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th scope="col" className={styles.rankCol}>
            #
          </th>
          <th scope="col">Player</th>
          <th scope="col" className={styles.numCol}>
            Wins
          </th>
          <th scope="col" className={styles.numCol}>
            Streak
          </th>
          <th scope="col" className={styles.numCol}>
            Best
          </th>
          <th scope="col" className={styles.splitCol}>
            Classic / Timed
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((entry) => (
          <tr key={entry.ownerId} className={styles.row}>
            <td className={styles.rank}>{entry.rank}</td>
            <td>
              <span className={styles.playerCell}>
                <span className={styles.monogram} aria-hidden>
                  {monogramOf(entry.username)}
                </span>
                <span className={styles.playerName}>{entry.username}</span>
              </span>
            </td>
            <td className={`${styles.num} ${styles.numBold}`}>{entry.wins}</td>
            <td className={styles.num}>{entry.stats?.currentStreak ?? "—"}</td>
            <td className={styles.num}>{entry.stats?.bestStreak ?? "—"}</td>
            <td className={styles.split}>
              {entry.stats
                ? `${entry.stats.classicWins} / ${entry.stats.timedWins}`
                : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EmptyState() {
  return (
    <div className={styles.empty}>
      <svg
        viewBox="0 0 120 120"
        className={styles.emptyMark}
        role="img"
        aria-hidden
      >
        {[0, 1, 2].flatMap((row) =>
          [0, 1, 2].map((col) => (
            <rect
              key={`${row}-${col}`}
              x={col * 40 + 4}
              y={row * 40 + 4}
              width={32}
              height={32}
              rx={6}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
            />
          )),
        )}
      </svg>
      <span className={styles.emptyEyebrow}>Nobody yet</span>
      <p className={styles.emptyTitle}>Be the first to claim a win.</p>
      <p className={styles.emptyLead}>
        The leaderboard fills in the moment a match ends decisively.
      </p>
      <Link to="/" className={styles.emptyLink}>
        Go play a match →
      </Link>
    </div>
  );
}

/**
 * Fallback when a leaderboard record has no username (shouldn't happen
 * in practice because Nakama auto-snapshots it on write, but defensive
 * against future seeding / migration). Shows a short prefix rather than
 * a full userId so the row still reads naturally.
 */
function shortenId(id: string | undefined): string {
  if (!id) return "Anonymous";
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function monogramOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "·";
  const first = trimmed[0];
  return first ? first.toUpperCase() : "·";
}

function formatRank(rank: number | undefined): string {
  if (!rank) return "—";
  return `#${rank}`;
}
