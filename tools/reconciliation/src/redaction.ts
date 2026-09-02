/**
 * Evidence from reconciliation is published to GitHub, so it must never carry a
 * real contact value. These checks are deliberately broad: a false positive
 * costs a rename, a false negative leaks production data into a public repo.
 */
const REAL_EMAIL = /[A-Z0-9._%+-]+@(?!fixture\.invalid\b)[A-Z0-9.-]+\.[A-Z]{2,}/i;
const LONG_DIGIT_RUN = /\d{7,}/;

/**
 * A content digest — hex, at least 12 chars, containing at least one a–f. The
 * letter requirement matters: without it a 12-digit phone number would be
 * mistaken for a digest and waved through. Digests are our own hashes and carry
 * no personal data, but they routinely contain long digit runs.
 */
const CONTENT_DIGEST = /^(?=[0-9a-f]*[a-f])[0-9a-f]{12,}$/i;

export interface RedactionFinding {
  readonly kind: "email" | "digits";
  readonly at: string;
}

function scanString(value: string, path: string): readonly RedactionFinding[] {
  const findings: RedactionFinding[] = [];
  if (REAL_EMAIL.test(value)) findings.push({ kind: "email", at: path });

  // Tokenise so a digit run inside a digest is not mistaken for a phone number,
  // while a digit run anywhere else still trips the check.
  const tokens = value.split(/[^0-9A-Za-z]+/).filter((token) => token.length > 0);
  if (tokens.some((token) => !CONTENT_DIGEST.test(token) && LONG_DIGIT_RUN.test(token))) {
    findings.push({ kind: "digits", at: path });
  }
  return findings;
}

/** Walks a report and returns anything that looks like a real contact value. */
export function findUnredacted(value: unknown, path = "$"): readonly RedactionFinding[] {
  if (typeof value === "string") return scanString(value, path);
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findUnredacted(entry, `${path}[${index}]`));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) => findUnredacted(entry, `${path}.${key}`));
  }
  return [];
}

export function assertRedacted(value: unknown): void {
  const findings = findUnredacted(value);
  if (findings.length > 0) {
    const where = findings.map((finding) => `${finding.kind}@${finding.at}`).join(", ");
    throw new Error(`report contains unredacted values: ${where}`);
  }
}
