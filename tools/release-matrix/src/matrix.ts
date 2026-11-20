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
  /**
   * Screens only: where the screen is served on main and the test that requests it. A
   * shipped route may differ from the contract's target route (staff pages live under
   * `/workspace` and `/recruit/staff`); the row says so here instead of hiding it.
   * `checkServed` proves every entry against the tree on every PR.
   */
  readonly served?: readonly ServedRoute[];
  readonly gates: Gates;
}

/**
 * One served route: `route` is a path with optional `:param` segments, `test` a
 * repository-relative test file that requests it.
 */
export interface ServedRoute {
  readonly route: string;
  readonly test: string;
  /**
   * How the cited test reaches the page: `gateway` requests it through `createGatewayServer`
   * (the route is wired), `handler` calls the page handler directly (implemented and tested,
   * wiring not proven by this test).
   */
  readonly via: "gateway" | "handler";
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
  "MOBILE-RETIRE": "cutover",
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
  "K-1": "Legacy maintenance mode built (stops writes for the final delta) and its rollback rehearsed",
  "K-4": "Every replacement journey verified end to end on staging",
  "K-5": "Final sync, single-writer cutover and rollback rehearsed",
  "K-6": "Go/no-go with Khalid: parity, safety, window, rollback",
  "K-7": "Supervised switch and stabilisation",
  "K-8": "Legacy retired after retention and recovery sign-off",
  "X-4": "Backup restore proven, timed, with row counts",
  "X-5": "Main pages measured at legacy volume",
  "PAY-REPLAY": "Twelve-month payroll replay with zero unexplained difference",
  "PAY-SHADOW": "December shadow month with zero unexplained difference",
  "MOBILE-COMPAT": "Installed store builds proven against the platform's mobile API on staging",
  "MOBILE-RETIRE": "Legacy mobile API retired at cutover, installed store builds still working",
  "REFRESH": "Daily read-only legacy refresh on staging",
  "STAFF-HOURS-FALLBACK": "Staff time export: a session left without an end shows the staff record's hours per day, as legacy did; the work lane's hoursPerDay port is wired to the staff record, not left blank",
  "SWITCHES": "Lane switches turned on at cutover as legacy stops writing each domain: WORK_LANE_ENABLED=true (with SAFE_WRITE_SIGNING_KEY) when legacy stops writing hours, after the work ports are wired in login-runtime (access managedStores and comms notices)",
};

/**
 * The requirement revision of each import domain and release step, as `<section> <id>`;
 * a row without an entry is at revision 1. Bump it when the requirement itself changes
 * (SWITCHES gains a mandatory switch, a domain gains a reconciliation): the row's subject
 * changes, so `seed` reopens its gates and `check` refuses evidence recorded for the old
 * requirement. Rewording a title without changing what it asks for keeps the revision.
 */
export const REQUIREMENT_REVISION: Readonly<Record<string, number>> = {
  // r2: the M-5 table map (docs/lanes/cutover/PLAN.md) adds per-table import rules and a
  // reconciliation count per table for staff sessions and stand-up questions and answers.
  "import M-5": 2,
};

export const requirementSubject = (section: "import" | "release", id: string): string =>
  `requirement r${REQUIREMENT_REVISION[`${section} ${id}`] ?? 1}`;

/** Methods the mobile client uses; any other spelling is a typo, not a route. */
export const HTTP_METHODS: readonly MobileEndpoint["method"][] = ["GET", "POST", "PATCH", "PUT", "DELETE"];

/**
 * A source citation's syntax: a normalized repository-relative file path and a line number
 * from 1. Absolute paths, backslashes, empty segments and `.` or `..` segments are refused.
 * Citations point into the source repository and revision the inventory records
 * (`source.repository`, `source.revision`), not into this tree, so this checks the form
 * only: it cannot tell whether that file or line exists at that revision.
 */
export function isSourceLine(source: unknown): boolean {
  if (typeof source !== "string") return false;
  const match = /^([^\s:\\]+):([1-9]\d*)$/.exec(source);
  if (!match) return false;
  return match[1]!.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * What a closed gate must cite. Evidence names an exact head or a run:
 *  - `PR #512 at 1a2b3c4` (a pull request at a commit, 7 to 40 hex characters);
 *  - `run https://github.com/<owner>/<repo>/actions/runs/<id>` (a CI or workflow run);
 *  - `PR #504 comment 6954521676` (a run report posted as a pull request comment).
 * A waiver names where the decision is recorded:
 *  - `contracts/decisions-<date>.md` (the decision record), or
 *  - `PR #393 comment 6951406632` (a decision agreed on the desk).
 * A string that only looks long enough is not evidence, and a citation is a whole token:
 * `PR #512 at 1a2b3c4-rc` or `contracts/decisions-2026-10-27.md.bak` cite nothing. A
 * citation may still sit inside longer text and end a sentence.
 */
const END = String.raw`(?![\w-]|\.\w)`;
const PR_AT_HEAD = new RegExp(String.raw`(?<![\w#/.-])PR #\d+ at [0-9a-f]{7,40}${END}`);
const RUN_URL = new RegExp(String.raw`(?<![\w/.-])run https://github\.com/[\w.-]+/[\w.-]+/actions/runs/\d+${END}(?!/)`);
const PR_COMMENT = new RegExp(String.raw`(?<![\w#/.-])PR #\d+ comment \d+${END}`);
const DECISION_RECORD = new RegExp(String.raw`(?<![\w/.-])contracts/decisions-[\w-]+\.md${END}`);

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
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      issues.push({ rule: "matrix.gate.badState", detail: `${where} is not a gate object` });
      continue;
    }
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

/**
 * Where the inventory was read: an `owner/name` repository and a 7 to 40 hex commit. Every
 * source citation is relative to this pin.
 */
export function checkProvenance(source: unknown): ContractIssue[] {
  const record = (source ?? {}) as Record<string, unknown>;
  const issues: ContractIssue[] = [];
  if (typeof record.repository !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(record.repository)) {
    issues.push({ rule: "mobile.badProvenance", detail: `inventory source.repository '${String(record.repository)}' is not owner/name` });
  }
  if (typeof record.revision !== "string" || !/^[0-9a-f]{7,40}$/.test(record.revision)) {
    issues.push({ rule: "mobile.badProvenance", detail: `inventory source.revision '${String(record.revision)}' is not a 7 to 40 hex commit` });
  }
  return issues;
}

export function checkInventory(inventory: MobileInventory, contract: ParsedContract): ContractIssue[] {
  const issues: ContractIssue[] = [...checkProvenance(inventory.source)];
  const seen = new Set<string>();
  for (const endpoint of inventory.endpoints) {
    const key = mobileKey(endpoint);
    if (seen.has(key)) issues.push({ rule: "mobile.duplicate", detail: `${key} is listed twice` });
    seen.add(key);
    if (!HTTP_METHODS.includes(endpoint.method)) issues.push({ rule: "mobile.badMethod", detail: `${key} has method '${endpoint.method}'` });
    if (!Array.isArray(endpoint.sources) || endpoint.sources.length === 0) {
      issues.push({ rule: "mobile.noSource", detail: `${key} cites no source line` });
    } else {
      for (const source of endpoint.sources) {
        if (!isSourceLine(source)) issues.push({ rule: "mobile.badSource", detail: `${key} cites '${String(source)}', not a normalized repository-relative path:line` });
      }
    }
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
  for (const id of Object.keys(IMPORT_DOMAINS)) out.set(`import ${id}`, requirementSubject("import", id));
  for (const id of Object.keys(RELEASE_STEPS)) out.set(`release ${id}`, requirementSubject("release", id));
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
        if (value?.state === "open" && PHASES.indexOf(at) <= upTo) list.push({ section, id, lane: row.lane, gate, phase: at });
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

/**
 * The literal parts of a served route: `/store/:storeId/time-approvals` -> `/store/`,
 * `/time-approvals`. Each part must appear in the gateway source and in the cited test.
 */
export function routeParts(route: string): string[] {
  return route.split(/:[A-Za-z][A-Za-z0-9]*/).filter((part) => part.length > 1 || (part === "/" && route === "/"));
}

const ROUTE_SHAPE = /^\/[A-Za-z0-9/_:.-]*$/;
const TEST_PATH = /^(apps|packages|tools)\/[A-Za-z0-9_.-]+\/test\/[A-Za-z0-9_./-]+\.(ts|mjs)$/;

/** A route literal as it is written in source: as a string, or escaped inside a regular expression. */
function appearsIn(text: string, part: string): boolean {
  return text.includes(part) || text.includes(part.replace(/\//g, "\\/"));
}

/**
 * A reference lint for built screen gates, not a proof. A screen whose `built` gate is done
 * must list where it is served; every literal part of each route must appear in the gateway
 * source and in the cited test, the test must exist, and an entry that claims `via:
 * "gateway"` must cite a test that starts `createGatewayServer`. Fragments can still match
 * unrelated strings, so the evidence is the reviewed PR; this catches stale references (a
 * renamed route, a deleted or rewritten test) on every PR.
 *
 * `read(path)` returns a repository file's text or undefined; `gateway` is the gateway
 * source the routes are looked up in.
 */
export function checkServed(matrix: Matrix, read: (file: string) => string | undefined, gateway: string): ContractIssue[] {
  const issues: ContractIssue[] = [];
  for (const [id, row] of Object.entries(matrix.screens)) {
    const served = row.served;
    const built = row.gates?.built;
    if (served === undefined) {
      if (built?.state === "done") issues.push({ rule: "matrix.served.missing", detail: `screen ${id} is built but names no served route and test` });
      continue;
    }
    if (!Array.isArray(served) || served.length === 0) {
      issues.push({ rule: "matrix.served.missing", detail: `screen ${id} has an empty or malformed served list` });
      continue;
    }
    for (const entry of served as readonly ServedRoute[]) {
      const where = `screen ${id} served ${String(entry?.route)}`;
      if (typeof entry?.route !== "string" || !ROUTE_SHAPE.test(entry.route)) {
        issues.push({ rule: "matrix.served.badRoute", detail: `${where} is not a path` });
        continue;
      }
      if (typeof entry.test !== "string" || !TEST_PATH.test(entry.test) || entry.test.split("/").some((seg: string) => seg === "." || seg === "..")) {
        issues.push({ rule: "matrix.served.badTest", detail: `${where} cites '${String(entry.test)}', not a test file under apps, packages or tools` });
        continue;
      }
      if (entry.via !== "gateway" && entry.via !== "handler") {
        issues.push({ rule: "matrix.served.badVia", detail: `${where} must say via gateway or handler` });
      }
      const parts = routeParts(entry.route);
      for (const part of parts) {
        if (!appearsIn(gateway, part)) issues.push({ rule: "matrix.served.notServed", detail: `${where}: '${part}' is not in the gateway source` });
      }
      const text = read(entry.test);
      if (text === undefined) {
        issues.push({ rule: "matrix.served.testMissing", detail: `${where} cites ${entry.test}, which does not exist` });
        continue;
      }
      for (const part of parts) {
        if (!appearsIn(text, part)) issues.push({ rule: "matrix.served.testSilent", detail: `${where}: ${entry.test} never requests '${part}'` });
      }
      if (entry.via === "gateway" && !text.includes("createGatewayServer")) {
        issues.push({ rule: "matrix.served.notThroughGateway", detail: `${where} claims gateway wiring but ${entry.test} never starts createGatewayServer` });
      }
    }
  }
  return issues;
}

/** When each gate is due: built gates by remaining parity, the rest by their checkpoint. */
export function dueDate(matrix: Matrix, section: string, id: string, gate: string): string {
  const phase = phaseOf(section, id);
  if (phase === "cutover") return matrix.dates.fullMigrationLive ?? "2027-01-01";
  if (phase === "retired") return "after cutover";
  if (gate === "built" && (section === "screen" || section === "mobile")) return matrix.dates.remainingParity ?? "2026-12-10";
  return matrix.dates.releaseCandidate ?? "2026-12-17";
}

export interface Burndown {
  readonly rows: { readonly section: string; readonly gate: string; readonly done: number; readonly waived: number; readonly total: number }[];
  readonly due: { readonly date: string; readonly open: number; readonly days: number | null; readonly perDay: number | null }[];
}

/** Closed and open gates by section, and how many must close per day to meet each date. */
export function burndown(matrix: Matrix, today: string): Burndown {
  const sections: [string, Readonly<Record<string, ScreenRow>>][] = [
    ["screen", matrix.screens],
    ["exclusion", matrix.exclusions],
    ["mobile", matrix.mobile],
    ["import", matrix.imports],
    ["release", matrix.release],
  ];
  const rows: Burndown["rows"][number][] = [];
  const openByDate = new Map<string, number>();
  for (const [section, entries] of sections) {
    const tally = new Map<string, { done: number; waived: number; total: number }>();
    for (const [id, row] of Object.entries(entries)) {
      for (const [gate, value] of Object.entries(row.gates)) {
        const t = tally.get(gate) ?? { done: 0, waived: 0, total: 0 };
        t.total += 1;
        if (value?.state === "done") t.done += 1;
        else if (value?.state === "waived") t.waived += 1;
        else {
          const date = dueDate(matrix, section, id, gate);
          openByDate.set(date, (openByDate.get(date) ?? 0) + 1);
        }
        tally.set(gate, t);
      }
    }
    for (const [gate, t] of tally) rows.push({ section, gate, ...t });
  }
  const start = Date.parse(`${today}T00:00:00Z`);
  let cumulative = 0;
  const due = [...openByDate.keys()].sort().map((date) => {
    cumulative += openByDate.get(date)!;
    const end = Date.parse(`${date}T00:00:00Z`);
    if (Number.isNaN(end)) return { date, open: cumulative, days: null, perDay: null };
    const days = Math.max(0, Math.round((end - start) / 86_400_000));
    return { date, open: cumulative, days, perDay: days > 0 ? Math.ceil((cumulative / days) * 10) / 10 : null };
  });
  return { rows, due };
}
