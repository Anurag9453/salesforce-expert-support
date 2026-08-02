/**
 * Salesforce credential and secret detection (§31).
 *
 * Customers pasting a stack trace or a debug log will sometimes paste a session
 * ID with it. This finds the common cases before the text is stored, shown to an
 * expert, or sent to the classifier.
 *
 * Two deliberate design choices:
 *
 * 1. **Tone.** Findings carry a severity and a plain-language label, because the
 *    UI has to warn without frightening. "That looks like a session ID — we've
 *    hidden it" is useful; a red wall of security jargon makes people abandon a
 *    support request they legitimately need.
 *
 * 2. **Redaction is not a security boundary.** Regexes miss things. This reduces
 *    accidental exposure; it does not make it safe to paste credentials. The
 *    prohibition in the terms is the actual control, and this is defence in
 *    depth behind it.
 *
 * Pure and dependency-free, so the whole pattern set is testable without a
 * database or a request.
 */

export type SecretSeverity = "high" | "medium" | "low";

export interface SecretPattern {
  readonly id: string;
  /** Shown to the customer. Plain language, no jargon, no alarm. */
  readonly label: string;
  readonly severity: SecretSeverity;
  readonly pattern: RegExp;
  /** What replaces the match. Keeps enough shape that the text still reads. */
  readonly placeholder: string;
}

/**
 * Ordered most-specific first: a Salesforce session ID would also match some of
 * the looser token patterns, and we want the precise label to win.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    id: "salesforce_session_id",
    label: "Salesforce session ID",
    severity: "high",
    // 00D + 15/18-char org id, then '!' and the session body.
    pattern: /\b00D[A-Za-z0-9]{12,15}![A-Za-z0-9._\-+=/]{20,}/g,
    placeholder: "[SALESFORCE_SESSION_ID_REMOVED]",
  },
  {
    id: "private_key_block",
    label: "private key",
    severity: "high",
    pattern: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g,
    placeholder: "[PRIVATE_KEY_REMOVED]",
  },
  {
    id: "aws_access_key",
    label: "AWS access key",
    severity: "high",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    placeholder: "[AWS_KEY_REMOVED]",
  },
  {
    id: "stripe_secret_key",
    label: "payment provider secret key",
    severity: "high",
    pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
    placeholder: "[SECRET_KEY_REMOVED]",
  },
  {
    id: "jwt",
    label: "access token",
    severity: "high",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    placeholder: "[TOKEN_REMOVED]",
  },
  {
    id: "bearer_token",
    label: "authorization header",
    severity: "high",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/gi,
    placeholder: "Bearer [TOKEN_REMOVED]",
  },
  {
    id: "salesforce_refresh_token",
    label: "Salesforce refresh token",
    severity: "high",
    pattern: /\b5Aep[A-Za-z0-9._\-+=/]{40,}/g,
    placeholder: "[REFRESH_TOKEN_REMOVED]",
  },
  {
    id: "assigned_secret",
    label: "password or secret",
    severity: "high",
    // key=value / key: value for obviously-secret key names. Requires a
    // non-trivial value so `password: <redacted>` or `password: ****` is left be.
    //
    // The negative lookahead skips our own placeholders. Without it, rescanning
    // already-redacted text matches `password=[REMOVED]` and reports a fresh
    // finding — which would show the customer a warning about text we cleaned
    // ourselves. Scanning must be idempotent.
    pattern:
      /\b(?:password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|apikey|security[_-]?token|consumer[_-]?secret)\b\s*[:=]\s*["']?(?!\[[A-Z_]+\])([^\s"',;]{6,})["']?/gi,
    placeholder: "[REMOVED]",
  },
  {
    id: "connection_string",
    label: "database connection string",
    severity: "high",
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@[^\s/]+/gi,
    placeholder: "[CONNECTION_STRING_REMOVED]",
  },
];

export interface SecretFinding {
  readonly patternId: string;
  readonly label: string;
  readonly severity: SecretSeverity;
  readonly occurrences: number;
}

export interface ScanResult {
  readonly findings: readonly SecretFinding[];
  /** Safe to store, display, and send to the classifier. */
  readonly redacted: string;
  readonly hasHighSeverity: boolean;
}

/**
 * The `assigned_secret` pattern captures the value in group 1 so only the value
 * is replaced — `password=hunter2` becomes `password=[REMOVED]` rather than
 * losing the key name, which would make the surrounding text harder to read.
 */
function replaceMatch(pattern: SecretPattern, match: RegExpExecArray): string {
  if (pattern.id === "assigned_secret" && match[1] !== undefined) {
    return match[0].replace(match[1], pattern.placeholder);
  }
  return pattern.placeholder;
}

export function scanForSecrets(text: string): ScanResult {
  if (text.length === 0) {
    return { findings: [], redacted: text, hasHighSeverity: false };
  }

  const findings: SecretFinding[] = [];
  let redacted = text;

  for (const pattern of SECRET_PATTERNS) {
    // Fresh regex per pass: the shared literals carry /g and therefore lastIndex.
    const regex = new RegExp(pattern.pattern.source, pattern.pattern.flags);
    const matches = [...redacted.matchAll(regex)];
    if (matches.length === 0) continue;

    findings.push({
      patternId: pattern.id,
      label: pattern.label,
      severity: pattern.severity,
      occurrences: matches.length,
    });

    // Right-to-left so earlier indices stay valid as we splice.
    for (const match of matches.reverse()) {
      if (match.index === undefined) continue;
      redacted =
        redacted.slice(0, match.index) +
        replaceMatch(pattern, match as RegExpExecArray) +
        redacted.slice(match.index + match[0].length);
    }
  }

  return {
    findings,
    redacted,
    hasHighSeverity: findings.some((f) => f.severity === "high"),
  };
}

/**
 * One calm sentence for the customer.
 *
 * Requirement 5: prominent, not frightening. It states what happened and what to
 * do, without implying they have done something wrong — most people pasting a
 * debug log genuinely do not realise a token is in it.
 */
export function describeFindings(findings: readonly SecretFinding[]): string | null {
  if (findings.length === 0) return null;

  const labels = [...new Set(findings.map((f) => f.label))];
  const list =
    labels.length === 1
      ? `a ${labels[0]}`
      : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;

  return `We spotted what looks like ${list} in your description and removed it before saving. Nothing was shared. Please avoid pasting credentials or production data — an expert never needs them to help you.`;
}
