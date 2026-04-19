import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/Button";
import { useNakama } from "@/context/NakamaProvider";
import type { LeaderboardEntry, StatsSummary } from "@/types/match";

import styles from "./Leaderboard.module.css";

const LEADERBOARD_ID = "global_wins";
const TOP_N = 10;

/**
 * Leaderboard lists the top 10 players by cumulative wins. Each row pairs
 * the authoritative leaderboard record (score = total wins, rank) with the
 * owner's public stats row (streak, per-mode split). The pairing is a
 * single batched storage read so page load stays O(1) in terms of round
 * trips regardless of list size.
 *
 * Empty state: a fresh server with zero finished matches shows a soft
 * "be the first" message rather than an empty table.
 */
export default function Leaderboard() {
  const { client, session, status, reconnectGeneration } = useNakama();
  const [entries, setEntries] = useState<LeaderboardEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        <span className={`eyebrow ${styles.eyebrow}`}>
          <span className={styles.eyebrowDot} aria-hidden />
          Top of the board
        </span>
        <h1 className={styles.title}>Leaderboard</h1>
        <p className={styles.subtitle}>
          The top ten players by cumulative wins. Draws don&rsquo;t count;
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

      <section className={styles.card} aria-label="Top players">
        {error ? (
          <p role="alert" className={styles.stateMessage}>
            {error}
          </p>
        ) : entries === null ? (
          <p className={styles.stateMessage}>Loading the top ten…</p>
        ) : entries.length === 0 ? (
          <EmptyState />
        ) : (
          <Table rows={entries} />
        )}
      </section>
    </main>
  );
}

/* ------------------------------------------------------------------ */

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
            <td className={styles.player}>
              <span className={styles.playerName}>{entry.username}</span>
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
