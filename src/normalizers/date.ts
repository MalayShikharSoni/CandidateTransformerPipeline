// Normalizes experience.start / experience.end (from resumes) to YYYY-MM.
// "Present" / "current" / "now" return null: an open-ended role has no end date.

const YYYY_MM = /^(\d{4})-(0[1-9]|1[0-2])$/;
const YYYY_MM_DD = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const YYYY_SLASH_MM = /^(\d{4})\/(0[1-9]|1[0-2])$/;
const MM_SLASH_YYYY = /^(0[1-9]|1[0-2])\/(\d{4})$/;
const YYYY_ONLY = /^(\d{4})$/;
// "Jan 2021", "January 2021", "Jan. 2021", "Sept, 2021", "Mar-2021"
const MONTH_NAME_YYYY = /^([a-z]+)\.?[\s,\-/]*(\d{4})$/;

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

/** true for the words resumes use for an ongoing role. */
export function isPresentWord(rawValue: unknown): boolean {
  if (typeof rawValue !== "string") {
    return false;
  }
  const lower = rawValue.trim().toLowerCase();
  return lower === "present" || lower === "current" || lower === "now";
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function toYearMonth(year: number, month: number): string | null {
  if (month < 1 || month > 12) {
    return null;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

export function normalizeDate(rawValue: unknown): string | null {
  if (typeof rawValue !== "string") {
    return null;
  }

  const trimmed = rawValue.trim();
  if (trimmed === "") {
    return null;
  }

  if (isPresentWord(trimmed)) {
    return null;
  }

  const monthName = trimmed.toLowerCase().match(MONTH_NAME_YYYY);
  if (monthName) {
    const month = MONTHS[monthName[1]];
    return month === undefined ? null : toYearMonth(Number(monthName[2]), month);
  }

  const yyyyMm = trimmed.match(YYYY_MM);
  if (yyyyMm) {
    return toYearMonth(Number(yyyyMm[1]), Number(yyyyMm[2]));
  }

  const yyyyMmDd = trimmed.match(YYYY_MM_DD);
  if (yyyyMmDd) {
    const year = Number(yyyyMmDd[1]);
    const month = Number(yyyyMmDd[2]);
    const day = Number(yyyyMmDd[3]);
    if (!isValidCalendarDate(year, month, day)) {
      return null;
    }
    return toYearMonth(year, month);
  }

  const yyyySlashMm = trimmed.match(YYYY_SLASH_MM);
  if (yyyySlashMm) {
    return toYearMonth(Number(yyyySlashMm[1]), Number(yyyySlashMm[2]));
  }

  const mmSlashYyyy = trimmed.match(MM_SLASH_YYYY);
  if (mmSlashYyyy) {
    return toYearMonth(Number(mmSlashYyyy[2]), Number(mmSlashYyyy[1]));
  }

  const yyyyOnly = trimmed.match(YYYY_ONLY);
  if (yyyyOnly) {
    return toYearMonth(Number(yyyyOnly[1]), 1);
  }

  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return toYearMonth(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1);
  }

  return null;
}
