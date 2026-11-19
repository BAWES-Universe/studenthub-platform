/**
 * The release matrix: one row per target screen, exclusion, mobile endpoint, import
 * domain and release step, each with gates that only close on recorded evidence.
 *
 * `checkMatrix` is structural (does the matrix cover exactly what the contract and the
 * mobile inventory say exists). `blockers` is the release question (what is still open).
 * The 17 Dec candidate needs zero blockers; the check must pass on every PR.
 */
import type { ContractIssue, ParsedContract } from "./contract.js";

export type GateState =
  | { readonly state: "open"; readonly note?: string }
  | { readonly state: "done"; readonly evidence: string }
  | { readonly state: "waived"; readonly decision: string };

export type Gates = Readonly<Record<string, GateState>>;

export interface LaneRow {
  readonly owner: string;
  readonly reviewer: string;
}

export interface ScreenRow {
  readonly lane: string;
  /**
   * What the row's evidence was recorded against: the route for a screen or exclusion,
   * `<target> <disposition>` for a mobile endpoint. When the source changes it, the row's
   * evidence no longer applies: `seed` reopens the gates and `check` refuses the old row.
   */
  readonly subject?: string;
  readonly gates: Gates;
}

export interface MobileEndpoint {
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  readonly path: string;
  readonly target: string;
  readonly disposition: "serve" | "retire" | "open";
  readonly sources: readonly string[];
  readonly note?: string;
}

export interface MobileInventory {
  readonly source: Readonly<Record<string, string>>;
  readonly endpoints: readonly MobileEndpoint[];
}

export interface Matrix {
  readonly version: 1;
  readonly dates: Readonly<Record<string, string>>;
  readonly lanes: Readonly<Record<string, LaneRow>>;
  readonly gates: {
    readonly screen: readonly string[];
    readonly exclusion: readonly string[];
    readonly mobile: readonly string[];
    readonly import: readonly string[];
    readonly release: readonly string[];
  };
  readonly screens: Readonly<Record<string, ScreenRow>>;
  readonly exclusions: Readonly<Record<string, ScreenRow>>;
  readonly mobile: Readonly<Record<string, ScreenRow>>;
  readonly imports: Readonly<Record<string, ScreenRow & { readonly title: string }>>;
  readonly release: Readonly<Record<string, ScreenRow & { readonly title: string }>>;
}

/**
 * Which checkpoint a release step belongs to. `release` checks one checkpoint and every
 * one before it: `candidate` (17 Dec), `cutover` (31 Dec to 1 Jan), `retired` (legacy
 * switched off after retention sign-off). Every other row is a candidate gate.
 */
export const PHASES = ["candidate", "cutover", "retired"] as const;
export type Phase = (typeof PHASES)[number];

export const RELEASE_PHASE: Readonly<Record<string, Phase>> = {
  "K-6": "cutover",
  "K-7": "cutover",
  "PAY-SHADOW": "cutover",
  SWITCHES: "cutover",
  "K-8": "retired",
};

export function phaseOf(section: string, id: string): Phase {
  return section === "release" ? (RELEASE_PHASE[id] ?? "candidate") : "candidate";
}

/** The canonical gate registry; `matrix.json` must carry exactly this. */
export const GATES: Matrix["gates"] = {
  screen: ["built", "verified"],
  exclusion: ["decision"],
  mobile: ["built", "verified"],
  import: ["built", "dryRun", "rehearsal", "reconciled"],
  release: ["done"],
};

export const mobileSubject = (endpoint: Pick<MobileEndpoint, "target" | "disposition">): string =>
  `${endpoint.target} ${endpoint.disposition}`;

export interface Blocker {
  readonly section: string;
  readonly id: string;
  readonly lane: string;
  readonly gate: string;
  readonly phase: Phase;
}

/** Import domains from contracts/ops-migration-cutover.md (data migration). */
export const IMPORT_DOMAINS: Readonly<Record<string, string>> = {
  "M-1": "People: legacy candidate rows into profiles, with a reconciliation report",
  "M-2": "Documents: the four kinds copied from legacy storage with checksums",
  "M-3": "Identity links: bulk report of unlinked, multiply-offered and conflicting records",
  "M-4": "Organizations, stores, contacts and catalogues, with id maps",
  "M-5": "Work, recruit and finance history, each reconciled to legacy totals",
  "M-6": "Full baseline import rehearsed on the approved copy, every domain reconciled",
  "M-7": "Incremental import: deltas, deletions and restart safety for the final sync",
};

/** Release steps that are not one screen: cutover chain, proofs and the mobile exit. */
export const RELEASE_STEPS: Readonly<Record<string, string>> = {
  "K-1": "Legacy read-only switch for the final delta, with rollback",
  "K-4": "Every replacement journey verified end to end on staging",
  "K-5": "Final sync, single-writer cutover and rollback rehearsed",
  "K-6": "Go/no-go with Khalid: parity, safety, window, rollback",
  "K-7": "Supervised switch and stabilisation",
  "K-8": "Legacy retired after retention and recovery sign-off",
  "X-4": "Backup restore proven, timed, with row counts",
  "X-5": "Main pages measured at legacy volume",
  "PAY-REPLAY": "Twelve-month payroll replay with zero unexplained difference",
  "PAY-SHADOW": "December shadow month with zero unexplained difference",
  "MOBILE-COMPAT": "Installed mobile builds work against the platform with legacy API retired",
  "REFRESH": "Daily read-only legacy refresh on staging",
  "SWITCHES": "Lane switches turned on at cutover as legacy stops writing each domain: WORK_LANE_ENABLED=true (with SAFE_WRITE_SIGNING_KEY) when legacy stops writing hours, after the work ports are wired in login-runtime (access managedStores and comms notices)",
};

/**
 * What a closed gate must cite. Evidence names an exact head or a run:
 *  - `PR #512 at 1a2b3c4` (a pull request at a commit, 7 to 40 hex characters);
 *  - `run https://github.com/<owner>/<repo>/actions/runs/<id>` (a CI or workflow run);
 *  - `PR #504 comment 6954521676` (a run report posted as a pull request comment).
 * A waiver names where the decision is recorded:
 *  - `contracts/decisions-<date>.md` (the decision record), or
 *  - `PR #393 comment 6951406632` (a decision agreed on the desk).
 * A string that only looks long enough is not evidence.
 */
const PR_AT_HEAD = /\bPR #\d+ at [0-9a-f]{7,40}\b/;
const RUN_URL = /\brun https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+\b/;
const PR_COMMENT = /\bPR #\d+ comment \d+\b/;
const DECISION_RECORD = /\bcontracts\/decisions-[\w-]+\.md\b/;

export function citesEvidence(text: string): boolean {
  return PR_AT_HEAD.test(text) || RUN_URL.test(text) || PR_COMMENT.test(text);
}

export function citesDecision(text: string): boolean {
  return DECISION_RECORD.test(text) || PR_COMMENT.test(text);
}

export const mobileKey = (endpoint: Pick<MobileEndpoint, "method" | "path">): string =>
  `${endpoint.method} ${endpoint.path}`;

function sameKeys(rule: string, label: string, actual: readonly string[], expected: readonly string[]): ContractIssue[] {
  const issues: ContractIssue[] = [];
  const have = new Set(actual);
  const want = new Set(expected);
  for (const key of expected) if (!have.has(key)) issues.push({ rule: `${rule}.missing`, detail: `${label} ${key} has no matrix row` });
  for (const key of actual) if (!want.has(key)) issues.push({ rule: `${rule}.unknown`, detail: `${label} ${key} is not in the source` });
  return issues;
}

function checkGates(section: string, id: string, row: ScreenRow, required: readonly string[], lanes: Matrix["lanes"]): ContractIssue[] {
  const issues: ContractIssue[] = [];
  if (!(row.lane in lanes)) issues.push({ rule: "matrix.lane.unknown", detail: `${section} ${id} names unknown lane '${row.lane}'` });
  issues.push(...sameKeys("matrix.gate", `${section} ${id} gate`, Object.keys(row.gates ?? {}), required));
  for (const [gate, value] of Object.entries(row.gates ?? {})) {
    const where = `${section} ${id} gate ${gate}`;
    if (value.state === "done") {
      if (typeof value.evidence !== "string" || value.evidence.trim().length === 0) {
        issues.push({ rule: "matrix.gate.doneWithoutEvidence", detail: `${where} is done without evidence` });
      } else if (!citesEvidence(value.evidence)) {
        issues.push({ rule: "matrix.gate.evidenceUnsourced", detail: `${where} evidence names no PR at a head, run or run report` });
      }
    } else if (value.state === "waived") {
      if (typeof value.decision !== "string" || value.decision.trim().length === 0) {
        issues.push({ rule: "matrix.gate.waivedWithoutDecision", detail: `${where} is waived without a recorded decision` });
      } else if (!citesDecision(value.decision)) {
        issues.push({ rule: "matrix.gate.decisionUnsourced", detail: `${where} waiver names no decision record or desk comment` });
      }
    } else if (value.state !== "open") {
      issues.push({ rule: "matrix.gate.badState", detail: `${where} has state '${(value as { state: string }).state}'` });
    }
  }
  return issues;
}

export function checkInventory(inventory: MobileInventory, contract: ParsedContract): ContractIssue[] {
  const issues: ContractIssue[] = [];
  const seen = new Set<string>();
  for (const endpoint of inventory.endpoints) {
    const key = mobileKey(endpoint);
    if (seen.has(key)) issues.push({ rule: "mobile.duplicate", detail: `${key} is listed twice` });
    seen.add(key);
    if (!endpoint.sources?.length) issues.push({ rule: "mobile.noSource", detail: `${key} cites no source line` });
    const target = contract.targets.get(endpoint.target);
    if (!target) {
      issues.push({ rule: "mobile.unknownTarget", detail: `${key} maps to unknown ${endpoint.target}` });
      continue;
    }
    if (endpoint.disposition === "serve" && target.kind !== "screen") {
      issues.push({ rule: "mobile.serveNeedsScreen", detail: `${key} is served but maps to exclusion ${endpoint.target}` });
    }
    if (endpoint.disposition === "retire" && target.kind !== "exclusion") {
      issues.push({ rule: "mobile.retireNeedsExclusion", detail: `${key} is retired but maps to screen ${endpoint.target}` });
    }
    if (endpoint.disposition !== "serve" && !endpoint.note) {
      issues.push({ rule: "mobile.noteRequired", detail: `${key} is '${endpoint.disposition}' without a note saying why` });
    }
    if (!["serve", "retire", "open"].includes(endpoint.disposition)) {
      issues.push({ rule: "mobile.badDisposition", detail: `${key} has disposition '${endpoint.disposition}'` });
    }
  }
  return issues;
}

/** `<section> <id>` -> the subject its evidence must have been recorded against. */
export function expectedSubjects(contract: ParsedContract, inventory: MobileInventory): Map<string, string> {
  const out = new Map<string, string>();
  for (const target of contract.targets.values()) out.set(`${target.kind} ${target.id}`, target.route);
  for (const endpoint of inventory.endpoints) out.set(`mobile ${mobileKey(endpoint)}`, mobileSubject(endpoint));
  return out;
}

export function checkMatrix(matrix: Matrix, contract: ParsedContract, inventory: MobileInventory): ContractIssue[] {
  const issues: ContractIssue[] = [];
  const screens = [...contract.targets.values()].filter((t) => t.kind === "screen").map((t) => t.id);
  const exclusions = [...contract.targets.values()].filter((t) => t.kind === "exclusion").map((t) => t.id);

  issues.push(...sameKeys("matrix.screens", "screen", Object.keys(matrix.screens), screens));
  issues.push(...sameKeys("matrix.exclusions", "exclusion", Object.keys(matrix.exclusions), exclusions));
  issues.push(...sameKeys("matrix.mobile", "mobile endpoint", Object.keys(matrix.mobile), inventory.endpoints.map(mobileKey)));
  issues.push(...sameKeys("matrix.imports", "import domain", Object.keys(matrix.imports), Object.keys(IMPORT_DOMAINS)));
  issues.push(...sameKeys("matrix.release", "release step", Object.keys(matrix.release), Object.keys(RELEASE_STEPS)));

  if (JSON.stringify(matrix.gates) !== JSON.stringify(GATES)) {
    issues.push({ rule: "matrix.gates.notCanonical", detail: "matrix.json gates differ from the registry in matrix.ts" });
  }
  const sections: [string, Readonly<Record<string, ScreenRow>>, readonly string[]][] = [
    ["screen", matrix.screens, GATES.screen],
    ["exclusion", matrix.exclusions, GATES.exclusion],
    ["mobile", matrix.mobile, GATES.mobile],
    ["import", matrix.imports, GATES.import],
    ["release", matrix.release, GATES.release],
  ];
  for (const [section, rows, required] of sections) {
    for (const [id, row] of Object.entries(rows)) issues.push(...checkGates(section, id, row, required, matrix.lanes));
  }

  const subjects = expectedSubjects(contract, inventory);
  for (const [section, rows] of sections) {
    for (const [id, row] of Object.entries(rows)) {
      const want = subjects.get(`${section} ${id}`);
      if (want !== undefined && row.subject !== want) {
        issues.push({ rule: "matrix.row.stale", detail: `${section} ${id} was recorded for '${row.subject ?? ""}' but the source now says '${want}'` });
      }
    }
  }
  return issues;
}

/**
 * Everything still open up to and including `phase` (default: every checkpoint). The
 * 17 Dec candidate is `blockers(matrix, inventory, "candidate")`.
 */
export function blockers(matrix: Matrix, inventory: MobileInventory, phase: Phase = "retired"): Blocker[] {
  const upTo = PHASES.indexOf(phase);
  const list: Blocker[] = [];
  const sections: [string, Readonly<Record<string, ScreenRow>>][] = [
    ["screen", matrix.screens],
    ["exclusion", matrix.exclusions],
    ["mobile", matrix.mobile],
    ["import", matrix.imports],
    ["release", matrix.release],
  ];
  for (const [section, rows] of sections) {
    for (const [id, row] of Object.entries(rows)) {
      for (const [gate, value] of Object.entries(row.gates)) {
        const at = phaseOf(section, id);
        if (value.state === "open" && PHASES.indexOf(at) <= upTo) list.push({ section, id, lane: row.lane, gate, phase: at });
      }
    }
  }
  for (const endpoint of inventory.endpoints) {
    if (endpoint.disposition === "open") {
      const key = mobileKey(endpoint);
      list.push({ section: "mobile", id: key, lane: matrix.mobile[key]?.lane ?? "cutover", gate: "disposition", phase: "candidate" });
    }
  }
  return list;
}
