import { Link } from "react-router";
import { AsciiHero } from "../components/AsciiHero";
import { DecryptLetters, useDecrypt, WaveText } from "../components/TextEffects";
import { meter } from "../lib/candidate";
import "./landing.css";

const STAGES = [
  ["01", "Ingest", "Read the CSV, call GitHub, open each resume. A failed source becomes a warning, never a crash."],
  ["02", "Extract", "Map every source to the same shape: field, raw value, source, method."],
  ["03", "Normalize", "Phones to E.164, dates to YYYY-MM, skills to canonical names. Unparseable means null."],
  ["04", "Merge", "Join by CSV row and email. CSV › resume › GitHub, and only if the value passed normalization."],
  ["05", "Confidence", "Base 0.9 / 0.8 / 0.6 / 0.5 by how a fact was found, +0.1 when sources agree."],
  ["06", "Project", "Reshape the record with a runtime config. The canonical record is never mutated."],
  ["07", "Validate", "Zod-check each projected record. One bad record never stops the batch."],
  ["08", "Emit", "JSON or NDJSON out, warnings and a run summary alongside."],
] as const;

// Example output: the pipeline's real result for Ananya Iyer on fixtures/recruiter-with-resumes.csv.
const EXAMPLE_FIELDS: Array<[string, string, string, number]> = [
  ["full_name", "Ananya Iyer", "csv · direct", 0.9],
  ["emails[0]", "ananya.iyer@example.com", "csv + resume", 1.0],
  ["phones[0]", "+919876543101", "csv · normalized", 1.0],
  ["headline", "Senior Backend Engineer", "resume · llm", 0.5],
  ["links.linkedin", "linkedin.com/in/ananya-iyer-dev", "resume · regex", 0.8],
  ["experience", "Northwind Labs 2022-01 → now · Contoso Retail 2018-07 → 2021-12", "csv + resume", 0.9],
  ["education[0]", "IIT Madras · B.Tech · 2018", "resume · llm", 0.5],
  ["years_experience", "8.4", "derived", 0.5],
  ["skills", "Go, Java, PostgreSQL, Kafka, Kubernetes", "resume · llm", 0.5],
];

const EXAMPLE_ID = "a6f29f9b1ef38e167503d7c187d1d63da38908cefef9690456f49820aff8a628";

function Barcode({ hex }: { hex: string }) {
  const bars: Array<{ x: number; w: number }> = [];
  let x = 0;
  for (const digit of hex) {
    if (x >= 216) break;
    const v = parseInt(digit, 16);
    const w = 1 + (v % 4);
    if (v % 2 === 0) bars.push({ x, w });
    x += w + 1;
  }
  return (
    <svg width="220" height="56" viewBox="0 0 220 56" role="img" aria-label="Barcode drawn from a candidate id">
      {bars.map((bar) => (
        <rect key={bar.x} x={bar.x} y="0" width={bar.w} height="44" fill="#E7E6E1" />
      ))}
      <text x="0" y="55" fill="#E7E6E1" fontFamily="JetBrains Mono, monospace" fontSize="8">
        {hex.slice(0, 16)}…{hex.slice(-8)}
      </text>
    </svg>
  );
}

function Headline() {
  const one = useDecrypt("one");
  const truth = useDecrypt("truth.");
  const scramble = () => {
    one.start();
    truth.start();
  };
  return (
    <h1 className="hero-h1" aria-label="Scattered data becomes one truth.">
      <WaveText text="scattered" className="hero-thin rise rise-2" />
      <span className="rise rise-2 hero-thin-row" aria-hidden="true">
        <span className="hero-boxed">
          <WaveText text="data" className="hero-thin" />
          <span className="hero-box-label">CSV · GITHUB · RESUME</span>
        </span>
      </span>
      <span className="spread hero-connector rise rise-3" aria-hidden="true">
        ——— BECOMES ———
      </span>
      <span className="weigh hero-bold rise rise-3" aria-hidden="true" onMouseEnter={scramble}>
        {one.shown}
      </span>
      <span className="weigh hero-bold hero-bold-last rise rise-4" aria-hidden="true" onMouseEnter={scramble}>
        {truth.shown}
        <svg width="96" height="24" viewBox="0 0 96 24" aria-hidden="true" className="hero-pixels">
          <g fill="#111111">
            <rect x="0" y="16" width="8" height="8" />
            <rect x="12" y="16" width="8" height="8" />
            <rect x="24" y="8" width="8" height="8" />
            <rect x="36" y="16" width="8" height="8" />
            <rect x="48" y="0" width="8" height="8" />
            <rect x="60" y="16" width="8" height="8" />
          </g>
          <rect x="76" y="16" width="8" height="8" fill="#FF4D1A" className="blink" />
        </svg>
      </span>
    </h1>
  );
}

function SourceCard({
  index,
  kind,
  glyph,
  title,
  children,
  meters,
}: {
  index: string;
  kind: string;
  glyph: string;
  title: string;
  children: string;
  meters: Array<[number, string]>;
}) {
  return (
    <article className="src-card">
      <span className="brk brk-tl" aria-hidden="true" />
      <span className="brk brk-br" aria-hidden="true" />
      <div className="src-card-head mono">
        <span>{index}</span>
        <span className="tag">{kind}</span>
      </div>
      <pre className="glyph" aria-hidden="true">
        {glyph}
      </pre>
      <h3 className="display src-card-title">{title}</h3>
      <p className="src-card-text">{children}</p>
      <div className="src-card-meter mono">
        <span className="muted">BASE CONFIDENCE</span>
        {meters.map(([value, label]) => (
          <span key={label} className="meter">
            {meter(value)} {label}
          </span>
        ))}
      </div>
    </article>
  );
}

export function Landing() {
  return (
    <main>
      <section id="top" className="hero wrap">
        <div className="hero-meta mono muted">
          <span>[CONFIG.RUN] /* v1.0 */ = {"{"}</span>
          <span>SOURCES: 3 // STAGES: 8 // OUTPUT: canonical.json</span>
        </div>
        <div className="hero-grid">
          <div className="hero-copy">
            <div className="rise hero-brand-block">
              <span className="mono muted hero-product">[PRODUCT] /* multi-source candidate transformer */</span>
              <p className="hero-brand">
                <DecryptLetters text="CanonVerge" autoStart />
                <span className="hero-version mono" aria-hidden="true">
                  v1.0
                </span>
              </p>
            </div>
            <span className="eyebrow rise rise-2 hero-rule">#001 — What it does</span>
            <Headline />
            <p className="hero-sub rise rise-4">
              CanonVerge merges a recruiter CSV, GitHub profiles and resumes into one canonical profile per candidate.
              Every value carries its source, the method that produced it and a confidence score. Anything the pipeline
              can’t verify stays empty.
            </p>
            <div className="hero-ctas rise rise-4">
              <Link className="btn btn-ink" to="/workbench">
                Open the workbench <span aria-hidden="true">→</span>
              </Link>
              <a className="btn btn-line" href="#pipeline">
                Read the pipeline
              </a>
            </div>
            <dl className="spec mono">
              {[
                ["01", "DETERMINISTIC", "same input, same output — LLM answers are cached"],
                ["02", "TRACEABLE", "source + method on every field"],
                ["03", "GROUNDED", "a value the resume doesn’t contain is dropped"],
              ].map(([n, term, text]) => (
                <div key={n} className="spec-row">
                  <span className="spec-n">{n}</span>
                  <dt>{term}</dt>
                  <dd className="muted">{text}</dd>
                </div>
              ))}
            </dl>
          </div>
          <AsciiHero />
        </div>
        <p className="side-note" aria-hidden="true">
          Trace every value, guess none.
        </p>
      </section>

      <div className="marquee" aria-hidden="true">
        <div className="marquee-track mono">
          {Array.from({ length: 6 }).flatMap((_, round) =>
            ["INGEST", "EXTRACT", "NORMALIZE", "MERGE", "CONFIDENCE", "PROJECT", "VALIDATE", "EMIT"].map((word, i) => (
              <span key={`${round}-${word}`}>
                <span className="marquee-word">{word}</span>
                <span className="marquee-sep">{i === 7 ? "✦" : "⟶"}</span>
              </span>
            )),
          )}
        </div>
      </div>

      <section id="sources" className="wrap section">
        <div className="section-head">
          <div className="section-head-title">
            <span className="eyebrow">§ 02 / Sources</span>
            <h2 className="display section-title">
              Three sources,
              <br />
              <span className="thin">one record.</span>
            </h2>
          </div>
          <p className="section-lede">
            Precedence runs CSV › resume › GitHub — but a source only wins a field if its value passes normalization. A
            malformed phone in the CSV never beats a valid one from the resume.
          </p>
        </div>
        <div className="src-cards">
          <SourceCard
            index="SRC.01"
            kind="STRUCTURED"
            title="Recruiter CSV"
            meters={[[0.9, "0.9"]]}
            glyph={"┌────┬────┬────┬────┐\n│▓▓▓▓│░░░░│▒▒▒▒│░░░░│\n├────┼────┼────┼────┤\n│░░░░│▓▓▓▓│░░░░│▒▒▒▒│\n├────┼────┼────┼────┤\n│▒▒▒▒│░░░░│▓▓▓▓│ ·· │\n└────┴────┴────┴────┘"}
          >
            Name, email, phone, company and title. Optional columns link each row to a GitHub username and a resume file.
          </SourceCard>
          <SourceCard
            index="SRC.02"
            kind="PUBLIC API"
            title="GitHub profile"
            meters={[[0.6, "0.6"]]}
            glyph={"  ╭──────────────╮\n  │  { ‹/› }  ★  │\n  ╰──────┬───────╯\n         │\n  go ▇▇▇▇▇▇▇▇▇\n  ts ▇▇▇▇▇▇\n  py ▇▇▇"}
          >
            Display name, bio, location and links, plus repo languages as a weak skill signal. Responses are cached with
            ETags, so re-runs cost almost no rate limit.
          </SourceCard>
          <SourceCard
            index="SRC.03"
            kind="UNSTRUCTURED"
            title="Resume"
            meters={[
              [0.8, "0.8 regex"],
              [0.5, "0.5 llm"],
            ]}
            glyph={"  ┌─────────────┐\n  │ ███████     │\n  │ ═══════════ │\n  │ ════════    │  .pdf\n  │ ══════════  │  .docx\n  │ ═════       │  .txt\n  └─────────────┘"}
          >
            Regex reads emails, phones and profile links. With the LLM on, Claude reads jobs, degrees, headline and
            skills — each one checked against the resume text.
          </SourceCard>
        </div>
      </section>

      <section id="pipeline" className="band">
        <div className="wrap section band-inner">
          <div className="section-head">
            <div className="section-head-title">
              <span className="eyebrow eyebrow-on-ink">§ 03 / Pipeline</span>
              <h2 className="display section-title">
                Eight stages.
                <br />
                <span className="thin">No shortcuts.</span>
              </h2>
            </div>
            <pre className="band-flow" aria-hidden="true">
              {"csv ────┐\ngithub ─┼──▶ RawFact[] ──▶ merge ──▶ ✓ canonical.json\nresume ─┘"}
            </pre>
          </div>
          <ol className="stage-grid">
            {STAGES.map(([n, name, text]) => (
              <li key={n} className="stage">
                <span className="stage-n mono">{n} ──</span>
                <span className="display stage-name">{name}</span>
                <span className="stage-text">{text}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section id="grounding" className="wrap section">
        <div className="split">
          <div className="split-copy">
            <span className="eyebrow">§ 04 / Grounding</span>
            <h2 className="display section-title">
              The LLM reads.
              <br />
              <span className="thin">The rules decide.</span>
            </h2>
            <p className="section-lede">
              Jobs and degrees depend on a resume’s layout, so Claude reads them. Nothing it returns is trusted until
              plain string matching confirms it.
            </p>
            <ol className="rules">
              <li>
                <span className="mono spec-n">R1</span>Every value must appear in the resume, word for word.
              </li>
              <li>
                <span className="mono spec-n">R2</span>A job’s title and dates must sit near its company name.
              </li>
              <li>
                <span className="mono spec-n">R3</span>LLM facts get the lowest confidence and never outrank the CSV.
              </li>
            </ol>
          </div>
          <div className="specimen">
            <div className="panel-head">
              <span>SPECIMEN — ananya-iyer.pdf</span>
              <span className="muted">planted mistakes from the test fixtures</span>
            </div>
            <div className="specimen-text mono">
              <div>EXPERIENCE</div>
              <div>
                <mark>Senior Backend Engineer</mark>, <mark>Northwind Labs</mark>
              </div>
              <div>
                <mark>Jan 2022</mark> – <mark>Present</mark>
              </div>
              <div>
                Built the billing service in <mark>Go</mark> and <mark>PostgreSQL</mark>.
              </div>
              <div className="gap" />
              <div>
                <mark>Software Engineer</mark>, <mark>Contoso Retail</mark>
              </div>
              <div>
                <mark>Jul 2018</mark> – <mark>Dec 2021</mark>
              </div>
            </div>
            <div className="verdicts mono">
              <div className="verdict verdict-head muted">
                <span>MODEL SAID</span>
                <span>VERDICT</span>
              </div>
              <div className="verdict row-hover">
                <span>job: Northwind Labs · Jan 2022 → Present</span>
                <span className="ok">✓ KEPT</span>
              </div>
              <div className="verdict row-hover">
                <span>skill: PostgreSQL</span>
                <span className="ok">✓ KEPT</span>
              </div>
              <div className="verdict row-hover">
                <s>skill: Rust</s>
                <span className="bad">✗ NOT IN RESUME</span>
              </div>
              <div className="verdict row-hover">
                <s>job: Globex Corporation · Intern · 2017</s>
                <span className="bad">✗ NOT IN RESUME</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="output" className="ruled-top">
        <div className="wrap section">
          <div className="section-head">
            <div className="section-head-title">
              <span className="eyebrow">§ 05 / Output — example</span>
              <h2 className="display section-title">
                One profile.
                <br />
                <span className="thin">Every value on record.</span>
              </h2>
            </div>
            <div className="big-score">
              <span className="display">0.74</span>
              <span className="mono muted">
                overall_confidence
                <br />
                Ananya Iyer
              </span>
            </div>
          </div>
          <div className="example-table">
            {EXAMPLE_FIELDS.map(([field, value, via, score]) => (
              <div key={field} className="example-row row-hover mono">
                <span className="muted example-field">{field}</span>
                <span className="example-value">{value}</span>
                <span className="tag example-via">{via}</span>
                <span className="meter">
                  {meter(score)} {score.toFixed(1)}
                </span>
              </div>
            ))}
          </div>
          <Link className="btn btn-line" to="/workbench" style={{ alignSelf: "flex-start" }}>
            Run it on your own files <span aria-hidden="true">→</span>
          </Link>
        </div>
      </section>

      <footer className="footer">
        <div className="wrap footer-inner">
          <div className="footer-cols mono">
            <div>
              <span className="footer-head">PRODUCT</span>
              <Link to="/workbench">Workbench</Link>
              <a href="#pipeline">Pipeline</a>
              <a href="#grounding">Grounding</a>
            </div>
            <div>
              <span className="footer-head">BUILT WITH</span>
              <span>Node.js · TypeScript · Zod</span>
              <span>libphonenumber · Claude</span>
            </div>
            <div>
              <span className="footer-head">YOUR DATA</span>
              <span>Uploads deleted after each run</span>
              <span>Results stay in this browser tab</span>
            </div>
            <Barcode hex={EXAMPLE_ID} />
          </div>
          <div className="footer-word display" aria-hidden="true">
            CanonVerge
          </div>
          <div className="footer-base mono">
            <span>{"}"} /* end of record */</span>
            <span>© 2026</span>
          </div>
        </div>
      </footer>
    </main>
  );
}
