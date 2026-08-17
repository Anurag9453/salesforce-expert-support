import { ValidationError } from "./errors.js";

/**
 * "3pm on the 20th, in Kolkata" → the actual instant that happened.
 *
 * This is the one calculation in scheduling that is genuinely easy to get wrong,
 * and getting it wrong means someone is called at the wrong hour — so it lives
 * here as a pure function with tests rather than inline wherever it is needed.
 *
 * ## Why the arithmetic looks strange
 *
 * There is no built-in "interpret this wall clock in that zone". `Date` only
 * understands UTC and the *host* machine's zone, and the host is a server in some
 * arbitrary region — so using it directly would silently schedule calls against
 * wherever the container happens to run.
 *
 * What works is inverting the one operation the platform *does* offer: formatting
 * a known instant into a target zone. Guess that the wall clock is UTC, format
 * that guess back into the zone, measure how far off it landed, and subtract the
 * difference.
 *
 * ## Why it iterates
 *
 * One pass is correct except across a DST boundary, where the offset used for the
 * guess differs from the offset at the answer. A second pass re-measures with the
 * corrected instant and converges. Two are enough for every real zone: offsets
 * shift by at most an hour or two, never by enough to jump another transition.
 *
 * ## Ambiguous and impossible times
 *
 * Turning clocks back makes 01:30 happen twice; turning them forward means 02:30
 * never happens. Both are accepted rather than rejected — this is a callback
 * request, not a calendar invite, and a customer typing a time that a DST switch
 * makes ambiguous should not be shown an error they cannot act on. The earlier
 * of two candidate instants wins, which is the conventional reading.
 */
export function zonedWallClockToUtc(params: {
  /** `YYYY-MM-DDTHH:mm`, exactly what an `<input type="datetime-local">` gives. */
  readonly wallClock: string;
  /** An IANA zone id — `Asia/Kolkata`, never a `+05:30` offset. */
  readonly timeZone: string;
}): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(params.wallClock.trim());
  if (!match) {
    throw new ValidationError("That is not a valid date and time.", {
      wallClock: ["expected YYYY-MM-DDTHH:mm"],
    });
  }

  const [, year, month, day, hour, minute] = match.map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];

  assertKnownZone(params.timeZone);

  // What we are solving for: an instant whose clock reading in that zone equals
  // these numbers.
  const target = Date.UTC(year, month - 1, day, hour, minute);

  // The guess: pretend the wall clock was already UTC.
  let instant = target;

  for (let pass = 0; pass < 2; pass += 1) {
    // Measured against `target`, not against `instant`. Comparing to the moving
    // value looks equivalent and is not: once corrected, the reading differs from
    // the instant by exactly the offset again, so the loop applies the same
    // correction twice and lands a full offset past the answer.
    const drift = wallClockInZone(new Date(instant), params.timeZone) - target;
    if (drift === 0) break;
    instant -= drift;
  }

  /*
    When clocks go back, the requested wall clock happens twice and both instants
    are valid answers. Which one the loop above finds depends on where the initial
    guess happened to fall, which is arbitrary — so check explicitly whether an
    earlier candidate reads the same, and prefer it.

    Two hours covers every real transition (most are one hour; Lord Howe is a
    half; none exceed two). For an unambiguous time no earlier candidate matches
    and this changes nothing.
  */
  for (const step of [3_600_000, 7_200_000]) {
    const earlier = instant - step;
    if (wallClockInZone(new Date(earlier), params.timeZone) === target) {
      instant = earlier;
      break;
    }
  }

  return new Date(instant);
}

/**
 * What a given instant reads as on a clock in that zone, expressed as though
 * those wall-clock numbers were UTC. The quantity the inversion above measures.
 */
function wallClockInZone(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);

  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");

  // `hour12: false` renders midnight as 24 in some engines; normalise it.
  const hour = read("hour") % 24;

  return Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    hour,
    read("minute"),
    read("second"),
  );
}

/**
 * Rejects a zone the runtime does not know, rather than silently using UTC.
 *
 * Also rejects a fixed offset like `+05:30`, which modern engines *do* accept.
 * An offset has forgotten which country's rules produced it, so it cannot survive
 * the next DST change — a callback booked for October against `+01:00` would fire
 * an hour late once London went back to GMT. Only a real zone id carries that.
 */
function assertKnownZone(timeZone: string): void {
  if (/^[+-]\d{2}:?\d{2}$/.test(timeZone.trim())) {
    throw new ValidationError("A time zone, not an offset — offsets break at daylight saving.", {
      timeZone: ["expected an IANA zone such as Asia/Kolkata"],
    });
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new ValidationError("We do not recognise that time zone.", {
      timeZone: ["unknown IANA zone"],
    });
  }
}

/**
 * The reverse, for showing a stored instant back to whoever asked for it.
 *
 * A customer who asked for 3pm their time must be shown 3pm, not the UTC instant
 * — and the sales team calling them needs to know which of those two a number is.
 */
export function formatInZone(instant: Date, timeZone: string): string {
  assertKnownZone(timeZone);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(instant);
}
