/**
 * Builds the matrix rows from the screen contract and the mobile inventory. Existing
 * gate states are kept, so re-seeding after the contract gains a row never reopens
 * evidence that was already recorded; rows that left the source are dropped and the
 * check reports nothing for them, so removals show up in review as a data diff.
 */
import type { ParsedContract } from "./contract.js";
import {
  IMPORT_DOMAINS,
  RELEASE_STEPS,
  mobileKey,
  type Gates,
  type Matrix,
  type MobileInventory,
  type ScreenRow,
} from "./matrix.js";

export const LANES: Matrix["lanes"] = {
  shell: { owner: "GPT (UX workspace, app shell)", reviewer: "Claude" },
  people: { owner: "box lane 1 and GPT profile lane", reviewer: "cross-family" },
  organizations: { owner: "box", reviewer: "Codex on the box" },
  access: { owner: "Claude (access lane)", reviewer: "GPT or Codex" },
  recruit: { owner: "Claude (recruit lane)", reviewer: "GPT or Codex" },
  work: { owner: "Claude (work and hours lane)", reviewer: "GPT or Codex" },
  pay: { owner: "GPT (pay F1 to F4); Claude (F5, F6, invoices)", reviewer: "cross-family" },
  comms: { owner: "Claude (comms and reports lane)", reviewer: "GPT or Codex" },
  reports: { owner: "Claude (comms and reports lane)", reviewer: "GPT or Codex" },
  platform: { owner: "box (platform operations cards)", reviewer: "Codex on the box" },
  cutover: { owner: "Claude (importer, release matrix and mobile exit lane)", reviewer: "GPT or Codex" },
};

const SLICE_LANE: Readonly<Record<string, string>> = {
  S: "people",
  O: "organizations",
  I: "access",
  R: "recruit",
  W: "work",
  F: "pay",
  C: "comms",
  P: "reports",
  X: "platform",
};

/** "S1 / SHU-92" -> people; "SHU-91 app shell" -> shell; "SHU-234" -> recruit. */
export function laneForOwner(owner: string): string {
  const slice = /^([SOIRWFCPX])\d/.exec(owner.trim());
  if (slice) return SLICE_LANE[slice[1]!]!;
  if (/SHU-91\b/.test(owner)) return "shell";
  if (/SHU-234\b/.test(owner)) return "recruit";
  return "cutover";
}

export const GATES: Matrix["gates"] = {
  screen: ["built", "verified"],
  exclusion: ["decision"],
  mobile: ["built", "verified"],
  import: ["built", "dryRun", "rehearsal", "reconciled"],
  release: ["done"],
};

function gates(names: readonly string[], previous?: Gates): Gates {
  const out: Record<string, Gates[string]> = {};
  for (const name of names) out[name] = previous?.[name] ?? { state: "open" };
  return out;
}

function row(lane: string, names: readonly string[], previous?: ScreenRow): ScreenRow {
  return { lane: previous?.lane ?? lane, gates: gates(names, previous?.gates) };
}

const RELEASE_LANE: Readonly<Record<string, string>> = {
  "X-4": "platform",
  "X-5": "platform",
  "PAY-REPLAY": "pay",
  "PAY-SHADOW": "pay",
};

export function seedMatrix(contract: ParsedContract, inventory: MobileInventory, previous?: Matrix): Matrix {
  const screens: Record<string, ScreenRow> = {};
  const exclusions: Record<string, ScreenRow> = {};
  for (const target of contract.targets.values()) {
    if (target.kind === "screen") {
      screens[target.id] = row(laneForOwner(target.owner), GATES.screen, previous?.screens[target.id]);
    } else {
      exclusions[target.id] = row("cutover", GATES.exclusion, previous?.exclusions[target.id]);
    }
  }
  const mobile: Record<string, ScreenRow> = {};
  for (const endpoint of inventory.endpoints) {
    const key = mobileKey(endpoint);
    mobile[key] = row("cutover", GATES.mobile, previous?.mobile[key]);
  }
  const imports: Record<string, ScreenRow & { title: string }> = {};
  for (const [id, title] of Object.entries(IMPORT_DOMAINS)) {
    imports[id] = { title, ...row("cutover", GATES.import, previous?.imports[id]) };
  }
  const release: Record<string, ScreenRow & { title: string }> = {};
  for (const [id, title] of Object.entries(RELEASE_STEPS)) {
    release[id] = { title, ...row(RELEASE_LANE[id] ?? "cutover", GATES.release, previous?.release[id]) };
  }
  return {
    version: 1,
    dates: previous?.dates ?? {
      goldenPath: "2026-12-01",
      mobileInventory: "2026-12-01",
      remainingParity: "2026-12-10",
      releaseCandidate: "2026-12-17",
      fullMigrationLive: "2027-01-01",
    },
    lanes: previous?.lanes ?? LANES,
    gates: GATES,
    screens,
    exclusions,
    mobile,
    imports,
    release,
  };
}
