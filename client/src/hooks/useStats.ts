import { useCallback, useEffect, useState } from "react";

import { useNakama } from "@/context/NakamaProvider";
import type { StatsSummary } from "@/types/match";

/**
 * Zero-valued default used before the first fetch returns and as a fallback
 * for any transient read error. Renders cleanly as "no games yet" in the UI.
 */
const ZERO_STATS: StatsSummary = {
  wins: 0,
  losses: 0,
  draws: 0,
  currentStreak: 0,
  bestStreak: 0,
  classicWins: 0,
  timedWins: 0,
};

interface UseStatsResult {
  /** The caller's latest stats summary. Always non-null; zero-valued before the first fetch resolves. */
  stats: StatsSummary;
  /** True while a request is in flight. Useful for shimmer / skeleton states. */
  loading: boolean;
  /** Imperative refetch — call after navigating back to a page that shows counts. */
  refresh(): Promise<void>;
}

/**
 * useStats fetches the caller's StatsSummary via the `get_stats` RPC and
 * keeps it live across reconnects. The provider's `reconnectGeneration`
 * is keyed in so a freshly-attached socket triggers a re-pull: stats
 * that changed while offline (e.g. a match finished on the server before
 * the client got the OpMatchEnded) still show up the moment we come back.
 *
 * This is the only place the `get_stats` RPC is called — page components
 * pull from the hook rather than issuing the RPC themselves, so the
 * response caching story lives in one place.
 */
export function useStats(): UseStatsResult {
  const { client, session, status, reconnectGeneration } = useNakama();
  const [stats, setStats] = useState<StatsSummary>(ZERO_STATS);
  const [loading, setLoading] = useState(false);

  const fetchStats = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const resp = await client.rpc(session, "get_stats", {});
      const payload = resp.payload;
      if (payload == null) {
        setStats(ZERO_STATS);
        return;
      }
      const parsed =
        typeof payload === "string"
          ? (JSON.parse(payload) as StatsSummary)
          : (payload as StatsSummary);
      setStats({ ...ZERO_STATS, ...parsed });
    } catch {
      // Stats are non-critical. Leave the last good value in place — a
      // flash of zeros on a transient error would be worse than stale data.
    } finally {
      setLoading(false);
    }
  }, [client, session]);

  // Refetch on boot and on every successful reconnect. The provider bumps
  // reconnectGeneration on each fresh socket so this fires exactly when
  // we care: right after we know the server is reachable again.
  useEffect(() => {
    if (status !== "ready") return;
    void fetchStats();
  }, [status, reconnectGeneration, fetchStats]);

  return { stats, loading, refresh: fetchStats };
}
