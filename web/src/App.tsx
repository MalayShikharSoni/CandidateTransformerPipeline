import { useEffect } from "react";
import { Route, Routes, useLocation } from "react-router";
import { Nav } from "./components/Nav";
import { Landing } from "./pages/Landing";
import { NotFound } from "./pages/NotFound";
import { Profile } from "./pages/Profile";
import { Workbench } from "./pages/Workbench";

/** Jump to the top on page change, or to #section when the URL has one. */
function ScrollManager() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if (hash) {
      document.getElementById(hash.slice(1))?.scrollIntoView();
    } else {
      window.scrollTo(0, 0);
    }
  }, [pathname, hash]);
  return null;
}

export function App() {
  return (
    <div className="page">
      <ScrollManager />
      <Nav />
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/workbench" element={<Workbench />} />
        <Route path="/profiles/:candidateId" element={<Profile />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </div>
  );
}
