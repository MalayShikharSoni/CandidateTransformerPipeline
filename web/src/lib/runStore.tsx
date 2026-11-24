import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { RunResult } from "./types";

/**
 * The latest run's results, kept in the browser only: memory, mirrored to
 * sessionStorage so a reload or opening a profile doesn't lose them. Nothing
 * is stored on the server.
 */

const KEY = "canonverge.run.v1";

export interface StoredRun {
  runNo: number;
  finishedAt: string;
  result: RunResult;
}

interface RunStore {
  run: StoredRun | null;
  save: (result: RunResult) => StoredRun;
  clear: () => void;
}

const Context = createContext<RunStore | null>(null);

function load(): StoredRun | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw === null ? null : (JSON.parse(raw) as StoredRun);
  } catch {
    return null;
  }
}

export function RunProvider({ children, initial }: { children: ReactNode; initial?: StoredRun | null }) {
  const [run, setRun] = useState<StoredRun | null>(() => (initial !== undefined ? initial : load()));

  const save = useCallback((result: RunResult) => {
    let next: StoredRun | null = null;
    setRun((previous) => {
      next = { runNo: (previous?.runNo ?? 0) + 1, finishedAt: new Date().toISOString(), result };
      try {
        sessionStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // storage full or blocked: the run still works for this page view
      }
      return next;
    });
    return next ?? { runNo: 1, finishedAt: new Date().toISOString(), result };
  }, []);

  const clear = useCallback(() => {
    setRun(null);
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      // nothing to clear
    }
  }, []);

  const value = useMemo(() => ({ run, save, clear }), [run, save, clear]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useRun(): RunStore {
  const store = useContext(Context);
  if (store === null) throw new Error("useRun must be used inside <RunProvider>");
  return store;
}
