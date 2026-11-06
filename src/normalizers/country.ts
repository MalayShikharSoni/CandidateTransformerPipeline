// Country name/code -> ISO-3166 alpha-2. Called by resolveLocation in
// merge/resolve.ts on the country part of the GitHub location string.

const ISO_ALPHA2 = /^[A-Z]{2}$/;

const COUNTRY_ALIASES: Record<string, string> = {
  india: "IN",
  ind: "IN",
  in: "IN",
  // Indian state -> country inference, context-specific
  punjab: "IN",
  "united states": "US",
  "united states of america": "US",
  usa: "US",
  us: "US",
  "united kingdom": "GB",
  uk: "GB",
  gbr: "GB",
  gb: "GB",
  canada: "CA",
  can: "CA",
  ca: "CA",
  australia: "AU",
  aus: "AU",
  au: "AU",
  germany: "DE",
  deu: "DE",
  de: "DE",
  france: "FR",
  fra: "FR",
  fr: "FR",
  japan: "JP",
  jpn: "JP",
  jp: "JP",
  singapore: "SG",
  sgp: "SG",
  sg: "SG",
};

export function normalizeCountry(rawValue: unknown): string | null {
  if (typeof rawValue !== "string") {
    return null;
  }

  const trimmed = rawValue.trim();
  if (trimmed === "") {
    return null;
  }

  const upper = trimmed.toUpperCase();
  if (ISO_ALPHA2.test(upper)) {
    return upper;
  }

  const mapped = COUNTRY_ALIASES[trimmed.toLowerCase()];
  if (mapped !== undefined) {
    return mapped;
  }

  return null;
}
