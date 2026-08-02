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
