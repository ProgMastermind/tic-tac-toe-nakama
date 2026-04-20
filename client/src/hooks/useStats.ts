import { useCallback, useEffect, useState } from "react";

import { useNakama } from "@/context/NakamaProvider";
import type { StatsSummary } from "@/types/match";

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
  stats: StatsSummary;
  loading: boolean;
  refresh(): Promise<void>;
}

// Single entry point for get_stats — pages should call this hook rather
// than the RPC directly so caching stays in one place.
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
      // Keep the last good value — a flash of zeros is worse than stale data.
    } finally {
      setLoading(false);
    }
  }, [client, session]);

  useEffect(() => {
    if (status !== "ready") return;
    void fetchStats();
  }, [status, reconnectGeneration, fetchStats]);

  return { stats, loading, refresh: fetchStats };
}
