import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { baseServerEnv, clientEnvSchema } from "./env.js";

/**
 * Every variable the server contract knows about must survive Turbo.
 *
 * Turbo strips any environment variable not listed in `globalPassThroughEnv`.
 * That is a sensible default — it makes task hashing honest — but it fails in a
 * way that is very hard to read: the variable is *set*, and simply is not there
 * by the time the code looks for it.
 *
 * This project has now been bitten three times. `DISPATCH_MODE` silently kept
 * its default. Then the Salesforce credentials went missing. Then a Vercel build
 * failed on `BETTER_AUTH_SECRET: Required` while the value sat correctly in the
 * dashboard — twenty-six of the contract's variables were absent from the list,
 * because it had been maintained by hand and only ever appended to reactively.
 *
 * Each fix was a variable. This is the fix for the *class*: adding a variable to
 * the contract and forgetting Turbo is now a failing test on a laptop, seconds
 * after writing it, rather than a deployment failure whose message points
 * somewhere else entirely.
 */

const turboConfig = fileURLToPath(new URL("../../../turbo.json", import.meta.url));

/**
 * `turbo.json` is JSONC — it carries comments, which `JSON.parse` rejects.
 *
 * Scanned character by character rather than filtered by line, because both
 * shortcuts are wrong here. Dropping lines that start with `//` misses block
 * comments, which is how this test broke the moment one was added. And stripping
 * `/* … *\/` with a regex corrupts the file, because `".next/**"` contains the
 * opening sequence inside a string — the config is full of globs.
 *
 * So: track whether we are inside a string, and only treat comment markers as
 * comments when we are not.
 */
function readTurboConfig(): { globalEnv?: string[]; globalPassThroughEnv?: string[] } {
  const raw = readFileSync(turboConfig, "utf8");
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    const next = raw[i + 1];

    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (i < raw.length && raw[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    out += char;
  }

  return JSON.parse(out) as {
    globalEnv?: string[];
    globalPassThroughEnv?: string[];
  };
}

describe("turbo passes through everything the server contract reads", () => {
  it("lists every contract variable", () => {
    const config = readTurboConfig();
    const available = new Set([
      ...(config.globalPassThroughEnv ?? []),
      // `globalEnv` also reaches the task — it is hashed rather than passed
      // through, but it is not stripped, which is what matters here.
      ...(config.globalEnv ?? []),
    ]);

    const declared = Object.keys(baseServerEnv.shape);
    const missing = declared.filter((key) => !available.has(key));

    expect(
      missing,
      missing.length === 0
        ? ""
        : `These are declared in the server env contract but Turbo will strip them:\n` +
            missing.map((k) => `  - ${k}`).join("\n") +
            `\n\nAdd them to "globalPassThroughEnv" in turbo.json. A variable set in ` +
            `Vercel and missing from that list is simply absent at runtime, and the ` +
            `error names the variable rather than the cause.`,
    ).toEqual([]);
  });

  it("does not list variables the contract has since dropped", () => {
    /*
      The opposite drift, and much less serious — a stale entry passes a variable
      nothing reads. Reported rather than asserted, because turbo.json also
      legitimately carries a few names the contract does not: test switches like
      SKIP_DB_TESTS, and the VERCEL_* variables the platform injects.
    */
    const config = readTurboConfig();
    // Both schemas: the NEXT_PUBLIC_* variables are read by the client contract
    // and still have to survive Turbo on their way into the build.
    const declared = new Set([
      ...Object.keys(baseServerEnv.shape),
      ...Object.keys(clientEnvSchema.shape),
    ]);
    const KNOWN_NON_CONTRACT = new Set([
      "SKIP_DB_TESTS",
      "ENV_FILE",
      "CI",
      "VERCEL",
      "VERCEL_ENV",
      "VERCEL_URL",
    ]);

    const orphans = (config.globalPassThroughEnv ?? []).filter(
      (key) => !declared.has(key) && !KNOWN_NON_CONTRACT.has(key),
    );

    expect(
      orphans,
      `Not read by the contract and not a known tooling variable: ${orphans.join(", ")}`,
    ).toEqual([]);
  });
});
