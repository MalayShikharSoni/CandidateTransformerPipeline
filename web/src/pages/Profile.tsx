import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import {
  coverage,
  currentMonth,
  isCandidate,
  meter,
  monthIndex,
  provenanceFor,
  sourcesOf,
} from "../lib/candidate";
import { useRun } from "../lib/runStore";
import type { Candidate, SourceName } from "../lib/types";
import "./profile.css";

const SOURCE_LABEL: Record<SourceName, string> = { csv: "CSV", resume: "RESUME", github: "GITHUB" };
const SOURCE_ORDER: SourceName[] = ["csv", "resume", "github"];

// Fields shown on the source map and in the table, in reading order.
const MAP_FIELDS = [
  "full_name",
  "emails",
  "phones",
  "headline",
  "links.linkedin",
  "links.github",
  "links.portfolio",
  "location",
  "skills",
  "experience",
  "education",
  "years_experience",
] as const;

function Dial({ value }: { value: number }) {
  const ticks = Array.from({ length: 60 }, (_, i) => {
    const angle = ((-90 + i * 6) * Math.PI) / 180;
    const on = i < Math.round(value * 60);
    const r1 = on ? 62 : 66;
    return {
      i,
      on,
      x1: 85 + Math.cos(angle) * r1,
      y1: 85 + Math.sin(angle) * r1,
      x2: 85 + Math.cos(angle) * 78,
      y2: 85 + Math.sin(angle) * 78,
    };
  });
  return (
    <svg width="170" height="170" viewBox="0 0 170 170" role="img" aria-label={`Overall confidence ${value.toFixed(2)}`}>
      {ticks.map((t) => (
        <line key={t.i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} stroke={t.on ? "#111111" : "rgba(17,17,17,.3)"} strokeWidth={t.on ? 2 : 1} />
      ))}
      <circle cx="85" cy="85" r="52" fill="none" stroke="#111111" />
      <text x="85" y="88" textAnchor="middle" fontFamily="Space Grotesk Variable, sans-serif" fontWeight="700" fontSize="34" fill="#111111">
        {value.toFixed(2)}
      </text>
      <text x="85" y="106" textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize="8" fill="#55544F">
        OVERALL
      </text>
    </svg>
  );
}

function CopyChip({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = () => {
    navigator.clipboard?.writeText(value).catch(() => undefined);
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1400);
  };
  return (
    <button type="button" className={`chip${copied ? " chip-copied" : ""}`} onClick={copy} aria-label={`Copy ${label} ${value}`} title="Copy to clipboard">
      {copied ? "COPIED ✓" : value.replace(/^https?:\/\/(www\.)?/, "")}
    </button>
  );
}

function SourceMap({ candidate }: { candidate: Candidate }) {
  const rowH = 31;
  const top = 20;
  const height = top * 2 + MAP_FIELDS.length * rowH;
  const used = sourcesOf(candidate);
  const srcY: Record<SourceName, number> = {
    csv: height * 0.18,
    resume: height * 0.5,
    github: height * 0.82,
  };
  const counts: Record<SourceName, number> = { csv: 0, resume: 0, github: 0 };

  const rows = MAP_FIELDS.map((field, i) => {
    const sources = [...new Set(provenanceFor(candidate, field).map((entry) => entry.source))];
    sources.forEach((source) => (counts[source] += 1));
    return { field, sources, y: top + i * rowH + 11 };
  });

  return (
    <section className="map panel" aria-labelledby="map-h">
      <div className="panel-head">
        <span id="map-h">FIG.02 — SOURCE MAP</span>
        <span className="muted">which source filled which field</span>
      </div>
      <div className="map-stage" style={{ height }}>
        <svg className="map-lines" viewBox={`0 0 600 ${height}`} preserveAspectRatio="none" aria-hidden="true">
          {rows.flatMap((row) =>
            row.sources.length === 0
              ? [
                  <path
                    key={`${row.field}-none`}
                    d={`M 150 ${row.y} L 440 ${row.y}`}
                    stroke="rgba(17,17,17,.18)"
                    strokeDasharray="1 5"
                    fill="none"
                  />,
                ]
              : row.sources.map((source) => (
                  <path
                    key={`${row.field}-${source}`}
                    className="flow"
                    d={`M 150 ${srcY[source]} C 300 ${srcY[source]}, 320 ${row.y}, 440 ${row.y}`}
                    stroke="#13D17C"
                    strokeDasharray="3 4"
                    fill="none"
                  />
                )),
          )}
        </svg>
        {SOURCE_ORDER.map((source) => (
          <span
            key={source}
            className={`map-source mono${used.has(source) ? "" : " map-source-off"}`}
            style={{ top: srcY[source] - 20 }}
          >
            SRC ── {SOURCE_LABEL[source]}
            <br />
            <span className={used.has(source) ? "map-count" : ""}>
              {used.has(source) ? `${counts[source]} field${counts[source] === 1 ? "" : "s"}` : "not used"}
            </span>
          </span>
        ))}
        {rows.map((row) => (
          <span
            key={row.field}
            className={`map-field mono${row.sources.length === 0 ? " map-field-off" : ""}`}
            style={{ top: row.y - 11 }}
          >
            {row.field}
          </span>
        ))}
      </div>
    </section>
  );
}

function Timeline({ candidate, asOf }: { candidate: Candidate; asOf: string }) {
  const [selected, setSelected] = useState(0);
  const dated = candidate.experience
    .map((job, index) => ({ job, index }))
    .filter(({ job }) => job.start !== null);
  const undated = candidate.experience.filter((job) => job.start === null);

  if (dated.length === 0) {
    return (
      <section className="timeline panel" aria-labelledby="tl-h">
        <div className="panel-head">
          <span id="tl-h">FIG.03 — EXPERIENCE</span>
          <span className="muted">no dated jobs</span>
        </div>
        <div className="timeline-empty">
          {undated.length > 0 ? (
            undated.map((job) => (
              <p key={`${job.company}-${job.title}`} className="mono">
                {job.title || "(title unknown)"} — {job.company || "(company unknown)"} · dates not stated
              </p>
            ))
          ) : (
            <p className="mono muted">No experience on record. Better empty than guessed.</p>
          )}
        </div>
      </section>
    );
  }

  const end = monthIndex(asOf);
  const firstYear = Math.floor(Math.min(...dated.map(({ job }) => monthIndex(job.start!))) / 12);
  const lastYear = Math.floor(end / 12) + 1;
  const span = (lastYear - firstYear) * 12;
  const pct = (month: number) => ((month - firstYear * 12) / span) * 100;

  // Greedy lanes so overlapping jobs stack instead of covering each other.
  const laneEnds: number[] = [];
  const bars = dated
    .map(({ job, index }) => ({ job, index, from: monthIndex(job.start!), to: job.end ? monthIndex(job.end) + 1 : end + 1 }))
    .sort((a, b) => a.from - b.from)
    .map((bar) => {
      let lane = laneEnds.findIndex((laneEnd) => laneEnd <= bar.from);
      if (lane === -1) lane = laneEnds.push(0) - 1;
      laneEnds[lane] = bar.to;
      return { ...bar, lane };
    });
  const height = laneEnds.length * 64 + 40;
  const current = bars.find((bar) => bar.index === selected) ?? bars[0];
  const years = Array.from({ length: lastYear - firstYear + 1 }, (_, i) => firstYear + i);

  return (
    <section className="timeline panel" aria-labelledby="tl-h">
      <div className="panel-head">
        <span id="tl-h">FIG.03 — EXPERIENCE</span>
        <span className="muted">overlaps counted once · ongoing runs to {asOf}</span>
      </div>
      <div className="timeline-body">
        <div className="timeline-track" style={{ height }}>
          {years.map((year, i) => (
            <span key={year} className="tl-year" style={{ left: `${(i * 12 * 100) / span}%` }}>
              <span className="tl-year-label mono">{i % 2 === 0 || years.length < 10 ? year : ""}</span>
            </span>
          ))}
          <span className="tl-asof" style={{ left: `${pct(end + 1)}%` }}>
            <span className="mono">AS-OF {asOf}</span>
          </span>
          {bars.map((bar) => (
            <button
              key={bar.index}
              type="button"
              className={`job hatched${bar.index === current.index ? " job-on" : ""}`}
              aria-pressed={bar.index === current.index}
              aria-label={`${bar.job.title || "Job"} at ${bar.job.company || "unknown company"}`}
              onClick={() => setSelected(bar.index)}
              onMouseEnter={() => setSelected(bar.index)}
              onFocus={() => setSelected(bar.index)}
              style={{
                left: `${pct(bar.from)}%`,
                width: `${Math.max(1.5, pct(bar.to) - pct(bar.from))}%`,
                top: 8 + bar.lane * 64,
              }}
            >
              <span className="job-label mono">{bar.job.company || bar.job.title || "?"}</span>
            </button>
          ))}
        </div>
        <div className="timeline-detail mono">
          <span>
            {current.job.title || "(title unknown)"} — {current.job.company || "(company unknown)"} · {current.job.start} →{" "}
            {current.job.end ?? "present"}
          </span>
          {undated.length > 0 && <span className="muted">+ {undated.length} undated job(s) in the table</span>}
        </div>
      </div>
    </section>
  );
}

function fieldValue(candidate: Candidate, field: (typeof MAP_FIELDS)[number]): string | null {
  switch (field) {
    case "full_name":
      return candidate.full_name || null;
    case "emails":
      return candidate.emails.join(", ") || null;
    case "phones":
      return candidate.phones.join(", ") || null;
    case "headline":
      return candidate.headline;
    case "links.linkedin":
      return candidate.links?.linkedin ?? null;
    case "links.github":
      return candidate.links?.github ?? null;
    case "links.portfolio":
      return candidate.links?.portfolio ?? null;
    case "location": {
      const loc = candidate.location;
      const text = [loc?.city, loc?.region, loc?.country].filter(Boolean).join(", ");
      return text || null;
    }
    case "skills":
      return candidate.skills.length ? candidate.skills.map((s) => s.name).join(", ") : null;
    case "experience":
      return candidate.experience.length ? `${candidate.experience.length} job(s)` : null;
    case "education":
      return candidate.education.length ? `${candidate.education.length} degree(s)` : null;
    case "years_experience":
      return candidate.years_experience === null ? null : String(candidate.years_experience);
  }
}

export function Profile() {
  const { candidateId } = useParams();
  const { run } = useRun();
  const [showJson, setShowJson] = useState(false);

  const people = useMemo(() => (run?.result.records ?? []).filter(isCandidate), [run]);
  const index = people.findIndex((person) => person.candidate_id === candidateId);
  const candidate = index === -1 ? null : people[index];

  if (run === null || run.result.schema !== "default") {
    return (
      <main className="wrap profile-empty">
        <span className="eyebrow">Profiles / none yet</span>
        <h1 className="display section-title">
          No run in this tab.
          <br />
          <span className="thin">Nothing to show — honestly.</span>
        </h1>
        <p>Profiles come from the latest default-schema run in this browser tab. Nothing is stored on the server.</p>
        <Link className="btn btn-ink" to="/workbench">
          Open the workbench →
        </Link>
      </main>
    );
  }

  if (candidate === null) {
    return (
      <main className="wrap profile-empty">
        <span className="eyebrow">Profiles / not found</span>
        <h1 className="display section-title">That candidate isn’t in the latest run.</h1>
        <Link className="btn btn-line" to="/workbench">
          Back to the results →
        </Link>
      </main>
    );
  }

  const detail = run.result.details.find((d) => d.candidate_id === candidate.candidate_id);
  const scores = detail?.fieldConfidence ?? {};
  const cov = coverage(candidate);
  const used = sourcesOf(candidate);
  const asOf = run.result.asOf ?? run.finishedAt.slice(0, 7) ?? currentMonth();
  const headlineProv = provenanceFor(candidate, "headline")[0];
  const prev = people[(index - 1 + people.length) % people.length];
  const next = people[(index + 1) % people.length];
  const llmSkills = provenanceFor(candidate, "skills").some((entry) => entry.method === "llm_extracted");

  const contacts: Array<[string, string]> = [
    ...candidate.emails.map((email): [string, string] => ["email", email]),
    ...candidate.phones.map((phone): [string, string] => ["phone", phone]),
    ...(["linkedin", "github", "portfolio"] as const)
      .map((key): [string, string | null] => [key, candidate.links?.[key] ?? null])
      .filter((pair): pair is [string, string] => pair[1] !== null),
  ];

  return (
    <main className="wrap profile">
      <nav className="profile-pager mono" aria-label="Candidates in this run">
        <Link to="/workbench">← RUN.{String(run.runNo).padStart(3, "0")} RESULTS</Link>
        <span className="muted">
          {index + 1} / {people.length}
        </span>
        <span className="pager-buttons">
          <Link to={`/profiles/${prev.candidate_id}`} aria-label={`Previous: ${prev.full_name}`}>
            ← PREV
          </Link>
          <Link to={`/profiles/${next.candidate_id}`} aria-label={`Next: ${next.full_name}`}>
            NEXT →
          </Link>
        </span>
      </nav>

      <section className="identity">
        <div className="identity-main">
          <span className="mono muted identity-id">PROFILES / candidate_id = {candidate.candidate_id}</span>
          <h1 className="display identity-name">{candidate.full_name || "(no name on record)"}</h1>
          {candidate.headline && (
            <div className="identity-headline">
              <span className="thin">{candidate.headline}</span>
              {headlineProv && (
                <span className={`tag${headlineProv.method === "llm_extracted" ? " tag-llm" : ""}`}>
                  HEADLINE · {SOURCE_LABEL[headlineProv.source]} · {headlineProv.method}
                  {scores.headline !== undefined ? ` · ${scores.headline.toFixed(1)}` : ""}
                </span>
              )}
            </div>
          )}
          {contacts.length > 0 && (
            <div className="contacts">
              {contacts.map(([label, value]) => (
                <CopyChip key={`${label}-${value}`} label={label} value={value} />
              ))}
            </div>
          )}
        </div>
        <div className="identity-side">
          <Dial value={candidate.overall_confidence ?? 0} />
          <div className="identity-stats mono">
            <span>
              <span className="muted stat-label">COVERAGE</span>
              <span className="meter">
                {meter(cov.filled / cov.total)} {cov.filled}/{cov.total}
              </span>
            </span>
            <span>
              <span className="muted stat-label">YEARS (AS OF {asOf})</span>
              <span className="display stat-big">{candidate.years_experience ?? "—"}</span>
            </span>
            <span>
              <span className="muted stat-label">SOURCES</span>
              <span>
                {SOURCE_ORDER.map((source, i) => (
                  <span key={source}>
                    {i > 0 && " · "}
                    {used.has(source) ? SOURCE_LABEL[source] : <s className="muted">{SOURCE_LABEL[source]}</s>}
                  </span>
                ))}
              </span>
            </span>
          </div>
        </div>
      </section>

      <div className="figs">
        <SourceMap candidate={candidate} />
        <Timeline candidate={candidate} asOf={asOf} />
      </div>

      <section className="fields" aria-labelledby="fields-h">
        <div className="fields-head">
          <h2 id="fields-h" className="display fields-title">
            Every field, <span className="thin">and where it came from.</span>
          </h2>
          <button type="button" className="btn btn-line btn-sm" onClick={() => setShowJson((v) => !v)} aria-expanded={showJson}>
            {showJson ? "HIDE RAW JSON" : "{ } VIEW RAW JSON"}
          </button>
        </div>
        {showJson && <pre className="json-raw mono scroll-quiet">{JSON.stringify(candidate, null, 2)}</pre>}
        <div className="table-box">
          <table className="data-table field-table">
            <thead>
              <tr>
                <th scope="col">FIELD</th>
                <th scope="col">VALUE</th>
                <th scope="col">SOURCE</th>
                <th scope="col">METHOD</th>
                <th scope="col">CONFIDENCE</th>
              </tr>
            </thead>
            <tbody>
              {MAP_FIELDS.map((field) => {
                const value = fieldValue(candidate, field);
                const prov = provenanceFor(candidate, field);
                const sources = [...new Set(prov.map((p) => SOURCE_LABEL[p.source].toLowerCase()))].join(" + ");
                const methods = [...new Set(prov.map((p) => p.method))].join(" · ");
                const score = scores[field] ?? null;
                return (
                  <tr key={field} className="row-hover">
                    <td className="muted">{field}</td>
                    <td className={value === null ? "muted" : ""}>{value ?? "null — no source had it"}</td>
                    <td>{sources || "—"}</td>
                    <td>
                      {methods ? (
                        <span className={`tag${methods.includes("llm_extracted") ? " tag-llm" : ""}${methods.includes("normalization_failed") ? " tag-dropped" : ""}`}>
                          {methods}
                        </span>
                      ) : (
                        <span className="muted">none</span>
                      )}
                    </td>
                    <td className="meter">
                      {meter(score)} {score === null ? "—" : score.toFixed(1)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <div className="cards-2">
        <section className="card" aria-labelledby="edu-h">
          <span id="edu-h" className="mono card-label">
            EDUCATION · {candidate.education.length}
          </span>
          {candidate.education.length === 0 ? (
            <p className="muted">None on record.</p>
          ) : (
            candidate.education.map((school) => (
              <div key={`${school.institution}-${school.degree}`} className="edu">
                <span className="display edu-school">{school.institution}</span>
                <span>{[school.degree, school.field, school.end_year].filter(Boolean).join(" · ")}</span>
              </div>
            ))
          )}
        </section>
        <section className="card" aria-labelledby="sk-h">
          <span id="sk-h" className="mono card-label">
            SKILLS · {candidate.skills.length}
            {llmSkills ? " · LLM, GROUNDED" : ""}
          </span>
          {candidate.skills.length === 0 ? (
            <p className="muted">None on record.</p>
          ) : (
            <div className="skills mono">
              {candidate.skills.map((skill) => (
                <span key={skill.name} className="tag skill" title={`from ${skill.sources.join(" + ")}`}>
                  {skill.name} <span className="muted">{skill.confidence.toFixed(1)}</span>
                </span>
              ))}
            </div>
          )}
          <p className="mono muted card-foot">A skill named by two sources scores higher than one named by a single source.</p>
        </section>
      </div>
    </main>
  );
}
