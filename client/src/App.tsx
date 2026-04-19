import { useEffect, useRef } from "react";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";

import { Connecting, ConnectionError } from "@/components/AppStatus";
import { NakamaProvider, useNakama } from "@/context/NakamaProvider";
import Game from "@/pages/Game";
import Home from "@/pages/Home";

import styles from "./App.module.css";

// The app tree:
//   NakamaProvider (env → Client → Session → Socket + reconnect)
//     └── StatusGate (Connecting / Error / Ready)
//         └── RehydrateGate (navigate to an active match on boot)
//             └── Routes (Home, Game, …)
//
// Placing the gates inside the provider keeps page components free of
// connection-awareness branches — they just render when they render.
export default function App() {
  return (
    <NakamaProvider>
      <StatusGate>
        <ReconnectingBanner />
        <RehydrateGate>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/game/:matchId" element={<Game />} />
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

/**
 * ReconnectingBanner sits above the routed content and surfaces a
 * non-blocking indicator while the socket is down. The UI stays
 * interactive because useMatch's join-on-mount will pick up
 * automatically when the new socket is attached.
 */
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

/**
 * RehydrateGate runs the get_current_match RPC on every successful
 * (re)connect. If the caller is in a live match and currently sitting
 * on the Home route, redirect them to the Game page so they can pick
 * up where they left off. Deep links to /game/:someId are left alone.
 */
function RehydrateGate({ children }: { children: React.ReactNode }) {
  const { status, reconnectGeneration, fetchCurrentMatch } = useNakama();
  const navigate = useNavigate();
  const location = useLocation();
  const locationRef = useRef(location.pathname);
  useEffect(() => {
    locationRef.current = location.pathname;
  }, [location.pathname]);

  useEffect(() => {
    if (status !== "ready" || reconnectGeneration === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetchCurrentMatch();
        if (cancelled || !r.active || !r.matchId) return;
        // Only redirect when the user is on the lobby. If they opened a
        // deep link to a specific /game/:id or to the leaderboard, we
        // trust their intent.
        if (locationRef.current === "/") {
          navigate(`/game/${r.matchId}`, { replace: true });
        }
      } catch {
        // A rehydrate failure is non-fatal: the user can still navigate
        // normally. Worst case they click back into the game manually.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, reconnectGeneration, fetchCurrentMatch, navigate]);

  return <>{children}</>;
}
