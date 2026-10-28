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
//     dispatch_scope is 2 to 5 cards that have not landed, the first of
//     them a new lane, each new lane with its own CARD_CONTRACTS entry added
//     at N and each other one a lane R already has (M16, below);
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
//
// M16: the box installs without a person relaying anything.
//   * A stopped queue (QUEUE_STOPPED) runs Card B too, not only a done one
//     (card-run.mjs). What replaces a stopped card is a re-cut queue: one new
//     lane, a copy of the stopped card's under a new id, first in
//     dispatch_scope, followed by later lanes R already has, with the stopped
//     card left out. So a dispatch_scope id after the first may also be an
//     installed lane that has not landed; every other rule above holds as it
//     was.
//   * code_self_install { approval: "none" } (codeInstallPolicy, from M11) is
//     on in config.json: a box REVIEW_PASS at the exact head and green checks
//     install coordinator code. Owner-only paths stay NEEDS_OWNER.
//   * card-contracts.mjs is installable, yet the root install tools import it
//     (test M11 C7), so it runs as root. Any install that changes it, queue
//     or code, may only add lines, and each added line's code must be inert
//     data (contractAdditionRefusal); the text of its strings, templates and
//     comments is never read as code, so a brief may say anything. The code
//     names no import, require(, eval, Function(, process. or child_process,
//     and exports only `export const X = `. It refers only to names the file
//     declares (top-level consts and arrow parameters, none a global's), to
//     Object, Number, String and Boolean, and to string and array members
//     such as replace, map, filter and join. It calls no expression result,
//     reads no computed member, tags no template and assigns nothing but a
//     const. A line at the top level, by bracket and template nesting rather
//     than indentation, is a const declaration or a comment. So the file can
//     still build briefs from helpers, as queue 13 does, but cannot reach the
//     process, the filesystem or the network.
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { builtinModules } from "node:module";
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

// M11: coordinator code the box may install itself once its config turns
// that on (code_self_install, read from the installed revision only). These
// paths install or check everything else as root, hold the trust anchors, or
// draw this boundary, so they always stay a person's install. So does every
// module the root install tools import, since it runs inside them: test M11 C7
// derives that import closure from the tree and fails if one is missing here.
export const CODE_SELF_INSTALL_KEY = "code_self_install";
export const ROOT_INSTALL_TOOLS = Object.freeze([
  PROVISIONER,
  ".github/coordinator/service/install.mjs",
  ".github/coordinator/service/units.mjs",
  ".github/coordinator/service/credential-delivery.mjs",
  ".github/coordinator/shu71-public-key.mjs",
]);
export const OWNER_ONLY_PATHS = Object.freeze([
  PROVISIONER,
  ".github/coordinator/service/card-install.mjs",
  ".github/coordinator/service/install.mjs",
  ".github/coordinator/service/units.mjs",
  ".github/coordinator/service/credential-delivery.mjs",
  ".github/coordinator/service/disposable-suite.mjs",
  ".github/coordinator/service/host-suite-contract.mjs",
  ".github/coordinator/service/shu71-journal.mjs",
  ".github/coordinator/service/shu71-production.mjs",
  ".github/coordinator/service/shu71-runtime-schema.mjs",
  ".github/coordinator/service/shu71-runtime.mjs",
  ".github/coordinator/service/suite-runner-spec.mjs",
  ".github/coordinator/execution-authorization.mjs",
  ".github/coordinator/launch-vocabulary.mjs",
  ".github/coordinator/reseed-append-contract.mjs",
  ".github/coordinator/shu71-activation-package.mjs",
  ".github/coordinator/workspace-scope.mjs",
  ".github/coordinator/service/shu-reviewer.sudoers",
  ".github/coordinator/reviewer-sandbox.sh",
  ".github/coordinator/shu71-trust-anchor.json",
  ".github/coordinator/shu71-activation-public-key.pem",
  ".github/coordinator/shu71-public-key.mjs",
]);
const OWNER_ONLY_PREFIXES = Object.freeze([".github/coordinator/service/userns-profile/"]);
const OWNER_ONLY_SUFFIXES = Object.freeze([".sh", ".sudoers", ".service.in", ".timer.in", ".pem"]);
export function ownerOnlyPath(file) {
  if (typeof file !== "string" || installablePath(file)) return false;
  return OWNER_ONLY_PATHS.includes(file) || OWNER_ONLY_PREFIXES.some((prefix) => file.startsWith(prefix))
    || OWNER_ONLY_SUFFIXES.some((suffix) => file.endsWith(suffix));
}
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

// The installed config's code self-install policy, or null when it is off or
// malformed: { approval: "github_review", approvers: [logins] }, a GitHub
// Approve by one of those logins on the reviewed pull request at its passed
// head; or { approval: "none" }, the box review and green checks alone.
export function codeInstallPolicy(config) {
  const policy = config?.[CODE_SELF_INSTALL_KEY];
  if (!plainObject(policy)) return null;
  if (policy.approval === "none" && Object.keys(policy).length === 1) return { approval: "none", approvers: [] };
  if (policy.approval === "github_review" && JSON.stringify(Object.keys(policy).sort()) === JSON.stringify(["approval", "approvers"])
    && Array.isArray(policy.approvers) && policy.approvers.length > 0 && policy.approvers.every((login) => typeof login === "string" && LOGIN_RE.test(login))) {
    return { approval: "github_review", approvers: [...policy.approvers] };
  }
  return null;
}

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
  const scopeChanged = !isDeepStrictEqual(installed.dispatch_scope, next.dispatch_scope);
  const policy = codeInstallPolicy(installed);
  const changes = facts.changes;
  // M11: with code self-install on, main may commit coordinator code with no
  // new queue; without it, only a new queue is anything to install.
  const code = Array.isArray(changes) ? changes.filter((change) => !installablePath(change?.path)) : [];
  if (!scopeChanged && (!policy || code.length === 0)) return no("main commits no new dispatch_scope", { quiet: true });

  if (!Array.isArray(changes) || changes.length === 0) return no("the coordinator changes cannot be read", { transient: true });
  for (const change of changes) {
    if (!installablePath(change?.path) && !policy) return no(`${String(change?.path)} is not a queue config path`);
    if (!installablePath(change?.path) && !coordinatorFile(change?.path)) return no(`${String(change?.path)} is not a coordinator path`);
    if (ownerOnlyPath(change.path)) return no(`${change.path} is installed only by a person`);
    if (!["A", "M"].includes(change.status)) return no(`${change.path} is ${change.status === "D" ? "deleted" : `changed as ${String(change.status)}`}; only additions and edits install themselves`);
  }
  const contracts = changes.find((change) => change.path === CONTRACTS_PATH);
  // M16: a code install's contracts change is held to this too, and every
  // install's additions to it must be inert data (the root tools import it).
  if (contracts && (contracts.status !== "M" || facts.contractLines?.deleted !== 0 || !Number.isInteger(facts.contractLines?.added))) {
    return no(`${CONTRACTS_PATH} may only gain lines`);
  }
  if (contracts) {
    const refusal = contractAdditionRefusal(facts.contractTexts?.installed, facts.contractTexts?.main);
    if (refusal) return no(`${CONTRACTS_PATH} gains more than inert data: ${refusal}`);
  }

  const keys = new Set([...Object.keys(installed), ...Object.keys(next)]);
  for (const key of keys) {
    if (key === "dispatch_scope" || key === "card_lanes") continue;
    const same = Object.hasOwn(installed, key) && Object.hasOwn(next, key) && isDeepStrictEqual(installed[key], next[key]);
    // Code may change the config with it, but never the policy that let it in.
    if (!same && (code.length === 0 || key === CODE_SELF_INSTALL_KEY)) {
      return no(`config.json changes ${key}; ${code.length ? "the code self-install policy is" : "only dispatch_scope and appended card_lanes"} install${code.length ? "ed only by a person" : " themselves"}`);
    }
  }
  if (!scopeChanged) return codeGate(facts, { changes, code, policy });
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
  // M16: a re-cut queue keeps later lanes R already has, so an id may also
  // be an installed lane. The first is new: nextCard runs the first card that
  // has not landed, so an installed stopped card first would stop the queue
  // again. None has landed.
  for (const id of ids) {
    if (!added.includes(id) && !known.has(id)) return no(`${String(id)} in the new dispatch_scope is neither a newly appended nor an installed card lane`);
  }
  if (!added.includes(ids[0])) return no(`${String(ids[0])}, first in the new dispatch_scope, is not a newly appended card lane`);
  const landed = new Set(facts.landed ?? []);
  for (const id of ids) if (landed.has(id)) return no(`${id} already landed`);
  const installedContracts = contractEntries(facts.contractTexts?.installed);
  const nextContracts = contractEntries(facts.contractTexts?.main);
  if (!installedContracts || !nextContracts) return no("CARD_CONTRACTS cannot be read at both revisions");
  for (const id of ids) {
    if (added.includes(id) && (installedContracts.has(id) || !nextContracts.has(id))) return no(`${id} has no CARD_CONTRACTS entry added at main`);
    if (!added.includes(id) && !nextContracts.has(id)) return no(`${id} has no CARD_CONTRACTS entry at main`);
  }

  const reviewed = reviewedAndGreen(facts, { changes, code, policy });
  if (!reviewed.ok) return reviewed;
  return { ok: true, queue: [...ids], lanes: added, ...(code.length ? { code: code.map((change) => change.path), approval: reviewed.approval } : {}) };
}

// M16: card-contracts.mjs, lexed line by line just enough to tell code from
// the text of strings, templates, regular expressions and comments. Each line
// records the state it starts in, whether it starts at the top level (no
// bracket open, outside every template), and the code it holds: each string
// as "", each regular expression as /0/, each template quote as ` and each
// interpolation as #{ and }, with ${NAME} read as template text.
const REGEX_AFTER = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);
export function contractLines(text) {
  const source = String(text ?? "");
  const fresh = (start, top) => ({ start, top, text: "", code: "" });
  const lines = [fresh("code", true)];
  const stack = [{ kind: "code", braces: 0 }];
  let depth = 0;
  let line = lines[0];
  // The last code character before this one, across lines, to tell a
  // regular expression from a division.
  let last = "";
  const emit = (value) => { line.code += value; const trimmed = value.trim(); if (trimmed) last = trimmed.at(-1); };
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    let top = stack.at(-1);
    if (c === "\n") {
      if (top.kind === "line" || top.kind === "string") stack.pop();
      top = stack.at(-1);
      const start = top.kind === "template" || top.kind === "comment" ? top.kind : "code";
      line = fresh(start, start === "code" && stack.length === 1 && depth === 0);
      lines.push(line);
      continue;
    }
    line.text += c;
    if (top.kind === "line") continue;
    if (top.kind === "comment") {
      if (c === "*" && source[i + 1] === "/") { stack.pop(); line.text += "/"; i += 1; }
      continue;
    }
    if (top.kind === "string") {
      if (c === "\\" && source[i + 1] !== "\n") { line.text += source[i + 1] ?? ""; i += 1; } else if (c === top.quote) stack.pop();
      continue;
    }
    if (top.kind === "template") {
      if (c === "\\" && source[i + 1] !== "\n") { line.text += source[i + 1] ?? ""; i += 1; continue; }
      if (c === "`") { stack.pop(); emit("`"); continue; }
      if (c === "$" && source[i + 1] === "{") {
        const name = /^\$\{[A-Za-z_$][\w$]*\}/.exec(source.slice(i));
        if (name) { line.text += name[0].slice(1); i += name[0].length - 1; continue; }
        stack.push({ kind: "code", braces: 0 });
        emit("#{");
        line.text += "{";
        i += 1;
      }
      continue;
    }
    if (c === "/" && source[i + 1] === "/") { stack.push({ kind: "line" }); continue; }
    if (c === "/" && source[i + 1] === "*") { stack.push({ kind: "comment" }); line.text += "*"; i += 1; continue; }
    if (c === "/" && (REGEX_AFTER.has(last) || /^(?:return|typeof)$/.test(/[\w$]*$/.exec(line.code)?.[0] ?? ""))) {
      // A regular expression literal, to its closing slash outside a class,
      // then its flags. One that runs off the line is read as code.
      let j = i + 1;
      let inClass = false;
      for (; j < source.length && source[j] !== "\n"; j += 1) {
        if (source[j] === "\\") { j += 1; continue; }
        if (source[j] === "[") inClass = true;
        else if (source[j] === "]") inClass = false;
        else if (source[j] === "/" && !inClass) break;
      }
      if (source[j] === "/") {
        while (/[a-z]/.test(source[j + 1] ?? "")) j += 1;
        line.text += source.slice(i + 1, j + 1);
        i = j;
        emit("/0/");
        continue;
      }
    }
    if (c === "\"" || c === "'") { stack.push({ kind: "string", quote: c }); emit("\"\""); continue; }
    if (c === "`") { stack.push({ kind: "template" }); emit("`"); continue; }
    if (c === "{") top.braces += 1;
    if (c === "}") {
      if (top.braces === 0 && stack.length > 1) { stack.pop(); emit("}"); continue; }
      top.braces -= 1;
    }
    if ("([{".includes(c)) depth += 1;
    if (")]}".includes(c)) depth -= 1;
    emit(c);
  }
  return lines;
}

// What an added line's code may reach: names the file declares (never a
// global's), the members below, and these globals and literals.
const CONTRACT_MEMBERS = new Set(["freeze", "replace", "replaceAll", "map", "flatMap", "flat", "filter", "some", "every", "find", "includes",
  "indexOf", "startsWith", "endsWith", "join", "split", "slice", "concat", "trim", "trimStart", "trimEnd", "toUpperCase", "toLowerCase",
  "padStart", "padEnd", "repeat", "length"]);
const CONTRACT_GLOBALS = new Set(["Object", "Number", "String", "Boolean"]);
const CONTRACT_LITERALS = new Set(["const", "export", "typeof", "true", "false", "null", "undefined", "NaN", "Infinity"]);
const CONTRACT_NOT_DECLARABLE = new Set(["require", "module", "exports", "__filename", "__dirname", "arguments", "eval", "import", "this", "super"]);
const CONTRACT_WORDS = [/\bimport\b/, /\brequire\s*\(/, /\beval\b/, /\bFunction\s*\(/, /\bprocess\s*\./, /\bchild_process\b/];
const CONTRACT_EXPORT = /^\s*export const [A-Za-z_$][\w$]* = /;
const CONTRACT_DECLARATION = /^\s*(?:export )?const ([A-Za-z_$][\w$]*) = /;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
// A Node builtin's name is a global only where code is evaluated (node -e),
// never in a module like this one or card-contracts.mjs.
const globalName = (name) => (name in globalThis && !builtinModules.includes(name)) || CONTRACT_NOT_DECLARABLE.has(name);

// The names N declares: its top-level consts and every arrow parameter.
function contractNames(lines) {
  const names = new Set();
  const params = [];
  for (const line of lines) {
    const declared = line.top ? CONTRACT_DECLARATION.exec(line.code) : null;
    if (declared) names.add(declared[1]);
  }
  const code = lines.map((line) => line.code).join("\n");
  for (const match of code.matchAll(/\(([^()]*)\)\s*=>|([A-Za-z_$][\w$]*)\s*=>/g)) {
    for (const part of (match[1] ?? match[2]).split(",").map((entry) => entry.trim()).filter(Boolean)) params.push(part);
  }
  for (const part of params) if (IDENTIFIER.test(part)) names.add(part);
  return { names, params };
}

// M16: why the lines N's card-contracts.mjs adds to R's are not inert data,
// or null when they are. R's lines, each in the state it starts in, must
// appear in N's in order; every other line of N is an added line. A brief's
// words are template or string text and never code.
export function contractAdditionRefusal(installedText, mainText) {
  if (typeof installedText !== "string" || typeof mainText !== "string") return "it cannot be read at both revisions";
  const before = contractLines(installedText);
  const after = contractLines(mainText);
  const added = new Set();
  let j = 0;
  after.forEach((line, i) => {
    if (j < before.length && before[j].text === line.text && before[j].start === line.start && before[j].top === line.top) j += 1;
    else added.add(i);
  });
  if (j < before.length) return "it does not keep every installed line as it was";
  const { names, params } = contractNames(after);
  for (const name of names) if (globalName(name)) return `it declares ${name}, a global name`;
  // The code of every line, joined, so a token's neighbours on other lines count.
  const joined = after.map((line) => line.code).join("\n");
  let offset = 0;
  for (const [i, line] of after.entries()) {
    const start = offset;
    offset += line.code.length + 1;
    if (!added.has(i)) continue;
    const why = contractLineRefusal(line, joined, start, names);
    if (why) return `an added line ${why}: ${line.text.trim().slice(0, 120)}`;
  }
  for (const part of params) if (!IDENTIFIER.test(part)) return `a parameter is not a plain name: ${part.slice(0, 60)}`;
  return null;
}

function contractLineRefusal(line, joined, start, names) {
  const code = line.code;
  if (CONTRACT_WORDS.some((pattern) => pattern.test(code))) return "names a module, process or code loader";
  if (/\bexport\b/.test(code) && !CONTRACT_EXPORT.test(code)) return "exports something other than a const";
  if (/\+\+|--|__proto__/.test(code)) return "holds code";
  if (/[\w$\])]\s*`/.test(code)) return "tags a template";
  const assignments = code.replace(CONTRACT_DECLARATION, "").replace(/===|!==|==|<=|>=|=>/g, "");
  if (/=/.test(assignments)) return "assigns";
  // The nearest code character before or after a position, across lines.
  const before = (at) => { let k = at - 1; while (k >= 0 && /\s/.test(joined[k])) k -= 1; return { char: joined[k] ?? "", at: k }; };
  const after = (at) => { let k = at; while (k < joined.length && /\s/.test(joined[k])) k += 1; return joined[k] ?? ""; };
  for (const match of code.matchAll(/[A-Za-z_$][\w$]*|[([]/g)) {
    const at = start + match.index;
    const token = match[0];
    const prev = before(at);
    const spread = joined.slice(prev.at - 2, prev.at + 1) === "...";
    if (token === "(" || token === "[") {
      if (prev.char === "." && !spread) return token === "(" ? "calls through optional chaining" : "reads a computed member";
      if (/[)\]`"}]/.test(prev.char)) return token === "(" ? "calls the result of an expression" : "reads a computed member";
      if (token === "[" && /[\w$]/.test(prev.char)) return "reads a computed member";
      continue;
    }
    if (/^\d/.test(token) || (match.index > 0 && /[\w$]/.test(code[match.index - 1]))) continue;
    if (prev.char === "." && !spread) {
      if (!CONTRACT_MEMBERS.has(token)) return `reaches .${token}`;
      continue;
    }
    // An object key: after { or , and before :.
    if ((prev.char === "{" || prev.char === ",") && after(at + token.length) === ":") continue;
    if (CONTRACT_LITERALS.has(token) || CONTRACT_GLOBALS.has(token)) continue;
    if (!names.has(token)) return `refers to ${token}, which the file does not declare`;
  }
  // A top-level line, by its nesting: a const declaration or a comment.
  if (line.top && line.text.trim() && !/^\s*\/\//.test(line.text) && !CONTRACT_DECLARATION.test(line.code)) {
    return "is a top-level statement that is not a const declaration";
  }
  return null;
}

const coordinatorFile = (file) => typeof file === "string" && file.startsWith(COORDINATOR)
  && !file.split("/").some((part) => !part || part === "." || part === "..");

// M11: main commits coordinator code and the same queue. Everything above
// already held; what is left is the review, the approval and the checks.
function codeGate(facts, { changes, code, policy }) {
  const reviewed = reviewedAndGreen(facts, { changes, code, policy });
  if (!reviewed.ok) return reviewed;
  return { ok: true, queue: null, lanes: [], code: code.map((change) => change.path), approval: reviewed.approval };
}

// One REVIEW_PASS claim covers every changed blob; coordinator code also needs
// the policy's approval at that pass's exact head; then main's checks are
// green. The checks and the approval are read from GitHub only when every
// structural rule already holds, so their absence here is transient.
function reviewedAndGreen(facts, { changes, code, policy }) {
  const no = (reason, kind = {}) => ({ ok: false, transient: false, quiet: false, ...kind, reason });
  const passes = Array.isArray(facts.passes) ? facts.passes : [];
  for (const change of changes) {
    if (!SHA_RE.test(facts.blobs?.[change.path] ?? "")) return no(`${change.path} has no readable blob at main`);
  }
  // One review covers the whole change: blobs passed in different pull
  // requests were never reviewed together.
  const review = passes.find((entry) => changes.every((change) => entry?.files?.[change.path]?.sha === facts.blobs[change.path]));
  if (!review) return no(`the coordinator changes at main are not the blobs one REVIEW_PASS claim recorded at an exact pull request head`);
  let approval = null;
  if (code.length && policy.approval === "github_review") {
    const wanted = { pr: review.pr, head: review.head, approvers: policy.approvers };
    const read = facts.approval;
    if (!read || read.pr !== review.pr || read.head !== review.head) {
      return no(`pull request #${review.pr} carries coordinator code, and its approval is not read yet`, { transient: true, needs: { approval: wanted } });
    }
    if (read.approved !== true) {
      return no(`pull request #${review.pr} carries coordinator code and waits on an Approve at ${review.head} from ${policy.approvers.join(" or ")}: ${read.note ?? "none yet"}`,
        { transient: true, needs: { approval: wanted } });
    }
    approval = { pr: review.pr, head: review.head, by: read.by };
  } else if (code.length) {
    approval = { pr: review.pr, head: review.head, by: null };
  }

  const checks = facts.checks;
  if (Array.isArray(checks?.red) && checks.red.length) return no(`main's checks at ${facts.main} are red: ${checks.red.join(", ")}`);
  if (checks?.green !== true) return no(`main's checks at ${facts.main} are not green yet: ${checks?.note ?? "unread"}`, { transient: true });
  return { ok: true, approval };
}

// M11: whether one of the approvers, not the pull request's author, approved
// it at exactly the passed head, by their latest decisive review. Read only.
export async function readApproval(gh, repo, { pr, head, approvers }) {
  const api = `https://api.github.com/repos/${repo}/pulls/${pr}`;
  const pullResponse = await gh("GET", api);
  const pull = await pullResponse.json();
  if (!pullResponse.ok || !plainObject(pull)) return { pr, head, approved: false, note: `the pull request cannot be read (HTTP ${pullResponse.status})` };
  const author = typeof pull.user?.login === "string" ? pull.user.login.toLowerCase() : null;
  const reviewsResponse = await gh("GET", `${api}/reviews?per_page=100`);
  const reviews = await reviewsResponse.json();
  if (!reviewsResponse.ok || !Array.isArray(reviews)) return { pr, head, approved: false, note: `the reviews cannot be read (HTTP ${reviewsResponse.status})` };
  if (reviews.length >= 100) return { pr, head, approved: false, note: "the pull request has too many reviews to read in one page" };
  const decisive = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);
  for (const login of approvers) {
    const who = login.toLowerCase();
    if (who === author) continue;
    const latest = reviews.filter((entry) => typeof entry?.user?.login === "string" && entry.user.login.toLowerCase() === who && decisive.has(entry.state)).at(-1);
    if (latest?.state === "APPROVED" && latest.commit_id === head) return { pr, head, approved: true, by: login };
  }
  return { pr, head, approved: false, note: `no Approve at ${head} from ${approvers.join(" or ")}${author && approvers.some((login) => login.toLowerCase() === author) ? " (the author's own does not count)" : ""}` };
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

// M11: a code install leaves the queue as it was. N's own card-run.mjs must
// still plan: exit 0, read the same queue, and refuse no queued preparation.
function codePlanCheck(io, paths, scope) {
  const node = io.nodePath?.() ?? process.execPath;
  const result = io.exec(node, [path.join(paths.checkout, CARD_RUN), "plan"]);
  const plan = parse(String(result.stdout ?? ""));
  if (result.status !== 0 || !plainObject(plan)) throw new Error(`the plan check exited ${result.status}`);
  if (!isDeepStrictEqual(plan.queue, scope)) throw new Error(`the plan check reads queue ${JSON.stringify(plan.queue ?? null)}, not ${scope.join(", ")}`);
  const queued = Array.isArray(plan.queued) ? plan.queued : [];
  const refused = queued.find((entry) => !plainObject(entry?.prepare) || entry.prepare.refused);
  if (refused) throw new Error(`a dry-run preparation is refused: ${plainReason(refused.prepare?.reason ?? refused.prepare?.refused ?? "no preparation")}`);
}

// M11: puts the installed revision R back after a failed code install: N's
// prerequisites off (when they were installed and not already rolled back),
// the checkout's main back to R as the coordinator user, then R installed,
// verified and its precondition read. Never throws.
function restoreRevision(io, credentials, paths, repo, { revision, main, installed }) {
  const steps = [];
  try {
    if (installed) { provision(io, paths, "rollback", main); steps.push("rollback"); }
    if (!validateRepoUrl(credentials.SHU_PUSH_REMOTE_URL, { allowedRepo: repo }).ok) throw new Error(`SHU_PUSH_REMOTE_URL is not the ${repo} remote`);
    const asCoordinator = coordinatorRunner(io);
    const git = (args, what) => {
      const result = asCoordinator(["timeout", "--kill-after=10", String(PUSH_TIMEOUT_SECONDS), "git", ...BROKER_GIT_CONFIG_ARGS, "-C", paths.checkout, ...args]);
      if (result.status !== 0) throw new Error(`${what} failed (git exit ${result.status})`);
      return String(result.stdout ?? "").trim();
    };
    git(["checkout", "-q", "-B", "main", revision], `moving the checkout's main back to ${revision}`);
    const head = git(["rev-parse", "HEAD"], "reading HEAD");
    const dirty = git(["status", "--porcelain=v1", "--untracked-files=all"], "reading the checkout status");
    if (head !== revision || dirty) throw new Error(`the checkout did not read back clean at ${revision}`);
    steps.push("checkout");
    for (const action of ["install", "verify", "precondition"]) { provision(io, paths, action, revision); steps.push(action); }
    return { ok: true, steps };
  } catch (error) {
    return { ok: false, steps, reason: error.message };
  }
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
  INSTALL_RESTORED: "the install stopped and the installed revision is back in place, so the box keeps running it",
});

export function renderInstallReport(result) {
  const lines = [
    reportMarker(result.activation_id),
    `${result.code?.length ? (result.queue?.length ? "Code and card queue" : "Code") : "Card queue"} install of main at ${result.main} over installed revision ${result.revision}: ${result.outcome}, ${INSTALL_OUTCOME_TEXT[result.outcome] ?? "an outcome this runner does not know"}.`,
    "Started by the card-run timer once the installed queue was done or stopped.",
  ];
  if (result.queue?.length) lines.push(`Queue: ${result.queue.join(", ")}.`);
  if (result.code?.length) {
    const approval = result.approval;
    lines.push(`Code: ${result.code.length} coordinator file(s) from pull request #${approval?.pr ?? "?"} at ${approval?.head ?? "?"}, ${approval?.by ? `approved by ${approval.by}` : "passed by the box review"}.`);
  }
  if (result.reason) lines.push(`Reason: ${plainReason(result.reason)}`);
  if (result.steps?.length) lines.push(`Steps done: ${result.steps.join(", ")}.`);
  if (result.failed_step) lines.push(`Stopped at: ${result.failed_step}.`);
  if (result.restored) lines.push(result.restored.ok ? `Put ${result.revision} back: ${result.restored.steps.join(", ")}.`
    : `Putting ${result.revision} back failed after ${result.restored.steps.join(", ") || "no step"}: ${plainReason(result.restored.reason)}`);
  else if (result.rollback) lines.push(result.rollback.ok ? `Rolled back the prerequisites of ${result.main}; ${result.revision} was not reinstalled.`
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
    landed = [];
    for (const id of scopeIds(facts.configs?.main)) if (await deps.cardLanded(io, paths, id)) landed.push(id);
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
    let approval;
    const gh = github(boundedFetch(io, limits.installRequestTimeoutMs ?? INSTALL_REQUEST_TIMEOUT_MS), credentials.GITHUB_TOKEN);
    try {
      checks = await readCommitChecks(gh, repo, facts.main);
    } catch (error) {
      checks = { green: false, note: `the checks cannot be read: ${error.message}` };
    }
    // M11: the approval of a code change, read only when the gate asks for it.
    const wanted = gate.needs?.approval;
    if (wanted) {
      try { approval = await readApproval(gh, repo, wanted); }
      catch (error) { approval = { ...wanted, approved: false, note: `the reviews cannot be read: ${error.message}` }; }
    }
    gate = selfInstallGate({ ...facts, passes, landed, checks, approval });
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
  return installMain({ io, paths, deps, credentials, repo, revision, main: facts.main, queue: gate.queue, code: gate.code ?? null,
    approval: gate.approval ?? null, scope: scopeIds(facts.configs?.main), claim, base, report });
}

async function installMain({ io, paths, deps, credentials, repo, revision, main, queue, code = null, approval = null, scope = [], claim, base, report }) {
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
      io.fs.writeFileSync(claim, `${JSON.stringify({ main, revision, queue, ...(code ? { code, approval } : {}), claimed_at: io.now().toISOString() })}\n`, { flag: "wx", mode: 0o600 });
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
      run("plan", () => (queue ? planCheck(io, paths, queue) : codePlanCheck(io, paths, scope)));
      result = { ...base, ok: true, outcome: "INSTALLED", queue, ...(code ? { code, approval } : {}), steps: [...steps],
        reason: queue ? `the next timer start runs ${queue[0]}` : "the next timer start runs the installed code" };
    } catch (error) {
      const reason = `${failedStep ?? "a step"}: ${error.message}`;
      // M11: a code install that failed after the merge puts R back, so the
      // box keeps working on the code a person or a passed install left. Only
      // when R cannot be put back does the host pause.
      let restored = null;
      if (code && outcome !== "INSTALL_PAUSED" && steps.includes("merge")) {
        restored = restoreRevision(io, credentials, paths, repo, { revision, main, installed: steps.includes("install") && !rollback });
        if (restored.ok) rollback = rollback ?? (steps.includes("install") ? { ok: true } : null);
      }
      const pause = outcome === "INSTALL_PAUSED" || restored?.ok ? null : pauseHost(io, paths, `${main} ${reason}`);
      if (pause && !pause.held) keepLock = true;
      result = { ...base, outcome: outcome ?? (restored?.ok ? "INSTALL_RESTORED" : "INSTALL_FAILED"), queue, ...(code ? { code, approval } : {}),
        steps: [...steps], failed_step: failedStep, reason,
        ...(rollback ? { rollback } : {}),
        ...(restored ? { restored } : {}),
        ...(pause ? { pause } : {}),
        ...(keepLock ? { lock_kept: true } : {}) };
    }
  } finally {
    if (!keepLock) { try { io.fs.unlinkSync(paths.lock); } catch { /* the lock is gone already */ } }
  }
  let claimError = null;
  try {
    io.fs.writeFileSync(claim, `${JSON.stringify({ main, revision, queue, ...(code ? { code, approval } : {}), outcome: result.outcome, ok: result.ok, steps: result.steps,
      ...(result.reason ? { reason: result.reason } : {}) })}\n`, { mode: 0o600 });
  } catch (error) { claimError = error.code ?? "CLAIM_WRITE_FAILED"; }
  return { result: { ...(await report(result)), claim, ...(claimError ? { claim_error: claimError } : {}) } };
}
