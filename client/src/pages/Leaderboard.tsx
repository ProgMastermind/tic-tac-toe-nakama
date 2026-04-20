import { useCallback, useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/Button";
import { useNakama } from "@/context/NakamaProvider";
import type { LeaderboardEntry, StatsSummary } from "@/types/match";

import styles from "./Leaderboard.module.css";

const LEADERBOARD_ID = "global_wins";
const TOP_N = 10;

/**
 * Leaderboard lists the top players by cumulative wins as a single
 * ranked list. Rank 1 gets a subtle accent wash so the leader reads at
 * a glance without requiring a podium — which looked lonely when the
 * board was sparse. Each row pairs the authoritative leaderboard
 * record with the owner's public stats row in a single batched storage
 * read, so page load stays O(1) in round trips regardless of list size.
 *
 * Empty state: a fresh server with zero finished matches shows a soft
 * "be the first" message rather than an empty list.
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

  return (
    <main className={`app-shell ${styles.screen}`}>
      <header className={styles.masthead}>
        <span className={styles.eyebrow}>Top of the board</span>
        <h1 className={styles.title}>Leaderboard</h1>
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
        <p role="alert" className={styles.stateMessage}>
          {error}
        </p>
      ) : entries === null ? (
        <p className={styles.stateMessage}>Loading the leaderboard…</p>
      ) : entries.length === 0 ? (
        <EmptyState />
      ) : (
        <RankList entries={entries} reduceMotion={!!reduceMotion} />
      )}
    </main>
  );
}

/* ------------------------------------------------------------------ */

function RankList({
  entries,
  reduceMotion,
}: {
  entries: LeaderboardEntry[];
  reduceMotion: boolean;
}) {
  return (
    <div className={styles.list}>
      {entries.map((entry, idx) => (
        <RankRow
          key={entry.ownerId || idx}
          entry={entry}
          index={idx}
          reduceMotion={reduceMotion}
        />
      ))}
    </div>
  );
}

function RankRow({
  entry,
  index,
  reduceMotion,
}: {
  entry: LeaderboardEntry;
  index: number;
  reduceMotion: boolean;
}) {
  const isLeader = (entry.rank ?? index + 1) === 1;
  const delay = reduceMotion ? 0 : Math.min(index * 0.04, 0.28);

  return (
    <motion.div
      className={`${styles.row} ${isLeader ? styles.rowLeader : ""}`}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, delay, ease: [0.2, 0.8, 0.2, 1] as const }}
    >
      <span className={`${styles.rank} ${isLeader ? styles.rankLeader : ""}`}>
        #{entry.rank ?? index + 1}
      </span>

      <div className={styles.player}>
        <span
          className={`${styles.monogram} ${isLeader ? styles.monogramLeader : ""}`}
          aria-hidden
        >
          {monogramOf(entry.username)}
        </span>
        <div className={styles.playerMeta}>
          <span className={styles.name} title={entry.username}>
            {entry.username}
          </span>
          <span className={styles.subline}>
            streak {entry.stats?.currentStreak ?? 0} · best{" "}
            {entry.stats?.bestStreak ?? 0}
            {entry.stats
              ? ` · ${entry.stats.classicWins}C / ${entry.stats.timedWins}T`
              : ""}
          </span>
        </div>
      </div>

      <div className={styles.stat}>
        <span className={`${styles.wins} ${isLeader ? styles.winsLeader : ""}`}>
          {entry.wins}
        </span>
        <span className={styles.winsLabel}>Wins</span>
      </div>
    </motion.div>
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
