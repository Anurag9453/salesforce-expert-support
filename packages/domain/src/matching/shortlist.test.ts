import { describe, expect, it } from "vitest";
import type { RankedCandidate } from "./rank.js";
import {
  confirmationDeadline,
  displayRating,
  EXPERT_CONFIRM_SECONDS,
  hoursDelivered,
  selectShortlist,
  shortlistAfterLapse,
  shouldCloseInterestWindow,
  SHORTLIST_SIZE,
} from "./shortlist.js";

/** Minimal ranked candidate — only the fields the shortlist actually reads. */
function candidate(id: string, rank: number): RankedCandidate {
  return {
    expertProfileId: id,
    userId: `user-${id}`,
    rank,
    score: {
      skillScore: 0,
      experienceScore: 0,
      ratingScore: 0,
      fairnessScore: 0,
      reliabilityScore: 0,
      finalScore: 0,
      breakdown: {
        primaryBand: 0,
        minPrimaryValue: 0,
        weightedAverage: 0,
        perSkill: [],
        shrunkRating: 0,
        idleMinutes: 0,
      },
    } as unknown as RankedCandidate["score"],
  };
}

const RANKED = [candidate("a", 1), candidate("b", 2), candidate("c", 3), candidate("d", 4)];

describe("selectShortlist", () => {
  it("takes the best three of those who raised a hand", () => {
    const result = selectShortlist(RANKED, ["a", "b", "c", "d"]);
    expect(result.shortlisted.map((c) => c.expertProfileId)).toEqual(["a", "b", "c"]);
    expect(result.reserves.map((c) => c.expertProfileId)).toEqual(["d"]);
  });

  it("preserves ranking order rather than interest order", () => {
    // The whole point: a shortlist ordered by who clicked first rewards having
    // the tab open, which is uncorrelated with being right for the problem.
    const result = selectShortlist(RANKED, ["d", "c", "a"]);
    expect(result.shortlisted.map((c) => c.expertProfileId)).toEqual(["a", "c", "d"]);
  });

  it("ignores interest from anyone who was not ranked", () => {
    // Raising a hand cannot get you past a filter you failed.
    const result = selectShortlist(RANKED, ["a", "someone-excluded"]);
    expect(result.shortlisted.map((c) => c.expertProfileId)).toEqual(["a"]);
  });

  it("shows fewer than three rather than nothing", () => {
    const result = selectShortlist(RANKED, ["b"]);
    expect(result.shortlisted).toHaveLength(1);
    expect(result.reserves).toHaveLength(0);
  });

  it("returns an empty shortlist when nobody is interested", () => {
    expect(selectShortlist(RANKED, []).shortlisted).toEqual([]);
  });

  it("defaults to three", () => {
    expect(SHORTLIST_SIZE).toBe(3);
    expect(selectShortlist(RANKED, ["a", "b", "c", "d"]).shortlisted).toHaveLength(3);
  });
});

describe("shouldCloseInterestWindow", () => {
  it("closes as soon as enough hands are up, without waiting out the window", () => {
    expect(
      shouldCloseInterestWindow({
        interestedCount: 3,
        windowElapsedSeconds: 5,
        windowSeconds: 900,
      }),
    ).toBe(true);
  });

  it("keeps waiting while the window is open and the pool is thin", () => {
    expect(
      shouldCloseInterestWindow({
        interestedCount: 1,
        windowElapsedSeconds: 30,
        windowSeconds: 900,
      }),
    ).toBe(false);
  });

  it("closes on one interested expert once the window runs out", () => {
    // One shown now beats three shown after the deadline has passed.
    expect(
      shouldCloseInterestWindow({
        interestedCount: 1,
        windowElapsedSeconds: 900,
        windowSeconds: 900,
      }),
    ).toBe(true);
  });

  it("does not close an empty pool, even when the window is over", () => {
    // Nothing to show. That is NO_EXPERT_FOUND's job, not the shortlist's.
    expect(
      shouldCloseInterestWindow({
        interestedCount: 0,
        windowElapsedSeconds: 5000,
        windowSeconds: 900,
      }),
    ).toBe(false);
  });
});

describe("shortlistAfterLapse", () => {
  const three = [candidate("a", 1), candidate("b", 2), candidate("c", 3)];

  it("drops the expert who let their window lapse", () => {
    const result = shortlistAfterLapse(three, "b");
    expect(result.remaining.map((c) => c.expertProfileId)).toEqual(["a", "c"]);
    expect(result.exhausted).toBe(false);
  });

  it("reports exhaustion when the last one lapses", () => {
    // The caller needs this to pick a transition: two left means "ask again",
    // none left means "search again". Getting it the wrong way round strands
    // the customer on an empty screen.
    const result = shortlistAfterLapse([candidate("a", 1)], "a");
    expect(result.remaining).toEqual([]);
    expect(result.exhausted).toBe(true);
  });

  it("is a no-op for someone who was not on the list", () => {
    expect(shortlistAfterLapse(three, "zzz").remaining).toHaveLength(3);
  });
});

describe("confirmationDeadline", () => {
  it("is two minutes out by default", () => {
    const now = new Date("2026-03-01T10:00:00.000Z");
    expect(confirmationDeadline(now).toISOString()).toBe("2026-03-01T10:02:00.000Z");
    expect(EXPERT_CONFIRM_SECONDS).toBe(120);
  });

  it("is an absolute instant, so a refresh cannot buy more time", () => {
    const now = new Date("2026-03-01T10:00:00.000Z");
    const first = confirmationDeadline(now);
    const second = confirmationDeadline(now);
    expect(first.getTime()).toBe(second.getTime());
  });
});

describe("card figures", () => {
  it("floors hours and never flatters", () => {
    expect(hoursDelivered(0)).toBe(0);
    expect(hoursDelivered(40)).toBe(0); // not "1 hour"
    expect(hoursDelivered(60)).toBe(1);
    expect(hoursDelivered(119)).toBe(1);
    expect(hoursDelivered(600)).toBe(10);
  });

  it("treats negative minutes as zero rather than throwing", () => {
    expect(hoursDelivered(-5)).toBe(0);
  });

  it("shows nothing rather than a fake rating for a new expert", () => {
    expect(displayRating(0, 0)).toBeNull();
  });

  it("shows the plain average and the count", () => {
    // Deliberately not the shrunk rating used for matching: a customer counting
    // four reviews should be able to reproduce the number beside them.
    expect(displayRating(19, 4)).toEqual({ average: 4.8, count: 4 });
    expect(displayRating(25, 5)).toEqual({ average: 5, count: 5 });
  });
});
