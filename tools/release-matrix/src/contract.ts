/**
 * Reads the replacement screen contract (docs/parity/target-screen-navigation-contract.md,
 * SHU-235) and checks its section 6 legacy ledger is a complete, gap-free partition.
 *
 * This is the "contract validator" section 7 asks the delivery lane for: deleting or
 * duplicating any legacy source ordinal must fail before any browser run.
 */

export interface TargetScreen {
  readonly id: string;
  /** "screen" for section 3 targets, "exclusion" for section 5 EX rows. */
  readonly kind: "screen" | "exclusion";
  readonly route: string;
  /** Owner cell as written, e.g. "S1 / SHU-92". */
  readonly owner: string;
}

export interface LedgerRow {
  /** Appendix key, e.g. "MOB". */
  readonly app: string;
  readonly from: number;
  readonly to: number;
  readonly group: string;
  /** Target and exclusion ids the disposition names, expanded from ranges. */
  readonly targets: readonly string[];
  readonly line: number;
}

export interface ContractIssue {
  readonly rule: string;
  readonly detail: string;
}

export interface ParsedContract {
  readonly targets: ReadonlyMap<string, TargetScreen>;
  readonly ledger: readonly LedgerRow[];
  /** Totals the contract itself declares for each appendix, e.g. MOB 66. */
  readonly declaredTotals: Readonly<Record<string, number>>;
  /** Target or exclusion ids defined more than once, with both source lines. */
  readonly duplicateTargets?: readonly { readonly id: string; readonly first: number; readonly again: number }[];
}

const ID_IN_TICKS = /`((?:EX|[UCOMAG])-\d{2})(?:\.\.(\d{2}))?`/g;
const ID_TOKEN = /((?:EX|[UCOMAG])-\d{2})(?:\.\.(\d{2}))?/g;

function expandIds(text: string, pattern: RegExp): string[] {
  const ids: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const first = match[1]!;
    const last = match[2];
    if (last === undefined) {
      ids.push(first);
      continue;
    }
    const dash = first.lastIndexOf("-");
    const prefix = first.slice(0, dash + 1);
    const start = Number(first.slice(dash + 1));
    const end = Number(last);
    for (let n = start; n <= end; n += 1) ids.push(`${prefix}${String(n).padStart(2, "0")}`);
  }
  return ids;
}

function cells(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return [];
  return trimmed.slice(1, trimmed.endsWith("|") ? -1 : undefined).split("|").map((cell) => cell.trim());
}

function sectionOf(lines: readonly string[], index: number): string {
  for (let i = index; i >= 0; i -= 1) {
    const match = /^##\s+(\d+)\./.exec(lines[i]!);
    if (match) return match[1]!;
  }
  return "";
}

export function parseContract(markdown: string): ParsedContract {
  const lines = markdown.split("\n");
  const targets = new Map<string, TargetScreen>();
  const ledger: LedgerRow[] = [];
  const definedAt = new Map<string, number>();
  const duplicates: { id: string; first: number; again: number }[] = [];
  // A second definition of the same id is reported, never allowed to replace the first.
  const define = (id: string, target: TargetScreen, line: number) => {
    const first = definedAt.get(id);
    if (first !== undefined) return void duplicates.push({ id, first, again: line });
    definedAt.set(id, line);
    targets.set(id, target);
  };

  lines.forEach((line, index) => {
    const row = cells(line);
    if (row.length < 3) return;
    const section = sectionOf(lines, index);

    if (section === "3") {
      const id = /^`([UCOMAG]-\d{2})`$/.exec(row[0]!);
      if (!id) return;
      define(id[1]!, { id: id[1]!, kind: "screen", route: row[1]!, owner: row[5] ?? "" }, index + 1);
      return;
    }
    if (section === "5") {
      const id = /^`(EX-\d{2})`$/.exec(row[0]!);
      if (!id) return;
      define(id[1]!, { id: id[1]!, kind: "exclusion", route: row[1]!, owner: "SHU-213" }, index + 1);
      return;
    }
    if (section === "6") {
      const key = /^([A-Z]+)-B(\d{3})(?:\.\.(\d{3}))?$/.exec(row[0]!);
      if (!key) return;
      ledger.push({
        app: key[1]!,
        from: Number(key[2]),
        to: Number(key[3] ?? key[2]),
        group: row[1]!,
        targets: [...new Set(expandIds(row[2]!, ID_IN_TICKS))],
        line: index + 1,
      });
    }
  });

  const declaredTotals: Record<string, number> = {};
  const partition = /complete, gap-free partition:\s*([^.]+)\./.exec(markdown);
  if (partition) {
    for (const match of partition[1]!.matchAll(/([A-Z]+)\s+1[–-](\d+)/g)) {
      declaredTotals[match[1]!] = Number(match[2]);
    }
  }

  return { targets, ledger, declaredTotals, duplicateTargets: duplicates };
}

/** Ids named in free text such as "`C-01..02`" or "C-06..07"; used for data files too. */
export function idsIn(text: string): string[] {
  return [...new Set(expandIds(text, ID_TOKEN))];
}

/**
 * The ledger must cover 1..N for each declared appendix exactly once, every row must
 * name at least one known target, and no appendix may appear that the contract does
 * not declare.
 */
export function checkContract(contract: ParsedContract): ContractIssue[] {
  const issues: ContractIssue[] = [];
  for (const dup of contract.duplicateTargets ?? []) {
    issues.push({ rule: "contract.target.duplicate", detail: `${dup.id} is defined on line ${dup.first} and again on line ${dup.again}` });
  }
  const apps = Object.keys(contract.declaredTotals);
  if (apps.length === 0) {
    issues.push({ rule: "contract.partition.undeclared", detail: "section 6 does not declare its partition totals" });
  }

  const seen = new Map<string, number[]>();
  for (const row of contract.ledger) {
    if (!(row.app in contract.declaredTotals)) {
      issues.push({ rule: "contract.ledger.unknownApp", detail: `${row.app}-B${row.from} (line ${row.line}) is not a declared appendix` });
      continue;
    }
    if (row.to < row.from) {
      issues.push({ rule: "contract.ledger.reversedRange", detail: `${row.app}-B${row.from}..${row.to} (line ${row.line})` });
    }
    const ordinals = seen.get(row.app) ?? [];
    for (let n = row.from; n <= row.to; n += 1) ordinals.push(n);
    seen.set(row.app, ordinals);

    if (row.targets.length === 0) {
      issues.push({ rule: "contract.ledger.noDisposition", detail: `${row.app}-B${row.from} (line ${row.line}) names no target or exclusion` });
    }
    for (const id of row.targets) {
      if (!contract.targets.has(id)) {
        issues.push({ rule: "contract.ledger.unknownTarget", detail: `${row.app}-B${row.from} (line ${row.line}) names unknown ${id}` });
      }
    }
  }

  for (const app of apps) {
    const total = contract.declaredTotals[app]!;
    const counts = new Map<number, number>();
    for (const n of seen.get(app) ?? []) counts.set(n, (counts.get(n) ?? 0) + 1);
    for (let n = 1; n <= total; n += 1) {
      const count = counts.get(n) ?? 0;
      if (count === 0) issues.push({ rule: "contract.partition.gap", detail: `${app}-B${String(n).padStart(3, "0")} is not mapped` });
      if (count > 1) issues.push({ rule: "contract.partition.duplicate", detail: `${app}-B${String(n).padStart(3, "0")} is mapped ${count} times` });
    }
    for (const n of counts.keys()) {
      if (n < 1 || n > total) issues.push({ rule: "contract.partition.overflow", detail: `${app}-B${String(n).padStart(3, "0")} is beyond the declared ${total}` });
    }
  }

  return issues;
}
