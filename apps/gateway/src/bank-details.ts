import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { SessionStore } from "@studenthub/login-contract";
import type {
  ActionToken, Receipt, RejectionReason, SafeWriteClock, SafeWriteSecret, SafeWriteStore,
} from "@studenthub/safe-write-contract";
import {
  BANK_DETAILS_FIELD, BankDetailError, bankDetailsRecordRef, bankDetailsValue,
  buildBankDetailsWrite, catalogueBankDetailsCheck, parseBankDetailsValue, validateBankDetails,
  type BankDetails, type FinanceReferenceResolver,
} from "@studenthub/pay-contracts";
import { principalAuditRef } from "@studenthub/db/access";
import { writeNotFound } from "./shell/error-pages.js";

/**
 * SHU-182 (F1): a signed-in candidate changes their own bank details through
 * the SHU-82 preview → confirm → receipt contract. The session decides whose
 * details change; the body carries only the new bank, IBAN and beneficiary
 * name, and at confirm the token the preview issued.
 */
export interface BankDetailsStore {
  forPrincipal(principalId: string): SafeWriteStore;
  readReceipt(principalId: string, receiptRef: string): Promise<Receipt | null>;
}

export type BankDetailsResult =
  | { readonly status: 200; readonly body: unknown }
  | { readonly status: 400 | 401 | 403 | 404 | 409 | 503; readonly body: { readonly error: string } };

/** An active catalogue bank, as the page's bank choice lists it. */
export interface BankChoice { readonly id: string; readonly name: string }

export interface BankDetailsService {
  /** The caller's own details, masked; 404 for someone who has no bank details record (not a candidate). */
  current(sessionId: string | undefined): Promise<BankDetailsResult>;
  /** Active catalogue banks for the page's choice; empty when no list is wired. */
  bankChoices(): Promise<readonly BankChoice[]>;
  preview(sessionId: string | undefined, body: unknown): Promise<BankDetailsResult>;
  confirm(sessionId: string | undefined, body: unknown): Promise<BankDetailsResult>;
  receipt(sessionId: string | undefined, receiptRef: string): Promise<BankDetailsResult>;
  /**
   * The page's preview: the typed values and the token stay on the server under a
   * short-lived, single-use review reference bound to this session and person.
   * 200 carries only the masked before/after and that reference.
   */
  stageReview(sessionId: string | undefined, body: unknown): Promise<BankDetailsResult>;
  /** Confirms a staged review: same session and person, before it expires, once. */
  confirmReview(sessionId: string | undefined, reviewRef: string): Promise<BankDetailsResult>;
}

/** Staged reviews held at once; the oldest goes first past this. */
const MAX_REVIEWS = 1000;

interface StagedReview {
  readonly sessionDigest: string;
  readonly principalId: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly token: ActionToken;
  readonly expiresAt: number;
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

const DETAIL_KEYS = ["bankId", "beneficiaryName", "iban"];
const TOKEN_KEYS = ["changeSetDigest", "expectedBeforeDigest", "expiresAt", "issuedAt", "mac", "principalRef", "tokenId"];

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function token(value: unknown): ActionToken | undefined {
  if (!exactKeys(value, TOKEN_KEYS)) return undefined;
  return TOKEN_KEYS.every((key) => typeof value[key] === "string") ? value as unknown as ActionToken : undefined;
}

function refusal(reason: RejectionReason): BankDetailsResult {
  const status = reason === "not_own_record" ? 403
    : reason === "receipt_failed" ? 503
      : reason.startsWith("token_") || reason === "state_changed" ? 409
        : 400;
  return { status, body: { error: reason } };
}

/** The typed input error, so a form can say which part is wrong. An unreachable catalogue is a 503. */
async function details(raw: Record<string, unknown>, banks: FinanceReferenceResolver):
  Promise<{ ok: true; value: BankDetails } | { ok: false; result: BankDetailsResult }> {
  try {
    return { ok: true, value: await validateBankDetails({ bankId: raw.bankId, iban: raw.iban, beneficiaryName: raw.beneficiaryName }, banks) };
  } catch (error) {
    if (error instanceof BankDetailError && error.status === 400) return { ok: false, result: { status: 400, body: { error: error.code } } };
    throw error;
  }
}

export interface MaskedBankDetails { readonly bankId: string; readonly ibanMasked: string; readonly beneficiaryName: string }

/**
 * What a preview shows. The full IBAN never leaves the server, not even to its
 * owner (as the own-profile projection already excludes it): the country, check
 * digits and last four characters are enough to recognize an account. The token
 * commits to the full value's digest, so masking the display weakens nothing.
 */
export function maskBankDetails(value: string | null): MaskedBankDetails | null {
  if (value === null) return null;
  const parsed = parseBankDetailsValue(value);
  if (!parsed) throw new Error("unreadable bank details value");
  return Object.freeze({
    bankId: parsed.bankId,
    ibanMasked: `${parsed.iban.slice(0, 4)}${"•".repeat(parsed.iban.length - 8)}${parsed.iban.slice(-4)}`,
    beneficiaryName: parsed.beneficiaryName,
  });
}

export function createBankDetails(ports: {
  readonly sessions: Pick<SessionStore, "get">;
  readonly store: BankDetailsStore;
  readonly banks: FinanceReferenceResolver;
  readonly secret: SafeWriteSecret;
  readonly clock?: SafeWriteClock;
  readonly choices?: () => Promise<readonly BankChoice[]>;
}): BankDetailsService {
  const check = catalogueBankDetailsCheck(ports.banks);
  const writer = (principalId: string) => buildBankDetailsWrite({
    store: ports.store.forPrincipal(principalId), secret: ports.secret, check,
    ...(ports.clock ? { clock: ports.clock } : {}),
  });
  // Fail at construction, not on the first request, if the key is too short.
  buildBankDetailsWrite({
    store: { readField: () => null, ownedRecord: () => null, commit: () => ({ ok: false, reason: "not_own_record" }) },
    secret: ports.secret, check,
  });

  async function principal(sessionId: string | undefined): Promise<string | undefined> {
    const session = sessionId ? await ports.sessions.get(sessionId) : undefined;
    return session?.personId;
  }

  // The page's staged reviews. They live in this process only: a review that is
  // not found (expired, already used, another session, a restart) is refused and
  // the person reviews again; nothing is ever written from a missing review.
  const reviews = new Map<string, StagedReview>();
  const now = () => (ports.clock ? ports.clock.now() : new Date()).getTime();
  function prune(): void {
    const at = now();
    for (const [ref, review] of reviews) if (review.expiresAt <= at) reviews.delete(ref);
  }

  const service: BankDetailsService = {
    async current(sessionId) {
      const principalId = await principal(sessionId);
      if (!principalId) return { status: 401, body: { error: "unauthorized" } };
      const own = ports.store.forPrincipal(principalId);
      const recordRef = await own.ownedRecord(principalAuditRef(principalId));
      if (recordRef !== bankDetailsRecordRef(principalId)) return { status: 404, body: { error: "not_found" } };
      return { status: 200, body: { details: maskBankDetails(await own.readField(recordRef, BANK_DETAILS_FIELD)) } };
    },

    async bankChoices() {
      return ports.choices ? ports.choices() : [];
    },

    async preview(sessionId, body) {
      const principalId = await principal(sessionId);
      if (!principalId) return { status: 401, body: { error: "unauthorized" } };
      if (!exactKeys(body, DETAIL_KEYS)) return { status: 400, body: { error: "invalid_request" } };
      const input = await details(body, ports.banks);
      if (!input.ok) return input.result;
      const result = await writer(principalId).preview({
        principalRef: principalAuditRef(principalId),
        change: { personRef: bankDetailsRecordRef(principalId), field: BANK_DETAILS_FIELD, value: bankDetailsValue(input.value) },
      });
      if (!result.ok) return refusal(result.reason);
      const change = result.changes[0]!;
      return { status: 200, body: { before: maskBankDetails(change.before), after: maskBankDetails(change.after), token: result.token } };
    },

    async confirm(sessionId, body) {
      const principalId = await principal(sessionId);
      if (!principalId) return { status: 401, body: { error: "unauthorized" } };
      if (!exactKeys(body, [...DETAIL_KEYS, "token"])) return { status: 400, body: { error: "invalid_request" } };
      const input = await details(body, ports.banks);
      if (!input.ok) return input.result;
      const actionToken = token(body.token);
      if (!actionToken) return refusal("token_not_issued");
      const result = await writer(principalId).confirm({
        principalRef: principalAuditRef(principalId),
        token: actionToken,
        change: { personRef: bankDetailsRecordRef(principalId), field: BANK_DETAILS_FIELD, value: bankDetailsValue(input.value) },
      });
      if (!result.ok) return refusal(result.reason);
      return { status: 200, body: { receipt: result.receipt } };
    },

    async receipt(sessionId, receiptRef) {
      const principalId = await principal(sessionId);
      if (!principalId) return { status: 401, body: { error: "unauthorized" } };
      const receipt = await ports.store.readReceipt(principalId, receiptRef);
      // Another person's receipt and no receipt at all are the same answer.
      if (!receipt) return { status: 404, body: { error: "receipt_not_found" } };
      return { status: 200, body: { receipt } };
    },

    async stageReview(sessionId, body) {
      const result = await service.preview(sessionId, body);
      if (result.status !== 200) return result;
      const principalId = (await principal(sessionId))!;
      const preview = result.body as { before: MaskedBankDetails | null; after: MaskedBankDetails; token: ActionToken };
      const sessionDigest = digest(sessionId!);
      prune();
      // One open review per session: a newer review replaces the older one.
      for (const [ref, review] of reviews) if (review.sessionDigest === sessionDigest) reviews.delete(ref);
      while (reviews.size >= MAX_REVIEWS) reviews.delete(reviews.keys().next().value!);
      const reviewRef = randomBytes(32).toString("hex");
      reviews.set(reviewRef, {
        sessionDigest, principalId, token: preview.token, expiresAt: Date.parse(preview.token.expiresAt),
        body: Object.fromEntries(DETAIL_KEYS.map((key) => [key, (body as Record<string, unknown>)[key]])),
      });
      return { status: 200, body: { before: preview.before, after: preview.after, reviewRef } };
    },

    async confirmReview(sessionId, reviewRef) {
      const principalId = await principal(sessionId);
      if (!principalId) return { status: 401, body: { error: "unauthorized" } };
      const review = reviews.get(reviewRef);
      // Another session's reference is not found, and stays usable by its own session.
      if (!review || review.sessionDigest !== digest(sessionId!) || review.principalId !== principalId) return refusal("token_not_issued");
      reviews.delete(reviewRef);
      if (now() >= review.expiresAt) return refusal("token_expired");
      return service.confirm(sessionId, { ...review.body, token: review.token });
    },
  };
  return service;
}

const PREVIEW = "/candidate/bank-details/preview";
const CONFIRM = "/candidate/bank-details/confirm";
const RECEIPT = /^\/candidate\/bank-details\/receipts\/([0-9a-f]{64})$/;
const BODY_LIMIT = 4096;

function sessionCookie(header: string | undefined): string | undefined {
  for (const item of header?.split(";") ?? []) {
    const [key, ...value] = item.trim().split("=");
    const candidate = value.join("=");
    if (key === "__Host-studenthub_session" && /^[A-Za-z0-9_-]{43}$/.test(candidate)) return candidate;
  }
  return undefined;
}

async function readJson(request: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false }> {
  if (Number(request.headers["content-length"]) > BODY_LIMIT) { request.resume(); return { ok: false }; }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > BODY_LIMIT) { request.resume(); return { ok: false }; }
    chunks.push(bytes);
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Mounted by createGatewayServer. Returns false for any other path. Writes are
 * same-origin JSON only, as for the language preference.
 */
export async function handleBankDetails(
  request: IncomingMessage,
  response: ServerResponse,
  service: BankDetailsService | undefined,
  origin: string | undefined,
): Promise<boolean> {
  const path = new URL(request.url ?? "/", "http://gateway.invalid").pathname;
  const receiptRef = RECEIPT.exec(path)?.[1];
  if (path !== PREVIEW && path !== CONFIRM && receiptRef === undefined) return false;
  const send = (result: BankDetailsResult): void => {
    response.writeHead(result.status, {
      "content-type": "application/json", "cache-control": "no-store",
      "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
    });
    response.end(JSON.stringify(result.body));
  };
  try {
    if (!service || !origin) { send({ status: 503, body: { error: "safe_write_unavailable" } }); return true; }
    const sessionId = sessionCookie(request.headers.cookie);
    if (receiptRef !== undefined) {
      if (request.method !== "GET") { send({ status: 404, body: { error: "not_found" } }); return true; }
      send(await service.receipt(sessionId, receiptRef));
      return true;
    }
    if (request.method !== "POST") { send({ status: 404, body: { error: "not_found" } }); return true; }
    if (request.headers.origin !== origin || request.headers["sec-fetch-site"] === "cross-site") {
      request.resume();
      send({ status: 403, body: { error: "origin_rejected" } });
      return true;
    }
    if (request.headers["content-type"] !== "application/json") {
      request.resume();
      send({ status: 400, body: { error: "invalid_request" } });
      return true;
    }
    const body = await readJson(request);
    if (!body.ok) { send({ status: 400, body: { error: "invalid_request" } }); return true; }
    send(path === PREVIEW ? await service.preview(sessionId, body.value) : await service.confirm(sessionId, body.value));
  } catch {
    // Dependency messages, and the bank details themselves, never reach an error body.
    if (!response.headersSent) send({ status: 503, body: { error: "safe_write_unavailable" } });
    else response.destroy();
  }
  return true;
}

/** Writes a page in the site shell; a 401 becomes the shared signed-out page. */
export type BankDetailsPageWriter = (status: number, title: string, body: string) => void;

const PAGE = "/profile/bank";
const PAGE_REVIEW = "/profile/bank/review";
const PAGE_CONFIRM = "/profile/bank/confirm";
const PAGE_FIELDS = ["bankId", "beneficiaryName", "iban"] as const;
const PAGE_TITLE = "Bank details";

const esc = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

const MISSING_MESSAGES: Readonly<Record<(typeof PAGE_FIELDS)[number], string>> = {
  bankId: "Choose your bank.",
  iban: "Enter your IBAN.",
  beneficiaryName: "Enter the account holder's name.",
};

const INPUT_MESSAGES: Readonly<Record<string, string>> = {
  invalid_bank: "Choose your bank from the list.",
  invalid_iban: "Enter a valid IBAN. A Kuwaiti IBAN starts with KW and has 30 characters.",
  invalid_beneficiary_name: "Enter the account holder's name as the bank has it, between 2 and 70 characters.",
};

async function readForm(request: IncomingMessage): Promise<Record<string, string> | undefined> {
  if (Number(request.headers["content-length"]) > BODY_LIMIT) { request.resume(); return undefined; }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > BODY_LIMIT) { request.resume(); return undefined; }
    chunks.push(bytes);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(Buffer.concat(chunks).toString("utf8"))) {
    if (Object.hasOwn(out, key)) return undefined;
    out[key] = value;
  }
  return out;
}

function bankName(choices: readonly BankChoice[], id: string): string {
  return choices.find((choice) => choice.id === id.toLowerCase())?.name ?? "Bank no longer listed";
}

function detailsList(details: MaskedBankDetails, choices: readonly BankChoice[]): string {
  return `<dl class="profile-facts"><dt>Bank</dt><dd>${esc(bankName(choices, details.bankId))}</dd>`
    + `<dt>IBAN</dt><dd><span class="masked">${esc(details.ibanMasked)}</span></dd>`
    + `<dt>Account holder</dt><dd>${esc(details.beneficiaryName)}</dd></dl>`;
}

/**
 * The change form. No typed value is written back into it: after a refusal the
 * person types the IBAN and name again; only a bank picked from the list stays picked.
 */
function changeForm(choices: readonly BankChoice[], selected = "", errors: readonly string[] = []): string {
  const error = errors.length === 1 ? errors[0] : undefined;
  const described = errors.length ? ' aria-describedby="bank-error" aria-invalid="true"' : "";
  const options = choices.map((choice) =>
    `<option value="${esc(choice.id)}"${choice.id === selected.toLowerCase() ? " selected" : ""}>${esc(choice.name)}</option>`).join("");
  return `<form method="post" action="${PAGE_REVIEW}" novalidate>`
    + (error ? `<p id="bank-error" class="form-error" role="alert">${esc(error)}</p>`
      : errors.length ? `<div id="bank-error" class="form-error" role="alert"><p>Your bank details weren’t saved yet:</p><ul>${errors.map((item) => `<li>${esc(item)}</li>`).join("")}</ul></div>` : "")
    + `<label>Bank<select name="bankId" required${described}><option value="">Choose your bank</option>${options}</select></label>`
    + `<label>IBAN<input name="iban" required autocomplete="off" spellcheck="false" maxlength="42"${described}></label>`
    + `<label>Account holder's name<input name="beneficiaryName" required maxlength="140"${described}></label>`
    + `<button class="button primary" type="submit">Review change</button></form>`;
}

function refusalPage(write: BankDetailsPageWriter, status: number): void {
  if (status === 401) { write(401, PAGE_TITLE, ""); return; }
  if (status === 503) {
    // A 503 can follow a committed write (the receipt step failed), so it never claims nothing changed.
    write(503, PAGE_TITLE, `<main id="main" class="profile-main"><h1>We couldn’t finish this right now.</h1><p>If you were saving a change, it may have gone through. Open your bank details to see what is saved now before you try again.</p><a class="button primary" href="${PAGE}">Open bank details</a></main>`);
    return;
  }
  const message = status === 409 ? "This review has expired, or your bank details changed while you were reviewing. Open them again and retry."
    : "This change is no longer available.";
  write(status, PAGE_TITLE, `<main id="main" class="profile-main"><h1>Your bank details weren’t changed.</h1><p>${message}</p><a class="button primary" href="${PAGE}">Back to bank details</a></main>`);
}

/**
 * C-15: the candidate's own bank details page. `GET /profile/bank` shows the
 * details masked (the full IBAN never leaves the server) with a change form;
 * the form goes through the same preview → confirm → receipt contract as the
 * JSON API, as same-origin form posts. Returns false for any other path.
 * Someone without a bank details record (not a candidate: the store refuses
 * them as not_own_record) gets the shared not-found answer.
 * Neither the values nor the dependency errors are logged.
 */
export async function handleBankDetailsPage(
  request: IncomingMessage,
  response: ServerResponse,
  service: BankDetailsService | undefined,
  origin: string | undefined,
  write: BankDetailsPageWriter,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://gateway.invalid");
  const path = url.pathname;
  if (path !== PAGE && path !== PAGE_REVIEW && path !== PAGE_CONFIRM) return false;
  const sessionId = sessionCookie(request.headers.cookie);
  try {
    if (path === PAGE) {
      if (request.method !== "GET" && request.method !== "HEAD") { request.resume(); writeNotFound(request, response); return true; }
      if (!service) { writeNotFound(request, response); return true; }
      const current = await service.current(sessionId);
      if (current.status === 404) { writeNotFound(request, response); return true; }
      if (current.status !== 200) { refusalPage(write, current.status); return true; }
      const details = (current.body as { details: MaskedBankDetails | null }).details;
      const choices = await service.bankChoices();
      // The saved notice needs this person's own receipt: a hand-typed link never claims a save.
      const receiptRef = /^\?saved=([0-9a-f]{64})$/.exec(url.search)?.[1];
      const saved = receiptRef !== undefined && (await service.receipt(sessionId, receiptRef)).status === 200;
      write(200, PAGE_TITLE, `<main id="main" class="profile-main"><h1>Bank details<span class="accent">.</span></h1>`
        + (saved ? `<p class="notice" role="status">Your bank details were saved.</p>` : "")
        + `<p>Your pay is sent to this account. Only you can see or change it here.</p>`
        + (details ? detailsList(details, choices) : `<p>You haven’t added bank details yet.</p>`)
        + `<h2>${details ? "Change your bank details" : "Add your bank details"}</h2>${changeForm(choices)}`
        + `<a class="text-link" href="/profile">Back to My profile</a></main>`);
      return true;
    }
    if (request.method !== "POST") { request.resume(); writeNotFound(request, response); return true; }
    if (!service || !origin) { request.resume(); refusalPage(write, 503); return true; }
    // Same-origin form posts only (the JSON API's check, written page-side so each has its own mutation anchor).
    if (request.headers["sec-fetch-site"] === "cross-site" || request.headers.origin !== origin) { request.resume(); refusalPage(write, 403); return true; }
    if (!request.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) { request.resume(); refusalPage(write, 400); return true; }
    const values = await readForm(request);
    if (!values) { refusalPage(write, 400); return true; }
    if (path === PAGE_REVIEW) {
      const details = Object.fromEntries(PAGE_FIELDS.map((key) => [key, values[key]]));
      if (!exactKeys(values, PAGE_FIELDS)) { refusalPage(write, 400); return true; }
      // Ownership first: someone without a bank details record gets the shared not-found answer
      // before any correction form, whatever they typed.
      const current = await service.current(sessionId);
      if (current.status === 404) { writeNotFound(request, response); return true; }
      if (current.status !== 200) { refusalPage(write, current.status); return true; }
      const missing = (["bankId", "iban", "beneficiaryName"] as const).filter((key) => values[key]!.trim() === "").map((key) => MISSING_MESSAGES[key]);
      if (missing.length) {
        // Empty or partly filled: every missing part is named, before anything is checked.
        const choices = await service.bankChoices();
        write(400, PAGE_TITLE, `<main id="main" class="profile-main"><h1>Change your bank details<span class="accent">.</span></h1>${changeForm(choices, values.bankId, missing)}<a class="text-link" href="${PAGE}">Cancel</a></main>`);
        return true;
      }
      const result = await service.stageReview(sessionId, details);
      if (result.status === 403) { writeNotFound(request, response); return true; }
      const reason = result.status === 400 ? (result.body as { error?: string }).error : undefined;
      const message = reason ? INPUT_MESSAGES[reason] : undefined;
      if (message) {
        const choices = await service.bankChoices();
        write(400, PAGE_TITLE, `<main id="main" class="profile-main"><h1>Change your bank details<span class="accent">.</span></h1>${changeForm(choices, values.bankId, [message])}<a class="text-link" href="${PAGE}">Cancel</a></main>`);
        return true;
      }
      if (result.status !== 200) { refusalPage(write, result.status); return true; }
      const preview = result.body as { before: MaskedBankDetails | null; after: MaskedBankDetails; reviewRef: string };
      const choices = await service.bankChoices();
      // The typed values and the token stay on the server; the page carries only the review reference.
      const hidden = `<input type="hidden" name="review" value="${esc(preview.reviewRef)}">`;
      write(200, "Review bank details", `<main id="main" class="profile-main"><h1>Review bank details<span class="accent">.</span></h1>`
        + (preview.before ? `<h2>Now</h2>${detailsList(preview.before, choices)}` : `<p>You haven’t added bank details yet.</p>`)
        + `<h2>After the change</h2>${detailsList(preview.after, choices)}`
        + `<p>Check the bank and the last four characters of the IBAN against your bank card or statement.</p>`
        + `<form method="post" action="${PAGE_CONFIRM}">${hidden}<button class="button primary" type="submit">Confirm change</button></form>`
        + `<a class="text-link" href="${PAGE}">Cancel</a></main>`);
      return true;
    }
    if (!exactKeys(values, ["review"])) { refusalPage(write, 400); return true; }
    const result = await service.confirmReview(sessionId, values.review!);
    if (result.status === 403) { writeNotFound(request, response); return true; }
    if (result.status !== 200) { refusalPage(write, result.status); return true; }
    const receiptRef = (result.body as { receipt: Receipt }).receipt.receiptRef;
    response.writeHead(303, { location: `${PAGE}?saved=${receiptRef}`, "cache-control": "no-store" });
    response.end();
  } catch {
    // Dependency messages, and the bank details themselves, never reach a page or a log.
    if (!response.headersSent) refusalPage(write, 503);
    else response.destroy();
  }
  return true;
}
