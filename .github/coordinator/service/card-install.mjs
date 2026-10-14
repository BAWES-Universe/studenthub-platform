// SHU-322, Card B: the box installs the next card queue itself.
//
// When the committed queue is done (QUEUE_DONE) at an installed revision R the
// prerequisite receipt reads VERIFIED, a timer start reads main as the
// coordinator user (card-prepare's mainTip) and gets N. N equal to R, or an N
// whose committed dispatch_scope is R's, is nothing to install: a silent skip.
// Otherwise N is installed only inside the boundary both autopilot cards share
// (selfInstallGate, pure):
//
//   * R is an ancestor of N;
//   * every changed .github/coordinator path is config.json,
//     card-contracts.mjs, service/suite-inventory.json or under a test/
//     directory, and none is deleted;
//   * card-contracts.mjs only gains lines;
//   * config.json, parsed: every key but dispatch_scope and card_lanes is
//     deep-equal, R's card_lanes are an exact prefix of N's, and the new
//     dispatch_scope is 2 to 5 cards, every one a new lane that has not landed
//     and has its own CARD_CONTRACTS entry added at N;
//   * every changed coordinator blob at N is the blob a Card A REVIEW_PASS
//     claim (card-review-auto-pr<N>-<head>.json, root's own file) recorded at
//     that pull request's exact head;
//   * main's checks at N are green (card-land's reader).
//
// The reason for the boundary: install, rollback and the timer run the
// checkout's code as root, so only reviewed queue data may reach the host
// without a person. Any other coordinator change stays a human install.
//
// A failed read is a skip that claims nothing. A definite refusal is claimed
// once (card-install-auto-<N>.json, written wx), reported once on SHU-71 and
// reads NEEDS_OWNER. An admitted N is installed under the card-run lock, the
// pause file read again before every step: claim, idle host, fast-forward
// merge of N as the coordinator user, rollback of R's prerequisites, install,
// verify and precondition of N, then a plan check in a child process that runs
// N's own card-run.mjs. Then the start reports and exits; the next timer start
// runs the queue's first card, never this process, which already imported R's
// code. Any failure writes the pause file with its reason and reports. A
// verify or precondition failure rolls N's prerequisites back; R is never
// reinstalled by the box. The timer only ever creates the pause file.
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { inPushRepository, mainTip, coordinatorRunner, postRunReport, plainReason, reportMarker, PUSH_TIMEOUT_SECONDS,
  readCoordinatorCredentials } from "./card-prepare.mjs";
import { boundedFetch, github, readCommitChecks } from "./card-land.mjs";
import { BROKER_GIT_CONFIG_ARGS, validateRepoUrl } from "../push-broker.mjs";
import { MAX_CARD_QUEUE } from "../single-run-activation.mjs";

const SHA_RE = /^[0-9a-f]{40}$/;
const CARD_ID_RE = /^SHU-[1-9]\d*$/;
const COORDINATOR = ".github/coordinator/";
export const CONFIG_PATH = ".github/coordinator/config.json";
export const CONTRACTS_PATH = ".github/coordinator/card-contracts.mjs";
export const INVENTORY_PATH = ".github/coordinator/service/suite-inventory.json";
export const INSTALLABLE_PATHS = Object.freeze([CONFIG_PATH, CONTRACTS_PATH, INVENTORY_PATH]);
export const PROVISIONER = ".github/coordinator/service/provision-shu71-prerequisites.mjs";
export const CARD_RUN = ".github/coordinator/service/card-run.mjs";
export const MIN_INSTALL_QUEUE = 2;
export const INSTALL_STEPS = Object.freeze(["claim", "idle", "merge", "rollback", "install", "verify", "precondition", "plan"]);
export const INSTALL_REQUEST_TIMEOUT_MS = 30 * 1000;
const REVIEW_CLAIM_RE = /^card-review-auto-pr([1-9]\d*)-([0-9a-f]{40})\.json$/;

export const installClaim = (paths, main) => path.join(paths.stateDir, `card-install-auto-${main}.json`);
export const installActivationId = (main) => `card-install-${main}`;

// The same rule as Card A's queue config paths: one of the exact files, or a
// file under a test/ directory of the coordinator.
export function installablePath(file) {
  if (typeof file !== "string" || !file.startsWith(COORDINATOR)) return false;
  const parts = file.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return false;
  return INSTALLABLE_PATHS.includes(file) || parts.slice(2, -1).includes("test");
}

// The card ids with an entry in the CARD_CONTRACTS object of a contracts
// source, read as text: N's code is never imported here.
export function contractEntries(text) {
  const source = String(text ?? "");
  const start = source.indexOf("export const CARD_CONTRACTS = Object.freeze({\n");
  if (start < 0) return null;
  const end = source.indexOf("\n});", start);
  if (end < 0) return null;
  const block = source.slice(start, end);
  return new Set([...block.matchAll(/^ {2}"(SHU-[1-9]\d*)": Object\.freeze\(\{/gm)].map((match) => match[1]));
}

const parse = (text) => { try { return JSON.parse(text); } catch { return undefined; } };
const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// The whole boundary, from facts read elsewhere. Returns ok with the queue, or
// why not: quiet (nothing new to install), transient (read again later) or a
// definite refusal for the owner.
export function selfInstallGate(facts) {
  const no = (reason, kind = {}) => ({ ok: false, transient: false, quiet: false, ...kind, reason });
  const { revision, main } = facts ?? {};
  if (!SHA_RE.test(revision ?? "") || !SHA_RE.test(main ?? "")) return no("the installed revision or main is not a full SHA", { transient: true });
  if (main === revision) return no("main is the installed revision", { quiet: true });
  if (facts.descends !== true) return no(`main at ${main} does not descend from the installed revision ${revision}`);
  const installed = parse(facts.configs?.installed);
  const next = parse(facts.configs?.main);
  if (!plainObject(installed)) return no("the installed config.json cannot be read", { transient: true });
  if (!plainObject(next)) return no("config.json at main is not a JSON object");
  if (isDeepStrictEqual(installed.dispatch_scope, next.dispatch_scope)) return no("main commits no new dispatch_scope", { quiet: true });

  const changes = facts.changes;
  if (!Array.isArray(changes) || changes.length === 0) return no("the coordinator changes cannot be read", { transient: true });
  for (const change of changes) {
    if (!installablePath(change?.path)) return no(`${String(change?.path)} is not a queue config path`);
    if (!["A", "M"].includes(change.status)) return no(`${change.path} is ${change.status === "D" ? "deleted" : `changed as ${String(change.status)}`}; only additions and edits install themselves`);
  }
  const contracts = changes.find((change) => change.path === CONTRACTS_PATH);
  if (contracts && (contracts.status !== "M" || facts.contractLines?.deleted !== 0 || !Number.isInteger(facts.contractLines?.added))) {
    return no(`${CONTRACTS_PATH} may only gain lines`);
  }

  const keys = new Set([...Object.keys(installed), ...Object.keys(next)]);
  for (const key of keys) {
    if (key === "dispatch_scope" || key === "card_lanes") continue;
    if (!Object.hasOwn(installed, key) || !Object.hasOwn(next, key) || !isDeepStrictEqual(installed[key], next[key])) {
      return no(`config.json changes ${key}; only dispatch_scope and appended card_lanes install themselves`);
    }
  }
  const before = installed.card_lanes;
  const after = next.card_lanes;
  if (!Array.isArray(before) || !Array.isArray(after) || after.length <= before.length
      || !before.every((lane, i) => isDeepStrictEqual(lane, after[i]))) {
    return no("card_lanes at main are not the installed card_lanes with lanes appended");
  }
  const added = after.slice(before.length).map((lane) => lane?.id);
  const known = new Set(before.map((lane) => lane?.id));
  if (added.some((id) => typeof id !== "string" || !CARD_ID_RE.test(id) || known.has(id)) || new Set(added).size !== added.length) {
    return no("an appended card lane has no new canonical id");
  }
  const scope = next.dispatch_scope;
  const ids = scope?.issue_ids;
  if (!plainObject(scope) || JSON.stringify(Object.keys(scope)) !== JSON.stringify(["issue_ids"]) || !Array.isArray(ids)) {
    return no("dispatch_scope at main is not a plain issue_ids list");
  }
  if (ids.length < MIN_INSTALL_QUEUE || ids.length > MAX_CARD_QUEUE || new Set(ids).size !== ids.length) {
    return no(`the new dispatch_scope must name ${MIN_INSTALL_QUEUE} to ${MAX_CARD_QUEUE} distinct cards`);
  }
  for (const id of ids) if (!added.includes(id)) return no(`${String(id)} in the new dispatch_scope is not a newly appended card lane`);
  const landed = new Set(facts.landed ?? []);
  for (const id of ids) if (landed.has(id)) return no(`${id} already landed`);
  const installedContracts = contractEntries(facts.contractTexts?.installed);
  const nextContracts = contractEntries(facts.contractTexts?.main);
  if (!installedContracts || !nextContracts) return no("CARD_CONTRACTS cannot be read at both revisions");
  for (const id of ids) {
    if (installedContracts.has(id) || !nextContracts.has(id)) return no(`${id} has no CARD_CONTRACTS entry added at main`);
  }

  const passes = Array.isArray(facts.passes) ? facts.passes : [];
  for (const change of changes) {
    if (!SHA_RE.test(facts.blobs?.[change.path] ?? "")) return no(`${change.path} has no readable blob at main`);
  }
  // One review covers the whole change: blobs passed in different pull
  // requests were never reviewed together.
  const review = passes.find((entry) => changes.every((change) => entry?.files?.[change.path]?.sha === facts.blobs[change.path]));
  if (!review) return no(`the coordinator changes at main are not the blobs one REVIEW_PASS claim recorded at an exact pull request head`);

  const checks = facts.checks;
  if (Array.isArray(checks?.red) && checks.red.length) return no(`main's checks at ${main} are red: ${checks.red.join(", ")}`);
  if (checks?.green !== true) return no(`main's checks at ${main} are not green yet: ${checks?.note ?? "unread"}`, { transient: true });
  return { ok: true, queue: [...ids], lanes: added };
}

// A passed review as a Card A claim records it. The supervisor ends a passed
// review-only episode as "review PASS" (single-run-activation.mjs checks a
// PASS before the review-only branch), so card-run reads it as PASS; the
// review-only form is REVIEW_PASS. Only Card A writes these claim files.
export const REVIEW_PASSED = Object.freeze(new Set(["PASS", "REVIEW_PASS"]));

// Root's own passed-review claims: regular files owned by root whose content
// names the pull request and head of their own file name.
export function reviewPasses(io, paths) {
  const passes = [];
  for (const file of io.fs.readdirSync(paths.stateDir)) {
    const match = REVIEW_CLAIM_RE.exec(file);
    if (!match) continue;
    const full = path.join(paths.stateDir, file);
    try {
      const stat = io.fs.lstatSync(full);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0) continue;
      const claim = JSON.parse(io.fs.readFileSync(full, "utf8"));
      if (claim?.pr === Number(match[1]) && claim.head === match[2] && REVIEW_PASSED.has(claim.outcome) && plainObject(claim.files)) {
        passes.push({ pr: claim.pr, head: claim.head, files: claim.files });
      }
    } catch { /* an unreadable claim proves nothing */ }
  }
  return passes;
}

function transientError(reason) {
  return Object.assign(new Error(reason), { transient: true });
}

// Everything git says about R..N, read in the coordinator's fresh bare
// repository that borrows the checkout's objects, so the checkout's own config
// never applies. Each failed git read is transient.
export function readMainFacts(git, credentials, revision) {
  let main;
  try {
    main = mainTip(git, credentials, revision);
  } catch (error) {
    if (error.notDescendant && SHA_RE.test(error.tip ?? "")) return { revision, main: error.tip, descends: false };
    throw transientError(error.message);
  }
  if (main === revision) return { revision, main, descends: true };
  const read = (args, what) => {
    const result = git(args);
    if (result.status !== 0) throw transientError(`${what} cannot be read (git exit ${result.status})`);
    return String(result.stdout ?? "");
  };
  const fields = read(["diff", "--no-ext-diff", "--no-renames", "--name-status", "-z", revision, main, "--", ".github/coordinator"], "the coordinator diff")
    .split("\0");
  const changes = [];
  for (let i = 0; i + 1 < fields.length; i += 2) changes.push({ status: fields[i], path: fields[i + 1] });
  let contractLines = null;
  if (changes.some((change) => change.path === CONTRACTS_PATH)) {
    const numstat = /^(\d+)\t(\d+)\t/.exec(read(["diff", "--no-ext-diff", "--no-renames", "--numstat", revision, main, "--", CONTRACTS_PATH], "the contracts diff"));
    contractLines = numstat ? { added: Number(numstat[1]), deleted: Number(numstat[2]) } : { added: null, deleted: null };
  }
  const blobText = (rev, file) => read(["cat-file", "blob", `${rev}:${file}`], `${file} at ${rev}`);
  const blobs = {};
  for (const row of read(["ls-tree", "-r", "-z", main, "--", ".github/coordinator"], "the coordinator tree at main").split("\0")) {
    const match = /^\d{6} blob ([0-9a-f]{40})\t(.+)$/.exec(row);
    if (match) blobs[match[2]] = match[1];
  }
  return {
    revision, main, descends: true, changes, contractLines, blobs,
    configs: { installed: blobText(revision, CONFIG_PATH), main: blobText(main, CONFIG_PATH) },
    contractTexts: { installed: blobText(revision, CONTRACTS_PATH), main: blobText(main, CONTRACTS_PATH) },
  };
}

// The new queue's ids as main commits them, for the landed check; nothing
// else is trusted from this read.
function scopeIds(text) {
  const ids = parse(text)?.dispatch_scope?.issue_ids;
  return Array.isArray(ids) ? ids.filter((id) => typeof id === "string" && CARD_ID_RE.test(id)) : [];
}

// The prerequisite provisioner of the checkout, as the owner runs it. The
// gate admits no service/ change, so N's provisioner is R's.
function provision(io, paths, action, revision) {
  const node = io.nodePath?.() ?? process.execPath;
  const result = io.exec(node, [path.join(paths.checkout, PROVISIONER), action, revision]);
  const last = String(result.stdout ?? "").trim().split("\n").at(-1) ?? "";
  const report = parse(last);
  if (result.status !== 0 || report?.ok === false) {
    throw new Error(`provisioner ${action} ${revision} exited ${result.status}${report?.code ? ` (${report.code})` : ""}`);
  }
  return report ?? null;
}

// Fast-forwards the checkout's main to N as the coordinator user, with the
// broker's hardened git and a time bound. N is fetched by its content: what
// the checkout's own remote config does cannot change the commit merged.
function mergeMain(io, credentials, paths, repo, main) {
  if (!validateRepoUrl(credentials.SHU_PUSH_REMOTE_URL, { allowedRepo: repo }).ok) throw new Error(`SHU_PUSH_REMOTE_URL is not the ${repo} remote`);
  const asCoordinator = coordinatorRunner(io);
  const git = (args) => asCoordinator(["timeout", "--kill-after=10", String(PUSH_TIMEOUT_SECONDS),
    "git", ...BROKER_GIT_CONFIG_ARGS, "-C", paths.checkout, ...args]);
  const must = (args, what) => {
    const result = git(args);
    if (result.status !== 0) throw new Error(`${what} failed (git exit ${result.status})`);
    return String(result.stdout ?? "").trim();
  };
  must(["fetch", "--no-tags", "--no-recurse-submodules", credentials.SHU_PUSH_REMOTE_URL, "refs/heads/main"], "fetching main into the checkout");
  must(["merge", "--ff-only", main], `the fast-forward merge of ${main}`);
  const head = must(["rev-parse", "HEAD"], "reading HEAD");
  const branch = must(["rev-parse", "refs/heads/main"], "reading main");
  const dirty = must(["status", "--porcelain=v1", "--untracked-files=all"], "reading the checkout status");
  if (head !== main || branch !== main || dirty) throw new Error(`the checkout did not read back clean on main at ${main}`);
}

// N's own card-run.mjs, in a child process, says the queue is valid, the next
// card is its first, and no queued card's preparation is refused.
function planCheck(io, paths, queue) {
  const node = io.nodePath?.() ?? process.execPath;
  const result = io.exec(node, [path.join(paths.checkout, CARD_RUN), "plan"]);
  const plan = parse(String(result.stdout ?? ""));
  if (result.status !== 0 || !plainObject(plan)) throw new Error(`the plan check exited ${result.status}`);
  if (!isDeepStrictEqual(plan.queue, queue)) throw new Error(`the plan check reads queue ${JSON.stringify(plan.queue ?? null)}, not ${queue.join(", ")}`);
  if (plan.next?.id !== queue[0]) throw new Error(`the plan check's next card is ${plan.next?.id ?? "none"} (${plainReason(plan.next?.reason ?? "")}), not ${queue[0]}`);
  const queued = Array.isArray(plan.queued) ? plan.queued : [];
  if (queued.length !== queue.length || queued.some((entry, i) => entry?.id !== queue[i])) throw new Error("the plan check did not dry-run every queued card");
  const refused = [plan, ...queued].find((entry) => !plainObject(entry?.prepare) || entry.prepare.refused);
  if (refused) throw new Error(`a dry-run preparation is refused: ${plainReason(refused.prepare?.reason ?? refused.prepare?.refused ?? "no preparation")}`);
}

// The pause file, created only: if it exists its text stays. After a failed
// install it is what stops the next timer start, so it counts as in place only
// when it was written now or a plain pause file was already there; otherwise
// the caller keeps the card-run lock instead.
function pauseHost(io, paths, reason) {
  try {
    io.fs.writeFileSync(paths.pause, `card-install: ${plainReason(reason)}\n`, { flag: "wx", mode: 0o644 });
    return { written: true, held: true };
  } catch (error) {
    const code = error.code ?? "PAUSE_WRITE_FAILED";
    let held = false;
    if (code === "EEXIST") {
      try { const stat = io.fs.lstatSync(paths.pause); held = stat.isFile() && !stat.isSymbolicLink(); } catch { held = false; }
    }
    return { written: false, held, code };
  }
}

export const INSTALL_OUTCOME_TEXT = Object.freeze({
  INSTALLED: "main is installed and its card queue is armed; the next timer start runs its first card",
  NEEDS_OWNER: "main changes more than a reviewed card queue, so a person installs it",
  INSTALL_FAILED: "the install stopped and the card-run timer is paused",
  INSTALL_PAUSED: "the pause file appeared, so the install stopped part way",
});

export function renderInstallReport(result) {
  const lines = [
    reportMarker(result.activation_id),
    `Card queue install of main at ${result.main} over installed revision ${result.revision}: ${result.outcome}, ${INSTALL_OUTCOME_TEXT[result.outcome] ?? "an outcome this runner does not know"}.`,
    "Started by the card-run timer once the installed queue was done.",
  ];
  if (result.queue?.length) lines.push(`Queue: ${result.queue.join(", ")}.`);
  if (result.reason) lines.push(`Reason: ${plainReason(result.reason)}`);
  if (result.steps?.length) lines.push(`Steps done: ${result.steps.join(", ")}.`);
  if (result.failed_step) lines.push(`Stopped at: ${result.failed_step}.`);
  if (result.rollback) lines.push(result.rollback.ok ? `Rolled back the prerequisites of ${result.main}; ${result.revision} was not reinstalled.`
    : `The rollback of ${result.main} failed: ${plainReason(result.rollback.reason)}`);
  if (result.pause) lines.push(result.pause.written ? "Wrote /etc/shu/card-run.paused; the owner removes it."
    : result.pause.held ? `The pause file was not written (${result.pause.code}); a pause file is already in place.`
      : `The pause file could not be written (${result.pause.code}), so the card-run lock is kept: every timer start skips until the owner recovers the host and removes the lock.`);
  if (result.outcome === "NEEDS_OWNER") lines.push("Nothing on the host changed.");
  return lines.join("\n");
}

// One self-install attempt. Returns { silent } or { skipped, reason } for a
// start that goes on to the queue config review, { paused } for one that must
// not, or { result } for a claimed attempt that was reported.
export async function selfInstall({ io, paths, config, revision, deps, limits = {} }) {
  const repo = config?.pilot_repo;
  let credentials;
  let facts;
  try {
    credentials = readCoordinatorCredentials(io, paths.coordinatorEnv);
    facts = inPushRepository(io, credentials, repo, paths.checkout, (git) => readMainFacts(git, credentials, revision));
  } catch (error) {
    return { skipped: "INSTALL_UNREADABLE", reason: error.message };
  }
  if (facts.main === revision) return { silent: true };
  const claim = installClaim(paths, facts.main);
  if (io.fs.existsSync(claim)) return { silent: true };
  let landed;
  let passes;
  try {
    landed = scopeIds(facts.configs?.main).filter((id) => deps.landedByTimer(io, paths, id));
    passes = reviewPasses(io, paths);
  } catch (error) {
    return { skipped: "INSTALL_UNREADABLE", reason: `the state directory cannot be read: ${error.message}` };
  }
  // The checks are last in the gate, so GitHub is read only when everything
  // else already holds: a structural refusal is final whatever it says.
  let gate = selfInstallGate({ ...facts, passes, landed, checks: null });
  if (gate.quiet) return { silent: true };
  if (gate.transient) {
    let checks;
    try {
      const gh = github(boundedFetch(io, limits.installRequestTimeoutMs ?? INSTALL_REQUEST_TIMEOUT_MS), credentials.GITHUB_TOKEN);
      checks = await readCommitChecks(gh, repo, facts.main);
    } catch (error) {
      checks = { green: false, note: `the checks cannot be read: ${error.message}` };
    }
    gate = selfInstallGate({ ...facts, passes, landed, checks });
  }
  if (gate.transient) return { skipped: "INSTALL_NOT_READY", reason: gate.reason };
  if (io.fs.existsSync(paths.pause)) return { paused: true, reason: `${paths.pause} exists` };
  const base = { ok: false, kind: "install", trigger: "timer", activation_id: installActivationId(facts.main), revision, main: facts.main };
  const report = async (result) => ({ ...result,
    report: await postRunReport({ io, credentials, result, timeoutMs: limits.reportTimeoutMs ?? INSTALL_REQUEST_TIMEOUT_MS, render: renderInstallReport }) });
  if (!gate.ok) {
    const result = { ...base, outcome: "NEEDS_OWNER", reason: gate.reason };
    try {
      io.fs.writeFileSync(claim, `${JSON.stringify({ main: facts.main, revision, outcome: "NEEDS_OWNER", reason: gate.reason, claimed_at: io.now().toISOString() })}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error.code === "EEXIST") return { silent: true };
      return { skipped: "INSTALL_UNREADABLE", reason: `the claim cannot be written: ${error.code ?? error.message}` };
    }
    return { result: { ...(await report(result)), claim } };
  }
  return installMain({ io, paths, deps, credentials, repo, revision, main: facts.main, queue: gate.queue, claim, base, report });
}

async function installMain({ io, paths, deps, credentials, repo, revision, main, queue, claim, base, report }) {
  try { io.fs.writeFileSync(paths.lock, String(process.pid), { flag: "wx", mode: 0o600 }); }
  catch { return { skipped: "INSTALL_LOCKED", reason: `${paths.lock} exists` }; }
  const steps = [];
  const paused = () => io.fs.existsSync(paths.pause);
  let outcome = null;
  let result;
  // A failed install whose pause could not be put in place keeps the lock,
  // so the next timer start cannot run on a half-installed host.
  let keepLock = false;
  try {
    // Nothing on the host has changed until the merge, so a pause or a busy
    // host before it gives N back for a later start.
    if (paused()) return { paused: true, reason: `${paths.pause} exists` };
    try {
      io.fs.writeFileSync(claim, `${JSON.stringify({ main, revision, queue, claimed_at: io.now().toISOString() })}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error.code === "EEXIST") return { silent: true };
      return { skipped: "INSTALL_UNREADABLE", reason: `the claim cannot be written: ${error.code ?? error.message}` };
    }
    steps.push("claim");
    if (paused()) { io.fs.unlinkSync(claim); return { paused: true, reason: `${paths.pause} exists` }; }
    const busy = deps.busyReasons(io, paths);
    if (busy.length) { io.fs.unlinkSync(claim); return { skipped: "INSTALL_HOST_BUSY", reason: busy.join("; ") }; }
    steps.push("idle");
    if (paused()) { io.fs.unlinkSync(claim); return { paused: true, reason: `${paths.pause} exists` }; }
    let failedStep = null;
    let rollback = null;
    const run = (name, action) => {
      if (paused()) { outcome = "INSTALL_PAUSED"; failedStep = name; throw new Error(`${paths.pause} appeared before ${name}`); }
      failedStep = name;
      action();
      failedStep = null;
      steps.push(name);
    };
    try {
      run("merge", () => mergeMain(io, credentials, paths, repo, main));
      run("rollback", () => provision(io, paths, "rollback", revision));
      run("install", () => provision(io, paths, "install", main));
      for (const name of ["verify", "precondition"]) {
        try {
          run(name, () => provision(io, paths, name, main));
        } catch (error) {
          if (outcome !== "INSTALL_PAUSED") {
            // Installed but not sound: N's prerequisites come off again. R is
            // never put back by the box; the owner decides.
            try { provision(io, paths, "rollback", main); rollback = { ok: true }; }
            catch (undo) { rollback = { ok: false, reason: undo.message }; }
          }
          throw error;
        }
      }
      run("plan", () => planCheck(io, paths, queue));
      result = { ...base, ok: true, outcome: "INSTALLED", queue, steps: [...steps], reason: `the next timer start runs ${queue[0]}` };
    } catch (error) {
      const reason = `${failedStep ?? "a step"}: ${error.message}`;
      const pause = outcome === "INSTALL_PAUSED" ? null : pauseHost(io, paths, `${main} ${reason}`);
      if (pause && !pause.held) keepLock = true;
      result = { ...base, outcome: outcome ?? "INSTALL_FAILED", queue, steps: [...steps], failed_step: failedStep, reason,
        ...(rollback ? { rollback } : {}),
        ...(pause ? { pause } : {}),
        ...(keepLock ? { lock_kept: true } : {}) };
    }
  } finally {
    if (!keepLock) { try { io.fs.unlinkSync(paths.lock); } catch { /* the lock is gone already */ } }
  }
  let claimError = null;
  try {
    io.fs.writeFileSync(claim, `${JSON.stringify({ main, revision, queue, outcome: result.outcome, ok: result.ok, steps: result.steps,
      ...(result.reason ? { reason: result.reason } : {}) })}\n`, { mode: 0o600 });
  } catch (error) { claimError = error.code ?? "CLAIM_WRITE_FAILED"; }
  return { result: { ...(await report(result)), claim, ...(claimError ? { claim_error: claimError } : {}) } };
}
