import { describe, expect, it } from "vitest";
import { describeFindings, scanForSecrets, SECRET_PATTERNS } from "./secret-scanner.js";

/**
 * §31 / requirement 6. The classifier and the expert only ever see the redacted
 * text, so a miss here is a real exposure — these cases are the contract.
 */

describe("Salesforce credentials", () => {
  it("catches a session ID in a pasted debug log", () => {
    const log =
      "Callout failed. Header was Sid=00D5f000000abcdE!AQcAQH0dMHZfz.SsBcMxYo8mVXJ4Kz9pQrStUvWxYz01 and then it threw.";
    const result = scanForSecrets(log);

    expect(result.hasHighSeverity).toBe(true);
    expect(result.findings[0]?.patternId).toBe("salesforce_session_id");
    expect(result.redacted).not.toContain("AQcAQH0dMHZ");
    // The surrounding text must survive, or the expert loses the actual problem.
    expect(result.redacted).toContain("Callout failed");
    expect(result.redacted).toContain("and then it threw");
  });

  it("catches a refresh token", () => {
    const result = scanForSecrets(
      "refresh: 5Aep861mVXJ4Kz9pQrStUvWxYz0123456789abcdefghijklmnopqrstuvwxyzABCD",
    );
    expect(result.findings.some((f) => f.patternId === "salesforce_refresh_token")).toBe(true);
  });

  it("leaves a bare org ID alone", () => {
    // An org ID on its own is not a credential, and redacting it would destroy
    // genuinely useful debugging context.
    const result = scanForSecrets("Our sandbox org is 00D5f000000abcdEAA.");
    expect(result.findings).toEqual([]);
    expect(result.redacted).toContain("00D5f000000abcdEAA");
  });
});

describe("generic secrets", () => {
  it("catches a JWT", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const result = scanForSecrets(`Authorization was ${jwt}`);
    expect(result.hasHighSeverity).toBe(true);
    expect(result.redacted).not.toContain("eyJhbGciOi");
  });

  it("catches a bearer header", () => {
    const result = scanForSecrets(
      "curl -H 'Authorization: Bearer abcdef1234567890abcdef1234567890'",
    );
    expect(result.findings.some((f) => f.patternId === "bearer_token")).toBe(true);
    expect(result.redacted).toContain("Bearer [TOKEN_REMOVED]");
  });

  it("catches a private key block including the body", () => {
    const key = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAxyz123
abc456def789
-----END RSA PRIVATE KEY-----`;
    const result = scanForSecrets(`Cert config:\n${key}\nthen it fails.`);
    expect(result.redacted).not.toContain("MIIEowIBAAKCAQEA");
    expect(result.redacted).toContain("[PRIVATE_KEY_REMOVED]");
    expect(result.redacted).toContain("then it fails");
  });

  it("catches AWS and payment keys", () => {
    const result = scanForSecrets("AKIAIOSFODNN7EXAMPLE and sk_live_abcdefghij1234567890");
    const ids = result.findings.map((f) => f.patternId);
    expect(ids).toContain("aws_access_key");
    expect(ids).toContain("stripe_secret_key");
  });

  it("catches a connection string with inline credentials", () => {
    const result = scanForSecrets("postgres://admin:s3cretpw@db.internal:5432/prod times out");
    expect(result.findings.some((f) => f.patternId === "connection_string")).toBe(true);
    expect(result.redacted).not.toContain("s3cretpw");
  });
});

describe("assigned secrets", () => {
  it("redacts the value and keeps the key name readable", () => {
    const result = scanForSecrets("Named credential has password=hunter2please and it 401s.");
    expect(result.redacted).toContain("password=[REMOVED]");
    expect(result.redacted).not.toContain("hunter2please");
    // The key name surviving is the point — the expert needs to know WHICH
    // setting is wrong, just not what it is set to.
    expect(result.redacted).toContain("and it 401s");
  });

  it("handles the common key spellings", () => {
    for (const key of ["password", "client_secret", "api_key", "apiKey", "security_token"]) {
      const result = scanForSecrets(`${key}: someLongEnoughValue`);
      expect(result.findings.length, key).toBeGreaterThan(0);
    }
  });

  it("leaves an already-masked value alone", () => {
    // Someone who redacted it themselves should not get a scary warning.
    const result = scanForSecrets("password: ****");
    expect(result.findings).toEqual([]);
  });

  it("does not fire on prose that merely mentions a password", () => {
    const result = scanForSecrets("The user says their password reset email never arrives.");
    expect(result.findings).toEqual([]);
  });
});

describe("ordinary Salesforce problems are untouched", () => {
  const realistic = [
    "My LWC isn't refreshing after an imperative Apex call. I call refreshApex but the wire never re-runs.",
    "Batch job hits 'Too many SOQL queries: 101' at around 4000 records. Trigger is bulkified as far as I can tell.",
    "Copado deployment fails after a feature branch rebase — 'Missing metadata' on a custom object I never touched.",
    "CPQ price rule fires twice on quote line creation, doubling the discount.",
    "Flow error: UNABLE_TO_LOCK_ROW when two users edit the same Account.",
  ];

  for (const text of realistic) {
    it(`passes through: "${text.slice(0, 40)}…"`, () => {
      const result = scanForSecrets(text);
      expect(result.findings).toEqual([]);
      expect(result.redacted).toBe(text);
    });
  }
});

describe("mechanics", () => {
  it("handles an empty string", () => {
    const result = scanForSecrets("");
    expect(result.findings).toEqual([]);
    expect(result.redacted).toBe("");
  });

  it("counts multiple occurrences of one pattern", () => {
    const result = scanForSecrets("AKIAIOSFODNN7EXAMPLE and AKIAIOSFODNN7EXAMPLZ");
    expect(result.findings.find((f) => f.patternId === "aws_access_key")?.occurrences).toBe(2);
  });

  it("redacts every occurrence, not just the first", () => {
    const result = scanForSecrets("AKIAIOSFODNN7EXAMPLE and AKIAIOSFODNN7EXAMPLZ");
    expect(result.redacted).not.toMatch(/AKIA[0-9A-Z]{16}/);
  });

  it("is idempotent — rescanning redacted text finds nothing new", () => {
    const once = scanForSecrets("password=hunter2please and AKIAIOSFODNN7EXAMPLE");
    const twice = scanForSecrets(once.redacted);
    expect(twice.findings).toEqual([]);
  });

  it("does not leak regex state between calls", () => {
    // The shared pattern literals carry /g, so a stale lastIndex would make the
    // second call miss. Same input twice must give the same answer.
    const input = "AKIAIOSFODNN7EXAMPLE";
    expect(scanForSecrets(input).findings.length).toBe(scanForSecrets(input).findings.length);
  });

  it("has unique pattern ids", () => {
    const ids = SECRET_PATTERNS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("describeFindings — calm, specific, actionable", () => {
  it("returns null when there is nothing to say", () => {
    expect(describeFindings([])).toBeNull();
  });

  it("names one finding", () => {
    const message = describeFindings(scanForSecrets("AKIAIOSFODNN7EXAMPLE").findings);
    expect(message).toContain("AWS access key");
    expect(message).toContain("removed it before saving");
    // Reassurance matters as much as the warning.
    expect(message).toContain("Nothing was shared");
  });

  it("lists several findings readably", () => {
    const message = describeFindings(
      scanForSecrets("AKIAIOSFODNN7EXAMPLE and password=hunter2please").findings,
    );
    expect(message).toContain(" and ");
  });

  it("does not blame the customer", () => {
    const message = describeFindings(scanForSecrets("AKIAIOSFODNN7EXAMPLE").findings) ?? "";
    for (const word of ["violation", "forbidden", "breach", "danger", "illegal"]) {
      expect(message.toLowerCase()).not.toContain(word);
    }
  });
});
