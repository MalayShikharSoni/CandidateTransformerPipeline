import type { CanonicalCandidate, ProvenanceEntry } from "../schemas/canonical.js";
import type { FieldConfig, ProjectionConfig } from "../schemas/config.js";
import { normalizePhone } from "../normalizers/phone.js";
import { normalizeSkill } from "../normalizers/skills.js";

type PathSegment =
  | { kind: "prop"; key: string }
  | { kind: "index"; index: number }
  | { kind: "wildcard" };

function parseToken(token: string): PathSegment[] | { error: string } {
  const propOnly = /^([a-zA-Z_]\w*)$/.exec(token);
  if (propOnly) {
    return [{ kind: "prop", key: propOnly[1] }];
  }

  const wildcard = /^([a-zA-Z_]\w*)\[\]$/.exec(token);
  if (wildcard) {
    return [{ kind: "prop", key: wildcard[1] }, { kind: "wildcard" }];
  }

  const indexed = /^([a-zA-Z_]\w*)\[(\d+)\]$/.exec(token);
  if (indexed) {
    return [
      { kind: "prop", key: indexed[1] },
      { kind: "index", index: Number(indexed[2]) },
    ];
  }

  return { error: `Invalid path segment "${token}" in from path` };
}

export function parseFromPath(from: string): PathSegment[] | { error: string } {
  if (from.trim() === "") {
    return { error: "from path cannot be empty" };
  }

  const segments: PathSegment[] = [];
  let wildcardCount = 0;

  for (const token of from.split(".")) {
    const parsed = parseToken(token);
    if ("error" in parsed) {
      return parsed;
    }

    for (const segment of parsed) {
      if (segment.kind === "wildcard") {
        wildcardCount++;
        if (wildcardCount > 1) {
          return {
            error: `Invalid from path "${from}": at most one [] wildcard allowed`,
          };
        }
      }
      segments.push(segment);
    }
  }

  return segments;
}

function provenanceKeysFromSegments(segments: PathSegment[]): Set<string> {
  const propKeys = segments
    .filter((segment): segment is { kind: "prop"; key: string } => segment.kind === "prop")
    .map((segment) => segment.key);

  const keys = new Set<string>();
  for (let index = 1; index <= propKeys.length; index++) {
    keys.add(propKeys.slice(0, index).join("."));
  }
  return keys;
}

function provenanceEntryIncluded(
  entry: ProvenanceEntry,
  requestedKeys: Set<string>,
): boolean {
  for (const key of requestedKeys) {
    if (entry.field === key) {
      return true;
    }
    if (entry.field.startsWith(`${key}.`)) {
      return true;
    }
    if (key.startsWith(`${entry.field}.`)) {
      return true;
    }
  }
  return false;
}

function resolveSegments(
  current: unknown,
  segments: PathSegment[],
  index: number,
): { value: unknown; missing: boolean } {
  if (index >= segments.length) {
    if (current === undefined) {
      return { value: undefined, missing: true };
    }
    return { value: current, missing: false };
  }

  const segment = segments[index];

  if (segment.kind === "prop") {
    if (current === null || current === undefined) {
      return { value: undefined, missing: true };
    }
    if (typeof current !== "object") {
      return { value: undefined, missing: true };
    }

    const record = current as Record<string, unknown>;
    if (!(segment.key in record)) {
      return { value: undefined, missing: true };
    }

    return resolveSegments(record[segment.key], segments, index + 1);
  }

  if (segment.kind === "index") {
    if (!Array.isArray(current)) {
      return { value: undefined, missing: true };
    }
    if (segment.index >= current.length) {
      return { value: undefined, missing: true };
    }
    return resolveSegments(current[segment.index], segments, index + 1);
  }

  if (!Array.isArray(current)) {
    return { value: undefined, missing: true };
  }

  const rest = segments.slice(index + 1);
  if (rest.length === 0) {
    return { value: current, missing: false };
  }

  const mapped = current.map((element) => {
    const resolved = resolveSegments(element, rest, 0);
    if (resolved.missing) {
      return null;
    }
    return resolved.value;
  });

  return { value: mapped, missing: false };
}

function applySingleNormalize(
  value: unknown,
  normalize: FieldConfig["normalize"],
): unknown {
  if (normalize === "E164") {
    return normalizePhone(value);
  }
  if (normalize === "canonical") {
    return normalizeSkill(value);
  }
  return value;
}

function applyFieldNormalize(
  value: unknown,
  normalize: FieldConfig["normalize"],
  type: FieldConfig["type"],
): unknown {
  if (normalize === "none") {
    return value;
  }

  if (type === "string[]" && Array.isArray(value)) {
    return value.map((item) => applySingleNormalize(item, normalize));
  }

  if (type === "string") {
    return applySingleNormalize(value, normalize);
  }

  return value;
}

function coerceToType(
  value: unknown,
  type: FieldConfig["type"],
): { value: unknown; ok: boolean } {
  switch (type) {
    case "string":
      if (value === null || value === undefined) {
        return { value, ok: false };
      }
      if (typeof value === "string") {
        return { value, ok: true };
      }
      if (typeof value === "number" || typeof value === "boolean") {
        return { value: String(value), ok: true };
      }
      return { value, ok: false };

    case "number":
      if (value === null || value === undefined) {
        return { value, ok: false };
      }
      if (typeof value === "number" && !Number.isNaN(value)) {
        return { value, ok: true };
      }
      if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        return Number.isNaN(parsed)
          ? { value, ok: false }
          : { value: parsed, ok: true };
      }
      return { value, ok: false };

    case "boolean":
      if (typeof value === "boolean") {
        return { value, ok: true };
      }
      return { value, ok: false };

    case "string[]":
      if (!Array.isArray(value)) {
        return { value, ok: false };
      }
      for (const item of value) {
        if (item !== null && typeof item !== "string") {
          return { value, ok: false };
        }
      }
      return { value, ok: true };

    case "number[]":
      if (!Array.isArray(value)) {
        return { value, ok: false };
      }
      for (const item of value) {
        if (typeof item !== "number" || Number.isNaN(item)) {
          return { value, ok: false };
        }
      }
      return { value, ok: true };

    case "object":
      if (value === null || value === undefined) {
        return { value, ok: false };
      }
      if (typeof value === "object" && !Array.isArray(value)) {
        return { value, ok: true };
      }
      return { value, ok: false };
  }
}

export function projectCandidate(
  candidate: CanonicalCandidate,
  config: ProjectionConfig,
): Record<string, unknown> | { error: string } {
  const output: Record<string, unknown> = {};
  const requestedProvenanceKeys = new Set<string>();

  for (const field of config.fields) {
    const segments = parseFromPath(field.from);
    if ("error" in segments) {
      return { error: segments.error };
    }

    for (const key of provenanceKeysFromSegments(segments)) {
      requestedProvenanceKeys.add(key);
    }

    let { value, missing } = resolveSegments(candidate, segments, 0);

    if (!missing) {
      value = applyFieldNormalize(value, field.normalize, field.type);
      const coerced = coerceToType(value, field.type);
      if (!coerced.ok) {
        missing = true;
      } else {
        value = coerced.value;
      }
    }

    if (missing) {
      // required only affects behavior when on_missing is 'error'; under 'null' or 'omit' it is documentation-only.
      if (field.required && config.on_missing === "error") {
        return {
          error: `Required field "${field.path}" (from "${field.from}") is missing`,
        };
      }
      if (config.on_missing === "omit") {
        continue;
      }
      output[field.path] = null;
      continue;
    }

    output[field.path] = value;
  }

  if (config.include_confidence) {
    output.overall_confidence = candidate.overall_confidence;
    output.provenance = candidate.provenance.filter((entry) =>
      provenanceEntryIncluded(entry, requestedProvenanceKeys),
    );
  }

  return output;
}
