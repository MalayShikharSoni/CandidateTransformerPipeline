import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { startRun } from "../lib/api";
import { coverage, currentMonth, isCandidate, meter, sourceLetters } from "../lib/candidate";
import { previewCsv, REQUIRED_COLUMNS, uploadKey, type CsvPreview } from "../lib/csvPreview";
import { useRun } from "../lib/runStore";
import { STAGES, type RunEvent, type RunResult, type StageName } from "../lib/types";
import { useHealth } from "../lib/useHealth";
import "./workbench.css";

type StageState = "waiting" | "running" | "done";
type Phase = "idle" | "running" | "done" | "error";

interface LogLine {
  id: number;
  tag: string;
  tone: "ok" | "warn" | "plain";
  text: string;
}

const SAMPLE_FILES = ["ananya-iyer.pdf", "daniel-okafor.pdf", "sofia-marin.docx", "kenji-watanabe.txt"];

function idleStages(): Record<StageName, StageState> {
  return Object.fromEntries(STAGES.map((stage) => [stage, "waiting"])) as Record<StageName, StageState>;
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function DropZone({
  label,
  accept,
  multiple = false,
  onFiles,
  children,
}: {
  label: string;
  accept: string;
  multiple?: boolean;
  onFiles: (files: File[]) => void;
  children: ReactNode;
}) {
  const [over, setOver] = useState(false);
  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setOver(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) onFiles(multiple ? files : files.slice(0, 1));
  };
  return (
    <label
      className={`drop${over ? " drop-over" : ""}`}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      {children}
      <input
        className="sr-only"
        type="file"
        accept={accept}
        multiple={multiple}
        aria-label={label}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          const files = Array.from(event.target.files ?? []);
          if (files.length > 0) onFiles(files);
          event.target.value = "";
        }}
      />
    </label>
  );
}

export function Workbench() {
  const health = useHealth();
  const { run, save } = useRun();

  const [csv, setCsv] = useState<File | null>(null);
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [resumes, setResumes] = useState<File[]>([]);
  const [llm, setLlm] = useState(false);
  const [asOf, setAsOf] = useState(currentMonth());
  const [githubUser, setGithubUser] = useState("");
  // Kept in memory for this tab only; never written to storage.
  const [accessCode, setAccessCode] = useState("");
  const [schema, setSchema] = useState<"default" | "custom">("default");
  const [config, setConfig] = useState<{ name: string; value: unknown } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const [phase, setPhase] = useState<Phase>(run ? "done" : "idle");
  const [stages, setStages] = useState(() =>
    run ? (Object.fromEntries(STAGES.map((s) => [s, "done"])) as Record<StageName, StageState>) : idleStages(),
  );
  const [log, setLog] = useState<LogLine[]>([]);
  const [readState, setReadState] = useState<Record<string, boolean>>({});
  const logId = useRef(0);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  const result: RunResult | null = run?.result ?? null;
  const llmAccess = health?.llmAccess ?? "off";
  const llmDemo = health?.llmDemo ?? false;
  const llmUsable = llmAccess !== "off" || llmDemo;
  // Real Claude runs: open servers, or a code was typed (the server checks it).
  const realLlm = llmAccess === "open" || (llmAccess === "code" && accessCode.trim() !== "");

  const pickCsv = async (file: File) => {
    setFormError(null);
    setCsv(file);
    const parsed = previewCsv(await file.text());
    setPreview(parsed);
    const missing = REQUIRED_COLUMNS.filter((column) => !parsed.columns.includes(column));
    if (missing.length > 0) setFormError(`This CSV is missing required column(s): ${missing.join(", ")}.`);
  };

  const addResumes = (files: File[]) => {
    setResumes((current) => {
      const byName = new Map(current.map((file) => [uploadKey(file.name), file]));
      for (const file of files) byName.set(uploadKey(file.name), file);
      return [...byName.values()];
    });
  };

  const loadSample = async () => {
    setFormError(null);
    const fetchFile = async (name: string) => {
      const response = await fetch(`/samples/${name}`);
      if (!response.ok) throw new Error(`could not load sample ${name}`);
      return new File([await response.blob()], name);
    };
    try {
      await pickCsv(await fetchFile("recruiter-with-resumes.csv"));
      setResumes(await Promise.all(SAMPLE_FILES.map(fetchFile)));
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    }
  };

  const pickConfig = async (file: File) => {
    try {
      setConfig({ name: file.name, value: JSON.parse(await file.text()) as unknown });
      setFormError(null);
    } catch {
      setConfig(null);
      setFormError(`${file.name} is not valid JSON.`);
    }
  };

  // Which resume_path values have a matching upload, before the run.
  const resumeRows = useMemo(() => {
    const uploaded = new Set(resumes.map((file) => uploadKey(file.name)));
    const named = preview?.resumePaths ?? [];
    const rows = named.map((path) => ({ name: path, has: uploaded.has(uploadKey(path)) }));
    const extra = resumes
      .filter((file) => !named.some((path) => uploadKey(path) === uploadKey(file.name)))
      .map((file) => ({ name: file.name, has: true, unused: true }));
    return [...rows, ...extra];
  }, [preview, resumes]);

  const addLog = (tag: string, text: string, tone: LogLine["tone"] = "plain") => {
    logId.current += 1;
    const id = logId.current;
    setLog((lines) => [...lines, { id, tag, text, tone }]);
  };

  const onEvent = (event: RunEvent) => {
    switch (event.event) {
      case "stage":
        setStages((current) => ({ ...current, [event.data.stage]: event.data.status === "start" ? "running" : "done" }));
        break;
      case "source":
        setReadState((current) => ({ ...current, [uploadKey(event.data.subject)]: event.data.ok }));
        if (event.data.ok) addLog(event.data.source.padEnd(7), `${event.data.subject} read`, "ok");
        break;
      case "warning":
        addLog("warning", `${event.data.source} "${event.data.subject}": ${event.data.message}`, "warn");
        break;
      case "log":
        addLog(event.data.level === "note" ? "note   " : "info   ", event.data.text);
        break;
      case "result": {
        const s = event.data.stats;
        addLog(
          "summary",
          `${s.csvRows} CSV rows -> ${s.candidates} candidates (${s.candidateErrors} errors) | Resumes: ${s.resumes} files, ${s.resumesWithWarnings} with warnings, ${s.resumeLlmCalls} LLM calls, ${s.resumeLlmCacheHits} cache hits, ${s.resumeValuesDropped} values dropped`,
        );
        save(event.data);
        setPhase("done");
        break;
      }
      case "error":
        addLog("error  ", event.data.error, "warn");
        setFormError(event.data.error);
        setPhase("error");
        break;
    }
  };

  const runBatch = async () => {
    if (csv === null) {
      setFormError("Add a recruiter CSV first.");
      return;
    }
    if (schema === "custom" && config === null) {
      setFormError("Add a ProjectionConfig .json, or switch back to the default schema.");
      return;
    }
    setFormError(null);
    setPhase("running");
    setStages(idleStages());
    setLog([]);
    setReadState({});
    abort.current?.abort();
    abort.current = new AbortController();
    try {
      await startRun(
        {
          csv,
          resumes,
          options: {
            llm,
            asOf: asOf || undefined,
            githubUser: githubUser.trim() || undefined,
            config: schema === "custom" ? config?.value : undefined,
          },
          accessCode: llm && accessCode.trim() !== "" ? accessCode.trim() : undefined,
        },
        onEvent,
        abort.current.signal,
      );
      setPhase((current) => (current === "running" ? "error" : current));
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError") return;
      const message = error instanceof Error ? error.message : String(error);
      setFormError(message);
      setPhase("error");
    }
  };

  const running = phase === "running";
  const runningStage = STAGES.find((stage) => stages[stage] === "running");
  const doneCount = STAGES.filter((stage) => stages[stage] === "done").length;
  const status = running
    ? `RUNNING ${Math.min(doneCount + 1, 8)}/8`
    : phase === "error"
      ? "FAILED"
      : result
        ? `DONE · ${result.warnings.length} WARNING${result.warnings.length === 1 ? "" : "S"}`
        : "READY";

  const people = (result?.records ?? []).filter(isCandidate);

  return (
    <main className="wrap bench">
      <div className="bench-head">
        <div className="bench-title">
          <span className="eyebrow">Workbench / run.{String(run?.runNo ?? 0).padStart(3, "0")}</span>
          <h1 className="display bench-h1">
            Run a batch<span className="thin"> — watch every stage.</span>
          </h1>
        </div>
        <span className={`status mono${running ? " status-live" : ""}`} role="status">
          STATUS: {status}
        </span>
      </div>

      <div className="bench-grid">
        <form
          className="inputs"
          aria-label="Run inputs"
          onSubmit={(event) => {
            event.preventDefault();
            void runBatch();
          }}
        >
          <div className="input-block">
            <div className="input-head mono">
              <span>[01] RECRUITER CSV</span>
              <button type="button" className="link-button mono" onClick={() => void loadSample()}>
                load sample batch
              </button>
            </div>
            <DropZone label="Recruiter CSV" accept=".csv,text/csv" onFiles={([file]) => void pickCsv(file)}>
              <pre className="drop-glyph" aria-hidden="true">
                {"┌─┬─┬─┐\n├─┼─┼─┤\n└─┴─┴─┘"}
              </pre>
              <span className="drop-text">
                <span className="mono drop-name">{csv ? csv.name : "Drop a .csv or click to choose"}</span>
                <span className="muted">
                  {preview ? `${preview.rows} rows · ${preview.columns.length} columns` : "name, email, phone, current_company, title"}
                </span>
              </span>
            </DropZone>
            {preview && (
              <div className="col-chips mono">
                {preview.columns.map((column) => (
                  <span key={column} className={`tag${REQUIRED_COLUMNS.includes(column) ? "" : " tag-llm"}`}>
                    {column}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="input-block">
            <div className="input-head mono">
              <span>[02] RESUMES</span>
              <span className="muted">matched by resume_path</span>
            </div>
            {resumeRows.length > 0 && (
              <ul className="file-list mono">
                {resumeRows.map((row) => {
                  const read = readState[uploadKey(row.name)];
                  const state =
                    read === true ? "✓ READ" : read === false ? "✗ FAILED" : row.has ? ("unused" in row ? "NOT IN CSV" : "READY") : "✗ MISSING";
                  const tone = read === false || !row.has ? "bad" : read === true ? "ok" : "muted";
                  return (
                    <li key={row.name}>
                      <span>{row.name}</span>
                      <span className={tone}>{state}</span>
                    </li>
                  );
                })}
              </ul>
            )}
            <DropZone label="Resume files" accept=".pdf,.docx,.txt,.md" multiple onFiles={addResumes}>
              <span className="mono drop-center">⇣ drop .pdf / .docx / .txt / .md</span>
            </DropZone>
            {resumes.length > 0 && (
              <button type="button" className="link-button mono" onClick={() => setResumes([])}>
                clear {resumes.length} file{resumes.length === 1 ? "" : "s"}
              </button>
            )}
          </div>

          <div className="input-block">
            <div className="toggle-row">
              <span className="toggle-copy">
                <span className="mono">[03] LLM EXTRACTION</span>
                <span className="muted">Jobs, degrees, headline, skills from resumes</span>
              </span>
              <button
                type="button"
                className={`toggle${llm ? " toggle-on" : ""}`}
                aria-pressed={llm}
                aria-label="LLM extraction"
                disabled={!llmUsable}
                onClick={() => setLlm((value) => !value)}
              >
                <span />
              </button>
            </div>
            {!llmUsable && (
              <p className="note mono">Not set up on this server (no ANTHROPIC_API_KEY). Resumes are read with regex only.</p>
            )}
            {llm && llmAccess === "code" && (
              <label className="field-col">
                <span className="mono">ACCESS CODE {llmDemo ? "(optional)" : ""}</span>
                <input
                  type="password"
                  className="mono"
                  autoComplete="off"
                  value={accessCode}
                  placeholder="for real extraction with Claude"
                  onChange={(event) => setAccessCode(event.target.value)}
                />
              </label>
            )}
            {llm && !realLlm && llmDemo && (
              <p className="note mono">
                Demo: replays saved answers for the sample batch, no API calls. Other resumes are read with regex only.
                {llmAccess === "code" ? " Enter an access code for real extraction." : ""}
              </p>
            )}
            {llm && realLlm && (
              <p className="note note-warn mono">
                Sends resume text to the Anthropic API. Answers are cached, so a re-run costs nothing and gives the same output.
              </p>
            )}
            <label className="field-row mono">
              AS-OF MONTH
              <input type="month" value={asOf} onChange={(event) => setAsOf(event.target.value)} />
            </label>
          </div>

          <div className="input-block">
            <label className="field-col">
              <span className="mono">[04] GITHUB</span>
              <span className="muted">Use one username for every row (optional)</span>
              <input
                type="text"
                className="mono"
                value={githubUser}
                placeholder="each row's github_username"
                onChange={(event) => setGithubUser(event.target.value)}
              />
            </label>
          </div>

          <div className="input-block">
            <span className="mono">[05] OUTPUT SHAPE</span>
            <div className="segmented mono" role="group" aria-label="Output schema">
              <button type="button" aria-pressed={schema === "default"} onClick={() => setSchema("default")}>
                DEFAULT SCHEMA
              </button>
              <button type="button" aria-pressed={schema === "custom"} onClick={() => setSchema("custom")}>
                CUSTOM CONFIG…
              </button>
            </div>
            {schema === "custom" && (
              <DropZone label="ProjectionConfig JSON" accept=".json,application/json" onFiles={([file]) => void pickConfig(file)}>
                <span className="mono drop-center">{config ? `✓ ${config.name}` : "⇣ drop a ProjectionConfig .json"}</span>
              </DropZone>
            )}
          </div>

          <div className="input-block input-last">
            {formError && (
              <p className="form-error mono" role="alert">
                {formError}
              </p>
            )}
            <button type="submit" className="btn btn-ink run-button" disabled={running || csv === null}>
              {running ? "RUNNING…" : "RUN PIPELINE ▶"}
            </button>
          </div>
        </form>

        <section className="monitor" aria-label="Run monitor">
          <ol className="stages cells" aria-label="Stages">
            {STAGES.map((stage, i) => (
              <li key={stage} className={`stage-cell stage-${stages[stage]}`}>
                <span className="mono stage-cell-n">
                  {String(i + 1).padStart(2, "0")} {stages[stage] === "done" ? "✓" : stages[stage] === "running" ? "▸" : "·"}
                </span>
                <span className="display stage-cell-name">{stage[0].toUpperCase() + stage.slice(1)}</span>
                <span className={`stage-bar${stage === runningStage ? " busy" : ""}`} />
              </li>
            ))}
          </ol>

          <div className="terminal">
            <div className="terminal-head mono">
              <span>stderr — run log</span>
              <span>{log.length} lines</span>
            </div>
            <div className="terminal-body mono scroll-quiet" aria-live="polite">
              {log.length === 0 && (
                <div className="muted-ink">
                  {result ? "Showing the last run. Run again to see its log." : "Waiting for a batch. Add a CSV, or load the sample batch."}
                </div>
              )}
              {log.map((line) => (
                <div key={line.id}>
                  <span className={`log-tag log-${line.tone}`}>{line.tag}</span> {line.text}
                </div>
              ))}
              <span className="caret">█</span>
            </div>
          </div>

          {result && !running && (
            <>
              <div className="summary cells">
                {[
                  ["CANDIDATES", result.stats.candidates],
                  ["ERRORS", result.stats.candidateErrors],
                  ["LLM CALLS", result.stats.resumeLlmCalls],
                  ["VALUES DROPPED", result.stats.resumeValuesDropped],
                  ["WARNINGS", result.warnings.length],
                ].map(([label, value]) => (
                  <div key={label} className="summary-cell">
                    <span className="mono muted">{label}</span>
                    <span className={`display${label === "VALUES DROPPED" && Number(value) > 0 ? " bad" : ""}`}>{value}</span>
                  </div>
                ))}
              </div>

              {result.schema === "default" ? (
                <div className="table-box">
                  <table className="data-table results">
                    <thead>
                      <tr>
                        <th scope="col">CANDIDATE</th>
                        <th scope="col">SOURCES</th>
                        <th scope="col">COVERAGE</th>
                        <th scope="col">CONFIDENCE</th>
                        <th scope="col">YEARS</th>
                        <th scope="col">
                          <span className="sr-only">Open</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {people.map((person) => {
                        const cov = coverage(person);
                        return (
                          <tr key={person.candidate_id} className="row-hover">
                            <td className="person">{person.full_name || "(no name)"}</td>
                            <td className="letters">{sourceLetters(person)}</td>
                            <td>
                              {cov.filled}/{cov.total}
                            </td>
                            <td className="meter">
                              {meter(person.overall_confidence)} {person.overall_confidence?.toFixed(2) ?? "—"}
                            </td>
                            <td>{person.years_experience ?? "—"}</td>
                            <td className="open">
                              <Link to={`/profiles/${person.candidate_id}`} aria-label={`Open ${person.full_name}`}>
                                OPEN <span className="go" aria-hidden="true">→</span>
                              </Link>
                            </td>
                          </tr>
                        );
                      })}
                      {result.records
                        .filter((record) => "error" in record)
                        .map((record, i) => (
                          <tr key={`error-${i}`}>
                            <td colSpan={6} className="bad">
                              error: {String((record as { error: string }).error)}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="custom-preview">
                  <p className="note mono">
                    Custom schema: records follow your config, so profile pages are off for this run. Download them below.
                  </p>
                  <pre className="json-preview mono scroll-quiet">{JSON.stringify(result.records.slice(0, 2), null, 2)}</pre>
                </div>
              )}

              <div className="downloads mono">
                <span className="muted">C = CSV · R = RESUME · G = GITHUB · coverage = canonical fields with a value</span>
                <span className="download-buttons">
                  <button
                    type="button"
                    className="btn btn-line btn-sm"
                    onClick={() => download(`canonverge-run-${run?.runNo ?? 0}.json`, `${JSON.stringify(result.records, null, 2)}\n`, "application/json")}
                  >
                    ↓ JSON
                  </button>
                  <button
                    type="button"
                    className="btn btn-line btn-sm"
                    onClick={() =>
                      download(
                        `canonverge-run-${run?.runNo ?? 0}.ndjson`,
                        result.records.map((record) => `${JSON.stringify(record)}\n`).join(""),
                        "application/x-ndjson",
                      )
                    }
                  >
                    ↓ NDJSON
                  </button>
                </span>
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
