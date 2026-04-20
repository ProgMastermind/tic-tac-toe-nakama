import { useEffect, useRef } from "react";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";

import { Connecting, ConnectionError } from "@/components/AppStatus";
import { NakamaProvider, useNakama } from "@/context/NakamaProvider";
import Game from "@/pages/Game";
import Home from "@/pages/Home";
import Leaderboard from "@/pages/Leaderboard";

import styles from "./App.module.css";

export default function App() {
  return (
    <NakamaProvider>
      <StatusGate>
        <ReconnectingBanner />
        <RehydrateGate>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/game/:matchId" element={<Game />} />
            <Route path="/leaderboard" element={<Leaderboard />} />
            <Route path="*" element={<Home />} />
          </Routes>
        </RehydrateGate>
      </StatusGate>
    </NakamaProvider>
  );
}

function StatusGate({ children }: { children: React.ReactNode }) {
  const { status, error } = useNakama();
  if (status === "connecting") return <Connecting />;
  if (status === "error") return <ConnectionError message={error ?? "Unknown error"} />;
  return <>{children}</>;
}

function ReconnectingBanner() {
  const { isReconnecting } = useNakama();
  if (!isReconnecting) return null;
  return (
    <div className={styles.reconnectBanner} role="status" aria-live="polite">
      <span className={styles.reconnectDot} aria-hidden />
      Reconnecting to the server…
    </div>
  );
}

// Boot-time one-shot. Redirecting on reconnect would race the server's
// active_match clear after "Back to lobby" and bounce the user back.
function RehydrateGate({ children }: { children: React.ReactNode }) {
  const { status, reconnectGeneration, fetchCurrentMatch } = useNakama();
  const navigate = useNavigate();
  const location = useLocation();
  const locationRef = useRef(location.pathname);
  const didBootCheckRef = useRef(false);
  useEffect(() => {
    locationRef.current = location.pathname;
  }, [location.pathname]);

  useEffect(() => {
    if (didBootCheckRef.current) return;
    if (status !== "ready" || reconnectGeneration === 0) return;
    didBootCheckRef.current = true;

    let cancelled = false;
    (async () => {
      try {
        const r = await fetchCurrentMatch();
        if (cancelled || !r.active || !r.matchId) return;
        // Only auto-redirect from the lobby — trust deep links as-is.
        if (locationRef.current === "/") {
          navigate(`/game/${r.matchId}`, { replace: true });
        }
      } catch {
        // Non-fatal; user can navigate manually.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, reconnectGeneration, fetchCurrentMatch, navigate]);

  return <>{children}</>;
}
