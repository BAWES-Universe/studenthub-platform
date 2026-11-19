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
  /** Appendices whose partition total is declared more than once. */
  readonly duplicateTotals?: readonly string[];
  /** Lines in markdown the parser does not model, so it cannot say what a reader sees there. */
  readonly unsupported?: readonly { readonly line: number; readonly reason: string }[];
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

/** Why a non-blank line falls outside the subset parseContract models, or undefined. */
function unsupportedReason(line: string): string | undefined {
  if (/^[ \t]/.test(line)) return "indented line";
  if (/^(?:`{3,}|~{3,})/.test(line)) return "code fence";
  if (line.startsWith("<")) return "HTML block";
  if (line.startsWith(">")) return "block quote";
  if (/^(?:=+|-+)[ \t]*$/.test(line)) return "setext underline or thematic break";
  // Code spans are taken out first: `reference.<catalogue>` is text, not a tag.
  const outsideCode = line.replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, "");
  if (/<(?:[A-Za-z/!?])/.test(outsideCode)) return "inline HTML";
  return undefined;
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

  // The parser reads a strict subset of GitHub markdown and refuses everything else, so
  // what it counts is exactly what a reader sees. The subset is the one the contract uses:
  //   - ATX headings (`#` to `######`) starting in column 1;
  //   - GFM tables starting in column 1, after a blank line or a heading: a header row, a
  //     delimiter row with the same number of cells, and body rows with that number of
  //     cells, ended by a blank line or a heading;
  //   - paragraph and list text starting in column 1;
  //   - blank lines.
  // Refused, with the line number, because each can change what a reader sees without the
  // parser modelling it: any leading indentation (code blocks, list continuations, tabs),
  // fence-like lines (``` or ~~~, valid fences or not), HTML blocks and inline HTML outside
  // code spans (comments, tags), block quotes, setext underlines, escaped pipes in a table,
  // a pipe row outside a table, and text inside a table that GFM would turn into a row.
  const unsupported: { line: number; reason: string }[] = [];
  const refuse = (index: number, reason: string) => void unsupported.push({ line: index + 1, reason });
  const accepted: string[] = [];
  let section = "";
  let tableWidth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.replace(/\r$/, "");
    if (/^[ \t]*$/.test(line)) {
      tableWidth = 0;
      accepted.push(line);
      continue;
    }
    const reason = unsupportedReason(line);
    if (reason) {
      refuse(index, reason);
      tableWidth = 0;
      continue;
    }
    if (/^#{1,6}(?:[ \t]|$)/.test(line)) {
      tableWidth = 0;
      accepted.push(line);
      if (/^##(?:[ \t]|$)/.test(line)) section = /^##[ \t]+(\d+)\./.exec(line)?.[1] ?? "";
      else if (/^#(?:[ \t]|$)/.test(line)) section = "";
      continue;
    }
    if (!line.startsWith("|")) {
      if (tableWidth > 0) {
        refuse(index, "text inside a table");
        continue;
      }
      accepted.push(line);
      continue;
    }
    if (line.includes("\\|")) {
      refuse(index, "escaped pipe in a table row");
      continue;
    }
    const row = cells(line);
    if (tableWidth === 0) {
      const previous = index === 0 ? "" : lines[index - 1]!.replace(/\r$/, "");
      const delimiter = cells(lines[index + 1]?.replace(/\r$/, "") ?? "");
      const opensTable =
        (/^[ \t]*$/.test(previous) || /^#{1,6}(?:[ \t]|$)/.test(previous)) &&
        delimiter.length === row.length &&
        delimiter.every((cell) => /^:?-+:?$/.test(cell));
      if (!opensTable) {
        refuse(index, "pipe row outside a table");
        continue;
      }
      tableWidth = row.length;
      accepted.push(line, lines[index + 1]!);
      index += 1;
      continue;
    }
    if (row.length !== tableWidth) {
      refuse(index, `table row with ${row.length} cells in a ${tableWidth}-column table`);
      continue;
    }
    accepted.push(line);
    if (row.length < 3) continue;

    if (section === "3") {
      const id = /^`([UCOMAG]-\d{2})`$/.exec(row[0]!);
      if (!id) continue;
      define(id[1]!, { id: id[1]!, kind: "screen", route: row[1]!, owner: row[5] ?? "" }, index + 1);
      continue;
    }
    if (section === "5") {
      const id = /^`(EX-\d{2})`$/.exec(row[0]!);
      if (!id) continue;
      define(id[1]!, { id: id[1]!, kind: "exclusion", route: row[1]!, owner: "SHU-213" }, index + 1);
      continue;
    }
    if (section === "6") {
      const key = /^([A-Z]+)-B(\d{3})(?:\.\.(\d{3}))?$/.exec(row[0]!);
      if (!key) continue;
      ledger.push({
        app: key[1]!,
        from: Number(key[2]),
        to: Number(key[3] ?? key[2]),
        group: row[1]!,
        targets: [...new Set(expandIds(row[2]!, ID_IN_TICKS))],
        line: index + 1,
      });
    }
  }

  const declaredTotals: Record<string, number> = {};
  const duplicateTotals: string[] = [];
  const partition = /complete, gap-free partition:\s*([^.]+)\./.exec(accepted.join("\n"));
  if (partition) {
    for (const match of partition[1]!.matchAll(/([A-Z]+)\s+1[–-](\d+)/g)) {
      // A second total for the same appendix is reported, never allowed to replace the first.
      if (match[1]! in declaredTotals) duplicateTotals.push(match[1]!);
      else declaredTotals[match[1]!] = Number(match[2]);
    }
  }

  return { targets, ledger, declaredTotals, duplicateTargets: duplicates, duplicateTotals, unsupported };
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
  for (const { line, reason } of contract.unsupported ?? []) {
    issues.push({ rule: "contract.markdown.unsupported", detail: `line ${line}: ${reason}` });
  }
  for (const app of contract.duplicateTotals ?? []) {
    issues.push({ rule: "contract.partition.declaredTwice", detail: `section 6 declares the ${app} total more than once` });
  }
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
