import { describe, expect, it } from "vitest";
import { formatInZone, zonedWallClockToUtc } from "./zoned-time.js";

/**
 * Every test here is a way somebody gets called at the wrong hour.
 *
 * The cases that matter are not the ordinary ones — they are the two DST
 * transitions, where the offset that applies to the answer differs from the
 * offset used to reach it, and a naive single-pass conversion is out by an hour.
 */

const utc = (iso: string) => new Date(iso).toISOString();

describe("interpreting a wall clock in a zone", () => {
  it("handles a half-hour offset", () => {
    // India is UTC+05:30 all year — no DST, but the half hour catches anyone who
    // assumed offsets are whole numbers.
    expect(
      zonedWallClockToUtc({
        wallClock: "2026-08-20T15:00",
        timeZone: "Asia/Kolkata",
      }).toISOString(),
    ).toBe(utc("2026-08-20T09:30:00Z"));
  });

  it("handles a whole-hour offset behind UTC", () => {
    // New York in August is EDT, UTC-4.
    expect(
      zonedWallClockToUtc({
        wallClock: "2026-08-20T09:00",
        timeZone: "America/New_York",
      }).toISOString(),
    ).toBe(utc("2026-08-20T13:00:00Z"));
  });

  it("handles UTC itself", () => {
    expect(
      zonedWallClockToUtc({ wallClock: "2026-08-20T12:00", timeZone: "UTC" }).toISOString(),
    ).toBe(utc("2026-08-20T12:00:00Z"));
  });

  it("handles a zone ahead of the date line", () => {
    // Auckland in August is NZST, UTC+12 — the answer is the previous UTC day.
    expect(
      zonedWallClockToUtc({
        wallClock: "2026-08-20T09:00",
        timeZone: "Pacific/Auckland",
      }).toISOString(),
    ).toBe(utc("2026-08-19T21:00:00Z"));
  });
});

describe("across a daylight-saving change", () => {
  it("uses winter time before the spring transition", () => {
    // London on 1 March is GMT, UTC+0.
    expect(
      zonedWallClockToUtc({
        wallClock: "2026-03-01T10:00",
        timeZone: "Europe/London",
      }).toISOString(),
    ).toBe(utc("2026-03-01T10:00:00Z"));
  });

  it("uses summer time after it", () => {
    // And on 1 June it is BST, UTC+1. A single-pass conversion anchored on the
    // wrong side of the transition lands an hour out.
    expect(
      zonedWallClockToUtc({
        wallClock: "2026-06-01T10:00",
        timeZone: "Europe/London",
      }).toISOString(),
    ).toBe(utc("2026-06-01T09:00:00Z"));
  });

  it("resolves a time that happens twice to the earlier instant", () => {
    /*
      Clocks in London go back at 02:00 on 25 October 2026, so 01:30 occurs
      twice — once at 00:30 UTC in BST, then again at 01:30 UTC in GMT.
      Accepted rather than rejected, taking the earlier: a customer requesting a
      callback should not be shown an error about a clock change.
    */
    const resolved = zonedWallClockToUtc({
      wallClock: "2026-10-25T01:30",
      timeZone: "Europe/London",
    });
    expect(resolved.toISOString()).toBe(utc("2026-10-25T00:30:00Z"));
  });

  it("resolves a time that never happens without throwing", () => {
    /*
      Clocks go forward at 01:00 on 29 March 2026, so 01:30 does not exist. There
      is no correct answer, only a reasonable one — and a callback request is not
      the place to make somebody solve a calendar puzzle.
    */
    const resolved = zonedWallClockToUtc({
      wallClock: "2026-03-29T01:30",
      timeZone: "Europe/London",
    });
    expect(resolved).toBeInstanceOf(Date);
    expect(Number.isNaN(resolved.getTime())).toBe(false);
  });
});

describe("what it refuses", () => {
  it("rejects a zone the runtime does not know, rather than defaulting to UTC", () => {
    // Silently treating a typo as UTC is how someone gets called at 3am.
    expect(() =>
      zonedWallClockToUtc({ wallClock: "2026-08-20T15:00", timeZone: "Mars/Olympus_Mons" }),
    ).toThrow(/time zone/);
  });

  it("rejects a malformed wall clock", () => {
    expect(() => zonedWallClockToUtc({ wallClock: "20th August 3pm", timeZone: "UTC" })).toThrow(
      /valid date and time/,
    );
  });

  it("rejects an offset masquerading as a zone", () => {
    // "+05:30" loses which country's rules apply, so it cannot survive a DST
    // change. The type says IANA; this makes the runtime agree.
    expect(() =>
      zonedWallClockToUtc({ wallClock: "2026-08-20T15:00", timeZone: "+05:30" }),
    ).toThrow();
  });
});

describe("showing it back", () => {
  it("renders a stored instant in the zone the customer chose", () => {
    // The round trip a customer sees: they asked for 3pm, they must be shown 3pm.
    const instant = zonedWallClockToUtc({
      wallClock: "2026-08-20T15:00",
      timeZone: "Asia/Kolkata",
    });
    expect(formatInZone(instant, "Asia/Kolkata")).toContain("15:00");
  });

  it("renders the same instant differently elsewhere", () => {
    const instant = zonedWallClockToUtc({
      wallClock: "2026-08-20T15:00",
      timeZone: "Asia/Kolkata",
    });
    expect(formatInZone(instant, "Europe/London")).toContain("10:30");
  });
});
