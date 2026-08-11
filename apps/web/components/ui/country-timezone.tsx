"use client";

import {
  COUNTRIES,
  PINNED_COUNTRY_CODES,
  TIME_ZONE_META,
  timeZonesForCountry,
  type CountryOption,
} from "@sfx/contracts";
import { useId, useMemo, useState } from "react";
import { Field } from "./field.js";
import { cn } from "@/lib/utils";

/**
 * Country, then time zone within that country.
 *
 * Both were free-text inputs, which meant "india", "IN", "Bharat" and a typo all
 * landed in the same column and nothing downstream could rely on any of it. Two
 * dependent selects instead, over a generated list (see
 * `scripts/generate-geo.mjs`).
 *
 * Three things the cascade has to get right:
 *
 *   - **Choosing a country resets the zone**, unless the country only has one,
 *     in which case picking it for them is strictly better than making them
 *     confirm the obvious. India, the UK and the UAE each have exactly one.
 *   - **The offset shown is computed now, not baked.** Daylight saving moves it,
 *     so a stored number would be wrong half the year.
 *   - **The value submitted is an IANA identifier** (`Asia/Kolkata`), never the
 *     abbreviation. `IST` is ambiguous — India, Ireland and Israel all claim it.
 *     The abbreviation is a label; the identifier is the data.
 */

const shared = cn(
  "h-10 w-full rounded-md border border-border-strong bg-surface-raised px-3 text-sm text-ink shadow-sunken",
  "transition-[border-color,box-shadow] duration-150",
  "hover:border-accent/40",
  "focus:outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-ring",
  "disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-ink-subtle",
);

const pinnedCountries = COUNTRIES.filter((country) => PINNED_COUNTRY_CODES.includes(country.code));
const otherCountries = COUNTRIES.filter((country) => !PINNED_COUNTRY_CODES.includes(country.code));

/** e.g. "UTC+05:30" — for right now, in that zone. */
function currentOffset(timeZone: string): string {
  try {
    const label = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(new Date())
      .find((part) => part.type === "timeZoneName")?.value;
    return label ? label.replace("GMT", "UTC") : "";
  } catch {
    return "";
  }
}

/** "IST · India Standard Time (UTC+05:30)" */
function zoneLabel(timeZone: string): string {
  const meta = TIME_ZONE_META[timeZone];
  const offset = currentOffset(timeZone);
  const name = meta?.name ?? timeZone;
  const head = meta?.abbr ? `${meta.abbr} · ${name}` : name;
  return offset ? `${head} (${offset})` : head;
}

export function CountryTimeZoneFields({
  countryName = "country",
  timezoneName = "timezone",
  defaultCountry,
  defaultTimezone,
  required,
  countryError,
  timezoneError,
  disabled,
}: {
  countryName?: string;
  timezoneName?: string;
  defaultCountry?: string | null;
  defaultTimezone?: string | null;
  required?: boolean;
  countryError?: string[] | undefined;
  timezoneError?: string[] | undefined;
  disabled?: boolean;
}) {
  const prefix = useId();
  const countryId = `${prefix}-country`;
  const timezoneId = `${prefix}-timezone`;

  /*
   * Legacy rows hold a display name ("India") rather than a code, because these
   * were free text until now. Resolve those to a code so an existing expert
   * opening their profile sees their answer selected instead of a blank select
   * that silently discards it.
   */
  const initialCountry = useMemo(() => resolveCountry(defaultCountry), [defaultCountry]);
  const [country, setCountry] = useState(initialCountry);
  const [timezone, setTimezone] = useState(() => {
    const stored = defaultTimezone ?? "";
    return stored in TIME_ZONE_META ? stored : "";
  });

  const zones = country ? timeZonesForCountry(country) : [];

  function onCountryChange(next: string) {
    setCountry(next);
    const available = next ? timeZonesForCountry(next) : [];
    // One zone means there is nothing to choose. Anything else starts blank, so
    // a country change can never leave a zone from the previous country behind.
    setTimezone(available.length === 1 ? (available[0] ?? "") : "");
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field
        id={countryId}
        label="Country"
        required={required}
        error={countryError}
        hint="Where you are based."
      >
        <select
          id={countryId}
          name={countryName}
          value={country}
          disabled={disabled}
          required={required}
          aria-invalid={countryError?.length ? true : undefined}
          onChange={(event) => onCountryChange(event.target.value)}
          className={cn(shared, countryError?.length && "border-danger")}
        >
          <option value="">Select a country…</option>
          {/*
            Two groups rather than one flat list. The launch markets are pinned
            to the top, and without a heading that reads as a broken sort —
            "United States, India, United Kingdom, Afghanistan…" looks like a bug
            rather than a deliberate shortcut.
          */}
          <optgroup label="Most common">
            {pinnedCountries.map((option: CountryOption) => (
              <option key={option.code} value={option.code}>
                {option.name}
              </option>
            ))}
          </optgroup>
          <optgroup label="All countries">
            {otherCountries.map((option: CountryOption) => (
              <option key={option.code} value={option.code}>
                {option.name}
              </option>
            ))}
          </optgroup>
        </select>
      </Field>

      <Field
        id={timezoneId}
        label="Time zone"
        required={required}
        error={timezoneError}
        hint={
          country
            ? zones.length === 1
              ? "Only one time zone here, so it is chosen for you."
              : `${String(zones.length)} to choose from.`
            : "Pick a country first."
        }
      >
        <select
          id={timezoneId}
          name={timezoneName}
          value={timezone}
          // Not merely empty when no country is chosen — disabled, so the
          // dependency is visible rather than something you discover by clicking.
          disabled={disabled || zones.length === 0}
          required={required}
          aria-invalid={timezoneError?.length ? true : undefined}
          onChange={(event) => setTimezone(event.target.value)}
          className={cn(shared, timezoneError?.length && "border-danger")}
        >
          <option value="">{country ? "Select a time zone…" : "Select a country first"}</option>
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zoneLabel(zone)}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}

/** Accepts a code, or a legacy display name, and returns a code or "". */
function resolveCountry(value: string | null | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  const asCode = trimmed.toUpperCase();
  if (COUNTRIES.some((country) => country.code === asCode)) return asCode;
  const byName = COUNTRIES.find((country) => country.name.toLowerCase() === trimmed.toLowerCase());
  return byName?.code ?? "";
}
