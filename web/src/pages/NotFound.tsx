import { Link } from "react-router";

export function NotFound() {
  return (
    <main className="wrap" style={{ paddingBlock: "96px", display: "flex", flexDirection: "column", gap: 24 }}>
      <span className="eyebrow">404 / NULL</span>
      <h1 className="display" style={{ fontSize: "clamp(48px, 8vw, 96px)" }}>
        Nothing here.
        <br />
        <span className="thin">Honestly empty.</span>
      </h1>
      <p style={{ maxWidth: 480, lineHeight: 1.6 }}>This page doesn’t exist. Better a clear blank than a guess.</p>
      <Link className="btn btn-ink" to="/" style={{ alignSelf: "flex-start" }}>
        Back to the start →
      </Link>
    </main>
  );
}
