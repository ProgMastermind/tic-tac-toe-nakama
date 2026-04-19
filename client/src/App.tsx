import { Route, Routes } from "react-router-dom";

import Home from "./pages/Home";

// Route tree stays flat and boring — every screen is a page component that
// owns its own layout. The NakamaProvider will slot in at this level in the
// next commit; for now the scaffold just renders Home.
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="*" element={<Home />} />
    </Routes>
  );
}
