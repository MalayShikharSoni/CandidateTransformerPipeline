import { Link, NavLink } from "react-router";
import { useHealth } from "../lib/useHealth";
import { useRun } from "../lib/runStore";
import "./nav.css";

export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 22 22" aria-hidden="true">
      <rect x="0" y="0" width="6" height="6" fill="#111111" />
      <rect x="8" y="0" width="6" height="6" fill="#111111" />
      <rect x="16" y="0" width="6" height="6" fill="#13D17C" />
      <rect x="8" y="8" width="6" height="6" fill="#111111" />
      <rect x="0" y="16" width="6" height="6" fill="#111111" />
      <rect x="8" y="16" width="6" height="6" fill="#111111" />
      <rect x="16" y="16" width="6" height="6" fill="#111111" />
    </svg>
  );
}

export function Nav() {
  const health = useHealth();
  const { run } = useRun();
  const firstProfile = run?.result.records.find(
    (record): record is { candidate_id: string } =>
      !("error" in record) && typeof record.candidate_id === "string",
  );

  return (
    <header className="nav">
      <nav aria-label="Main" className="nav-inner wrap">
        <Link to="/" className="nav-brand">
          <LogoMark />
          <span className="nav-name">CanonVerge</span>
          <span className="nav-sub mono muted">/* candidate transformer */</span>
        </Link>
        <div className="nav-links mono">
          <NavLink to="/workbench" className="nav-link">
            Workbench
          </NavLink>
          {firstProfile && run?.result.schema === "default" ? (
            <NavLink
              to={`/profiles/${firstProfile.candidate_id}`}
              className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}
            >
              Profiles
            </NavLink>
          ) : (
            <span className="nav-link nav-link-off" title="Run a batch to see profiles">
              Profiles
            </span>
          )}
          <a className="nav-link" href="/#pipeline">
            Pipeline
          </a>
        </div>
        <span className="nav-status mono muted" aria-live="polite">
          {health === null
            ? "API ○ OFFLINE"
            : `LLM ${
                health.llmAccess === "open"
                  ? "● ON"
                  : health.llmAccess === "code"
                    ? "● CODE"
                    : health.llmDemo
                      ? "● DEMO"
                      : "○ OFF"
              } · GITHUB TOKEN ${health.githubToken ? "● SET" : "○ NONE"}`}
        </span>
      </nav>
    </header>
  );
}
