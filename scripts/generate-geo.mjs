#!/usr/bin/env node
/**
 * Generates `packages/contracts/src/geo.ts` — the country and time-zone picklists.
 *
 * Baked at generation time rather than computed in the browser, because the API
 * that maps a country to its zones (`Intl.Locale#getTimeZones`) is not evenly
 * supported — Safari in particular. Node has it, so we resolve it once here and
 * ship a plain table that works everywhere.
 *
 * Zone *offsets* are deliberately NOT baked: they move with daylight saving, so
 * a generated number would be wrong for half the year. The picker computes the
 * current offset at render time, which every engine can do for a known zone.
 *
 * Re-run after a Node/ICU upgrade to pick up new zones:
 *   node scripts/generate-geo.mjs
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "packages",
  "contracts",
  "src",
  "geo.ts",
);

/**
 * Abbreviations where mechanical initials disagree with what people actually
 * write. "United Kingdom Time" would yield UKT, which nobody says.
 *
 * Kept deliberately short. This is a list of exceptions, not a data set — if it
 * starts growing past a screen, the heuristic is the wrong approach.
 */
const ABBREVIATION_OVERRIDES = {
  "Europe/London": "GMT",
  "Asia/Singapore": "SGT",
  "Pacific/Auckland": "NZST",
  "Asia/Hong_Kong": "HKT",
  "Asia/Seoul": "KST",
  "Asia/Manila": "PHT",
  "Asia/Jakarta": "WIB",
  "Asia/Karachi": "PKT",
  "Asia/Dhaka": "BST",
  "Asia/Colombo": "SLST",
  "Asia/Kathmandu": "NPT",
};

/** Legacy aliases ICU still reports. Store the canonical name instead. */
const CANONICAL = {
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "Europe/Kiev": "Europe/Kyiv",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Truk": "Pacific/Chuuk",
};

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

/**
 * Pinned to the top of the country picklist, in this order, ahead of the
 * alphabetical remainder.
 *
 * These are the launch markets. Scrolling past 200 countries to reach the three
 * that cover most sign-ups is the kind of small tax that gets paid on every
 * single application, so it is worth a special case. Order within the pinned
 * group is deliberate and not alphabetical — it reflects expected volume.
 */
const PINNED_COUNTRIES = ["US", "IN", "GB"];

/**
 * Which zone represents a group of behaviourally identical ones.
 *
 * ICU lists 29 US zones; they collapse to 8 distinct behaviours, and every zone
 * within a group has the same offsets all year — so the choice is cosmetic, not
 * functional. It still matters that a US expert sees `America/New_York` rather
 * than `America/Detroit`. Only the markets we actually expect at launch are
 * listed; everywhere else falls back to the shallowest, shortest path.
 */
const PREFERRED_ZONES = new Set([
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Phoenix",
  "America/Toronto",
  "America/Vancouver",
  "America/Edmonton",
  "America/Winnipeg",
  "America/Halifax",
  "Asia/Kolkata",
  "Europe/London",
  "Europe/Dublin",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Australia/Sydney",
  "Australia/Melbourne",
  "Australia/Brisbane",
  "Australia/Perth",
  "Australia/Adelaide",
  "Asia/Dubai",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Singapore",
  "Asia/Hong_Kong",
  "Asia/Manila",
  "Pacific/Auckland",
  "America/Sao_Paulo",
  "Africa/Lagos",
  "Africa/Johannesburg",
  "Africa/Nairobi",
]);

/** Offset strings in January and July — the pair that separates DST behaviours. */
const JANUARY = new Date("2026-01-15T12:00:00Z");
const JULY = new Date("2026-07-15T12:00:00Z");

function offsetLabel(timeZone, when) {
  try {
    return (
      new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
        .formatToParts(when)
        .find((part) => part.type === "timeZoneName")?.value ?? ""
    );
  } catch {
    return "";
  }
}

/**
 * Collapses zones that are indistinguishable to a human choosing from a list.
 *
 * Grouped on display name plus BOTH the January and July offsets, so
 * `America/Phoenix` (no daylight saving) never merges into `America/Denver`
 * (which has it) despite sharing a winter offset.
 */
function collapse(zones) {
  const groups = new Map();
  for (const zone of zones) {
    const key = `${genericName(zone)}|${offsetLabel(zone, JANUARY)}|${offsetLabel(zone, JULY)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(zone);
  }
  return [...groups.values()].map((members) => {
    const preferred = members.find((zone) => PREFERRED_ZONES.has(zone));
    if (preferred) return preferred;
    return [...members].sort(
      (a, b) =>
        a.split("/").length - b.split("/").length || a.length - b.length || a.localeCompare(b),
    )[0];
  });
}

function genericName(timeZone) {
  try {
    return (
      new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longGeneric" })
        .formatToParts(new Date())
        .find((part) => part.type === "timeZoneName")?.value ?? ""
    );
  } catch {
    return "";
  }
}

/**
 * "India Standard Time" -> "IST", "Eastern Time" -> "ET".
 *
 * Null when the zone has no real name and ICU falls back to a raw offset
 * ("GMT+05:45"), because an abbreviation invented from that would be noise.
 */
function abbreviate(timeZone, name) {
  if (ABBREVIATION_OVERRIDES[timeZone]) return ABBREVIATION_OVERRIDES[timeZone];
  if (!name || /^(GMT|UTC)/.test(name)) return null;
  const words = name.split(/\s+/).filter((word) => /^[A-Z]/.test(word));
  if (words.length < 2) return null;
  return words.map((word) => word[0]).join("");
}

// ── Collect every region ICU knows a zone for ────────────────────────────────

const regions = new Set();
for (let a = 65; a <= 90; a += 1) {
  for (let b = 65; b <= 90; b += 1) {
    regions.add(String.fromCharCode(a) + String.fromCharCode(b));
  }
}

const countries = [];
const zonesByCountry = {};
const zoneMeta = {};

for (const code of [...regions].sort()) {
  let zones;
  try {
    zones = new Intl.Locale(`und-${code}`).getTimeZones();
  } catch {
    continue;
  }
  if (!zones || zones.length === 0) continue;

  const name = regionNames.of(code);
  // A region with no display name, or whose name is just the code back, is not
  // a country anyone should be offered (ICU carries a few of these).
  if (!name || name === code) continue;

  const canonical = collapse([...new Set(zones.map((zone) => CANONICAL[zone] ?? zone))]).sort();

  countries.push({ code, name });
  zonesByCountry[code] = canonical;

  for (const zone of canonical) {
    if (zoneMeta[zone]) continue;
    const generic = genericName(zone);
    zoneMeta[zone] = {
      name: generic || zone.split("/").pop().replace(/_/g, " "),
      abbr: abbreviate(zone, generic),
    };
  }
}

countries.sort((a, b) => a.name.localeCompare(b.name, "en"));

// Pinned first (in the order given), then everyone else alphabetically.
const pinned = PINNED_COUNTRIES.map((code) => countries.find((c) => c.code === code)).filter(
  Boolean,
);
const rest = countries.filter((c) => !PINNED_COUNTRIES.includes(c.code));
countries.length = 0;
countries.push(...pinned, ...rest);

// ── Emit ─────────────────────────────────────────────────────────────────────

const lines = [];
lines.push(`/**`);
lines.push(` * Country and time-zone picklists. GENERATED — do not edit by hand.`);
lines.push(` *`);
lines.push(` * Regenerate with \`node scripts/generate-geo.mjs\` (see that file for why this`);
lines.push(` * is baked rather than computed in the browser).`);
lines.push(` *`);
lines.push(` * ${countries.length} countries, ${Object.keys(zoneMeta).length} zones.`);
lines.push(` */`);
lines.push("");
lines.push(`export interface CountryOption {`);
lines.push(`  /** ISO 3166-1 alpha-2. This is what gets stored. */`);
lines.push(`  readonly code: string;`);
lines.push(`  readonly name: string;`);
lines.push(`}`);
lines.push("");
lines.push(`export interface TimeZoneMeta {`);
lines.push(`  /** Daylight-independent display name, e.g. "India Standard Time". */`);
lines.push(`  readonly name: string;`);
lines.push(`  /** Colloquial abbreviation, e.g. "IST" / "ET". Null when the zone has none. */`);
lines.push(`  readonly abbr: string | null;`);
lines.push(`}`);
lines.push("");
lines.push(`/** Launch markets, pinned to the head of COUNTRIES. */`);
lines.push(
  `export const PINNED_COUNTRY_CODES: readonly string[] = [${PINNED_COUNTRIES.map((c) => JSON.stringify(c)).join(", ")}];`,
);
lines.push("");
lines.push(`/** ${PINNED_COUNTRIES.join(", ")} first, then alphabetical. */`);
lines.push(`export const COUNTRIES: readonly CountryOption[] = [`);
for (const country of countries) {
  lines.push(`  { code: ${JSON.stringify(country.code)}, name: ${JSON.stringify(country.name)} },`);
}
lines.push(`];`);
lines.push("");
lines.push(`export const TIME_ZONES_BY_COUNTRY: Readonly<Record<string, readonly string[]>> = {`);
for (const country of countries) {
  lines.push(
    `  ${JSON.stringify(country.code)}: [${zonesByCountry[country.code].map((z) => JSON.stringify(z)).join(", ")}],`,
  );
}
lines.push(`};`);
lines.push("");
lines.push(`export const TIME_ZONE_META: Readonly<Record<string, TimeZoneMeta>> = {`);
for (const zone of Object.keys(zoneMeta).sort()) {
  const meta = zoneMeta[zone];
  lines.push(
    `  ${JSON.stringify(zone)}: { name: ${JSON.stringify(meta.name)}, abbr: ${meta.abbr === null ? "null" : JSON.stringify(meta.abbr)} },`,
  );
}
lines.push(`};`);
lines.push("");
lines.push(`const COUNTRY_CODES = new Set(COUNTRIES.map((country) => country.code));`);
lines.push("");
lines.push(`export function isCountryCode(value: string): boolean {`);
lines.push(`  return COUNTRY_CODES.has(value);`);
lines.push(`}`);
lines.push("");
lines.push(`export function countryName(code: string): string {`);
lines.push(`  return COUNTRIES.find((country) => country.code === code)?.name ?? code;`);
lines.push(`}`);
lines.push("");
lines.push(`export function timeZonesForCountry(code: string): readonly string[] {`);
lines.push(`  return TIME_ZONES_BY_COUNTRY[code] ?? [];`);
lines.push(`}`);
lines.push("");
lines.push(`/**`);
lines.push(` * The pair check the server needs: a zone is only valid for the country it`);
lines.push(` * belongs to, so "India + America/Los_Angeles" cannot be stored.`);
lines.push(` */`);
lines.push(`export function isTimeZoneInCountry(timeZone: string, countryCode: string): boolean {`);
lines.push(`  return timeZonesForCountry(countryCode).includes(timeZone);`);
lines.push(`}`);
lines.push("");

writeFileSync(OUT, lines.join("\n"), "utf8");

// Format it here rather than leaving it for `pnpm verify` to fail on: a
// generator whose output does not satisfy the repo's own format check is a
// generator nobody can run without breaking the build.
try {
  execFileSync("pnpm", ["exec", "prettier", "--write", OUT], { stdio: "ignore" });
} catch {
  console.warn("prettier could not be run; format the output before committing");
}

console.log(`wrote ${OUT}`);
console.log(`  ${countries.length} countries, ${Object.keys(zoneMeta).length} zones`);
