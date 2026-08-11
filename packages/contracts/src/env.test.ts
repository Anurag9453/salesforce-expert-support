import { describe, expect, it } from "vitest";
import { EnvValidationError, parseServerEnv } from "./env.js";

/**
 * §30 says a missing secret must fail the boot, not surface later as a null
 * dereference. These assert that it actually does.
 */

const valid = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  BETTER_AUTH_SECRET: "x".repeat(32),
  BETTER_AUTH_URL: "http://localhost:3000",
} satisfies NodeJS.ProcessEnv;

describe("server env", () => {
  it("accepts the Phase 1 minimum", () => {
    const env = parseServerEnv(valid);
    expect(env.NODE_ENV).toBe("development");
    // Every not-yet-chosen provider defaults to a mock, so Phase 1 boots
    // without a payment, video, or AI credential (§C2).
    expect(env.PAYMENT_PROVIDER).toBe("mock");
    expect(env.PAYOUT_PROVIDER).toBe("mock");
    expect(env.CLASSIFIER_PROVIDER).toBe("mock");
    // Realtime is the exception: it defaults ON, because the postgres transport
    // needs no credential and the product is much worse without it.
    expect(env.REALTIME_PROVIDER).toBe("postgres");
    expect(env.CLASSIFIER_MODEL).toBe("claude-haiku-4-5");
  });

  it("rejects a missing database URL", () => {
    const { DATABASE_URL: _omitted, ...rest } = valid;
    expect(() => parseServerEnv(rest)).toThrow(EnvValidationError);
  });

  it("rejects a non-postgres database URL", () => {
    expect(() => parseServerEnv({ ...valid, DATABASE_URL: "mysql://u:p@host/db" })).toThrow(
      EnvValidationError,
    );
  });

  it("rejects a weak auth secret", () => {
    expect(() => parseServerEnv({ ...valid, BETTER_AUTH_SECRET: "short" })).toThrow(
      EnvValidationError,
    );
  });

  it("rejects a half-configured Google provider", () => {
    // Otherwise this fails at the login screen in production instead of at boot.
    expect(() => parseServerEnv({ ...valid, GOOGLE_CLIENT_ID: "id-only" })).toThrow(
      EnvValidationError,
    );
    expect(() => parseServerEnv({ ...valid, GOOGLE_CLIENT_SECRET: "secret-only" })).toThrow(
      EnvValidationError,
    );
    expect(() =>
      parseServerEnv({ ...valid, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" }),
    ).not.toThrow();
  });

  it("names the offending variable in the error", () => {
    try {
      parseServerEnv({ ...valid, BETTER_AUTH_SECRET: "short" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as EnvValidationError).message).toContain("BETTER_AUTH_SECRET");
    }
  });

  it("coerces numeric settings from their string form", () => {
    const env = parseServerEnv({ ...valid, CLASSIFIER_TIMEOUT_MS: "2500" });
    expect(env.CLASSIFIER_TIMEOUT_MS).toBe(2500);
  });

  it("refuses a realtime provider with no adapter", () => {
    // Better a boot failure than a deployment that silently used something else.
    expect(parseServerEnv({ ...valid, REALTIME_PROVIDER: "ably" }).REALTIME_PROVIDER).toBe("ably");
    expect(() => parseServerEnv({ ...valid, REALTIME_PROVIDER: "pusher" })).toThrow(
      EnvValidationError,
    );
  });

  it("defaults the offer window to 60 seconds and allows a short one", () => {
    expect(parseServerEnv(valid).OFFER_WINDOW_SECONDS).toBe(60);
    expect(parseServerEnv({ ...valid, OFFER_WINDOW_SECONDS: "8" }).OFFER_WINDOW_SECONDS).toBe(8);
    // A ten-minute offer window would be a typo, not a policy.
    expect(() => parseServerEnv({ ...valid, OFFER_WINDOW_SECONDS: "6000" })).toThrow(
      EnvValidationError,
    );
  });

  describe("the relaxation schedule (§C3)", () => {
    it("defaults to the launch schedule 0/90/180/360", () => {
      expect(parseServerEnv(valid).RELAXATION_SCHEDULE_SECONDS).toEqual([0, 90, 180, 360]);
    });

    it("accepts a retuned schedule", () => {
      expect(
        parseServerEnv({ ...valid, RELAXATION_SCHEDULE_SECONDS: "0, 30, 60, 120" })
          .RELAXATION_SCHEDULE_SECONDS,
      ).toEqual([0, 30, 60, 120]);
    });

    it("insists level 0 engages immediately", () => {
      // A first level that waits means a request nobody looks at for 30 seconds.
      expect(() =>
        parseServerEnv({ ...valid, RELAXATION_SCHEDULE_SECONDS: "30,60,90,120" }),
      ).toThrow(EnvValidationError);
    });

    it("rejects a schedule that does not ascend", () => {
      expect(() =>
        parseServerEnv({ ...valid, RELAXATION_SCHEDULE_SECONDS: "0,180,90,360" }),
      ).toThrow(EnvValidationError);
    });

    it("rejects a last level unreachable inside the matching window", () => {
      // A rung nothing ever stands on is a rung that lies about the ladder.
      expect(() =>
        parseServerEnv({ ...valid, RELAXATION_SCHEDULE_SECONDS: "0,90,180,1200" }),
      ).toThrow(EnvValidationError);
    });

    it("rejects the wrong number of levels", () => {
      expect(() => parseServerEnv({ ...valid, RELAXATION_SCHEDULE_SECONDS: "0,90,180" })).toThrow(
        EnvValidationError,
      );
    });
  });

  describe("presence timings (§C4)", () => {
    it("defaults to a 45s ping inside a 3-minute window", () => {
      const env = parseServerEnv(valid);
      expect(env.HEARTBEAT_INTERVAL_SECONDS).toBe(45);
      expect(env.HEARTBEAT_STALE_AFTER_SECONDS).toBe(180);
    });

    it("rejects a ping slower than the timeout", () => {
      // Otherwise every expert who is genuinely present gets swept offline —
      // a config error that would look exactly like a broken sweep.
      expect(() =>
        parseServerEnv({
          ...valid,
          HEARTBEAT_INTERVAL_SECONDS: "200",
          HEARTBEAT_STALE_AFTER_SECONDS: "180",
        }),
      ).toThrow(EnvValidationError);
    });

    it("rejects equal values too", () => {
      expect(() =>
        parseServerEnv({
          ...valid,
          HEARTBEAT_INTERVAL_SECONDS: "180",
          HEARTBEAT_STALE_AFTER_SECONDS: "180",
        }),
      ).toThrow(EnvValidationError);
    });

    it("allows a short window so the sweep can be demonstrated in seconds", () => {
      const env = parseServerEnv({
        ...valid,
        HEARTBEAT_INTERVAL_SECONDS: "5",
        HEARTBEAT_STALE_AFTER_SECONDS: "15",
      });
      expect(env.HEARTBEAT_STALE_AFTER_SECONDS).toBe(15);
    });
  });
});

describe("Stripe credentials are a boot requirement, not a runtime discovery", () => {
  /** The field names an EnvValidationError complained about. */
  function failedFields(env: NodeJS.ProcessEnv): string[] {
    try {
      parseServerEnv(env);
      return [];
    } catch (error) {
      if (error instanceof EnvValidationError) {
        return error.issues.map((issue) => issue.path.join("."));
      }
      throw error;
    }
  }

  it("refuses PAYMENT_PROVIDER=stripe with no secret key", () => {
    expect(failedFields({ ...valid, PAYMENT_PROVIDER: "stripe" })).toContain("STRIPE_SECRET_KEY");
  });

  it("refuses a secret key with no webhook secret", () => {
    // The dangerous half. Without this the app boots, takes authorizations, and
    // silently cannot verify a single payment confirmation — which looks like
    // working software right up until reconciliation.
    expect(
      failedFields({ ...valid, PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_x" }),
    ).toContain("STRIPE_WEBHOOK_SECRET");
  });

  it("accepts stripe once both credentials are present", () => {
    const env = parseServerEnv({
      ...valid,
      PAYMENT_PROVIDER: "stripe",
      STRIPE_SECRET_KEY: "sk_test_x",
      STRIPE_WEBHOOK_SECRET: "whsec_x",
    });
    expect(env.PAYMENT_PROVIDER).toBe("stripe");
  });

  it("does not demand Stripe credentials while the provider is mock", () => {
    expect(failedFields(valid)).toEqual([]);
  });
});
