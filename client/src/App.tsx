import { Route, Routes } from "react-router-dom";

import { Connecting, ConnectionError } from "@/components/AppStatus";
import { NakamaProvider, useNakama } from "@/context/NakamaProvider";
import Game from "@/pages/Game";
import Home from "@/pages/Home";

// The app tree:
//   NakamaProvider (env → Client → Session → Socket)
//     └── StatusGate (Connecting / Error / Ready)
//         └── Routes (Home, Game, etc.)
//
// Placing the gate inside the provider keeps page components free of
// "is-the-socket-alive" branches — they just render when they render.
export default function App() {
  return (
    <NakamaProvider>
      <StatusGate>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/game/:matchId" element={<Game />} />
          <Route path="*" element={<Home />} />
        </Routes>
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
