import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionStore } from "@studenthub/login-contract";
import { createPersonSelfEdit, PERSON_SELF_EDIT_FIELDS, type PersonSelfEditField } from "@studenthub/profile";
import { personRecordRef, safeWritePrincipalRef } from "@studenthub/db";
import type { ActionToken, Receipt, RejectionReason, SafeWriteClock, SafeWriteSecret, SafeWriteStore } from "@studenthub/safe-write-contract";

export interface PersonProfileEditStore {
  forPrincipal(principalId: string): SafeWriteStore;
  readReceipt(principalId: string, receiptRef: string): Promise<Receipt | null>;
  readProfileChoices?(): Promise<{ readonly countries: readonly { readonly id: string; readonly name: string }[]; readonly universities: readonly { readonly id: string; readonly name: string }[] }>;
}
export type ProfileEditResult = { readonly status: 200; readonly body: unknown }
  | { readonly status: 400 | 401 | 403 | 404 | 409 | 503; readonly body: { readonly error: string } };
export interface ProfileEdit {
  preview(session: string | undefined, body: unknown): Promise<ProfileEditResult>;
  confirm(session: string | undefined, body: unknown): Promise<ProfileEditResult>;
  receipt(session: string | undefined, ref: string): Promise<ProfileEditResult>;
  displayValue(session: string | undefined, field: PersonSelfEditField, value: string): Promise<string>;
}
const TOKEN_KEYS = ["changeSetDigest", "expectedBeforeDigest", "expiresAt", "issuedAt", "mac", "principalRef", "tokenId"] as const;
const BODY_LIMIT = 65536;
const PREVIEW = "/profile/edit/preview", CONFIRM = "/profile/edit/confirm";
const RECEIPT = /^\/profile\/edit\/receipts\/([0-9a-f]{64})$/;

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort(), wanted = [...keys].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}
function field(value: unknown): PersonSelfEditField | undefined {
  return typeof value === "string" && PERSON_SELF_EDIT_FIELDS.includes(value as PersonSelfEditField) ? value as PersonSelfEditField : undefined;
}
function token(value: unknown): ActionToken | undefined {
  return exact(value, TOKEN_KEYS) && TOKEN_KEYS.every(key => typeof value[key] === "string") ? value as unknown as ActionToken : undefined;
}
function refusal(reason: RejectionReason): ProfileEditResult {
  return { status: reason === "not_own_record" ? 403 : reason === "receipt_failed" ? 503
    : reason.startsWith("token_") || reason === "state_changed" ? 409 : 400, body: { error: reason } };
}
export function createProfileEdit(ports: { sessions: Pick<SessionStore, "get">; store: PersonProfileEditStore; secret: SafeWriteSecret; clock?: SafeWriteClock }): ProfileEdit {
  const principal = async (session: string | undefined) => session ? (await ports.sessions.get(session))?.personId : undefined;
  const writer = (id: string) => createPersonSelfEdit({ store: ports.store.forPrincipal(id), secret: ports.secret, ...(ports.clock ? { clock: ports.clock } : {}) });
  return {
    async displayValue(session, selected, value) {
      if (!await principal(session)) return value;
      if (selected === "drivingLicence" || selected === "kuwaitiMother") return value === "true" ? "Yes" : value === "false" ? "No" : "Not recorded";
      if (selected === "jobSearchStatus") return ({ not_looking: "Not looking right now", active: "Actively looking", open_to_offers: "Open to offers" } as Record<string,string>)[value] ?? value;
      if (selected === "nationality" || selected === "university") {
        const choices = await ports.store.readProfileChoices?.() ?? { countries: [], universities: [] };
        return (selected === "nationality" ? choices.countries : choices.universities).find(item => item.id === value)?.name ?? (value === "" ? "Not recorded" : value);
      }
      return value;
    },
    async preview(session, body) {
      const id = await principal(session); if (!id) return { status: 401, body: { error: "unauthorized" } };
      if (!exact(body, ["field", "value"])) return { status: 400, body: { error: "invalid_request" } };
      const selected = field(body.field); if (!selected || typeof body.value !== "string") return refusal("invalid_value");
      const result = await writer(id).preview({ principalRef: safeWritePrincipalRef(id), change: { personRef: personRecordRef(id), field: selected, value: body.value } });
      return result.ok ? { status: 200, body: { changes: result.changes, token: result.token } } : refusal(result.reason);
    },
    async confirm(session, body) {
      const id = await principal(session); if (!id) return { status: 401, body: { error: "unauthorized" } };
      if (!exact(body, ["field", "token", "value"])) return { status: 400, body: { error: "invalid_request" } };
      const selected = field(body.field), action = token(body.token);
      if (!selected || typeof body.value !== "string") return refusal("invalid_value");
      if (!action) return refusal("token_not_issued");
      const result = await writer(id).confirm({ principalRef: safeWritePrincipalRef(id), token: action, change: { personRef: personRecordRef(id), field: selected, value: body.value } });
      return result.ok ? { status: 200, body: { receipt: result.receipt } } : refusal(result.reason);
    },
    async receipt(session, ref) {
      const id = await principal(session); if (!id) return { status: 401, body: { error: "unauthorized" } };
      const found = await ports.store.readReceipt(id, ref);
      return found ? { status: 200, body: { receipt: found } } : { status: 404, body: { error: "receipt_not_found" } };
    },
  };
}
function cookie(header: string | undefined) { for (const part of header?.split(";") ?? []) { const [key, ...rest] = part.trim().split("="); const value = rest.join("="); if (key === "__Host-studenthub_session" && /^[A-Za-z0-9_-]{43}$/.test(value)) return value; } return undefined; }
async function body(request: IncomingMessage, form: boolean): Promise<unknown | undefined> {
  if (Number(request.headers["content-length"]) > BODY_LIMIT) { request.resume(); return undefined; }
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > BODY_LIMIT) { request.resume(); return undefined; } chunks.push(bytes); }
  const text = Buffer.concat(chunks).toString("utf8");
  if (form) { const out: Record<string, string> = {}; for (const [key, value] of new URLSearchParams(text)) { if (Object.hasOwn(out, key)) return undefined; out[key] = value; } return out; }
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}
function send(response: ServerResponse, result: ProfileEditResult) { response.writeHead(result.status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" }); response.end(JSON.stringify(result.body)); }
export async function handleProfileEdit(request: IncomingMessage, response: ServerResponse, service: ProfileEdit | undefined, origin: string | undefined): Promise<boolean> {
  const path = new URL(request.url ?? "/", "http://gateway.invalid").pathname, ref = RECEIPT.exec(path)?.[1];
  if (path !== PREVIEW && path !== CONFIRM && !ref) return false;
  if (request.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) return false;
  try {
    if (!service || !origin) { send(response, { status: 503, body: { error: "safe_write_unavailable" } }); return true; }
    if (ref) { send(response, request.method === "GET" ? await service.receipt(cookie(request.headers.cookie), ref) : { status: 404, body: { error: "not_found" } }); return true; }
    if (request.method !== "POST") { send(response, { status: 404, body: { error: "not_found" } }); return true; }
    if (request.headers.origin !== origin || request.headers["sec-fetch-site"] === "cross-site") { request.resume(); send(response, { status: 403, body: { error: "origin_rejected" } }); return true; }
    if (request.headers["content-type"] !== "application/json") { request.resume(); send(response, { status: 400, body: { error: "invalid_request" } }); return true; }
    const parsed = await body(request, false); if (parsed === undefined) { send(response, { status: 400, body: { error: "invalid_request" } }); return true; }
    send(response, path === PREVIEW ? await service.preview(cookie(request.headers.cookie), parsed) : await service.confirm(cookie(request.headers.cookie), parsed));
  } catch { if (!response.headersSent) send(response, { status: 503, body: { error: "safe_write_unavailable" } }); else response.destroy(); }
  return true;
}
export type ProfileEditPageWriter = (status: number, title: string, body: string) => void;
/** The text rendered for this field on My profile, including its missing-state label. */
export type ShownProfileValue = (sessionId: string | undefined, field: PersonSelfEditField) => Promise<string | undefined>;
export function shownProfileValue(field: { readonly state: "available" | "unavailable"; readonly value?: unknown; readonly freshness: { readonly kind: string } }): string {
  return field.state === "available" ? String(field.value)
    : field.freshness.kind === "written_by_person" ? "Not recorded" : "Unavailable";
}
const esc = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const FIELD_LABELS: Readonly<Record<PersonSelfEditField, string>> = { displayName: "Display name", arabicName: "Arabic name", objective: "Objective", intro: "Introduction", preferredTime: "Preferred time", gender: "Gender", birthDate: "Birth date", nationality: "Nationality", university: "University", drivingLicence: "Driving licence", kuwaitiMother: "Kuwaiti mother", jobSearchStatus: "Work status" };
export function profileEditSummary(value: string): string {
  let result = "", count = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)) { const length = [...segment].length; if (count + length > 120) break; result += segment; count += length; }
  return result + (result.length < value.length ? "…" : "");
}
function error(write: ProfileEditPageWriter, status: number) { write(status, "Edit profile", status === 401 ? "" : `<main id="main" class="error-page"><h1>Your profile wasn’t changed.</h1><p>${status === 409 ? "Your profile changed while you were reviewing. Open it again and retry." : status === 503 ? "The profile service is unavailable. Please try again in a moment." : "This change is no longer available."}</p><a class="button primary" href="/profile">Back to My profile</a></main>`); }
function invalidForm(write: ProfileEditPageWriter, selected: PersonSelfEditField, value: string) {
  const label = FIELD_LABELS[selected], control = selected === "intro" ? `<textarea name="value" maxlength="5000" aria-describedby="value-error">${esc(value)}</textarea>` : `<input name="value" value="${esc(value)}" maxlength="${selected === "displayName" || selected === "arabicName" ? 255 : 100}" aria-describedby="value-error">`;
  const birthMessage = selected === "birthDate" ? (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? "Enter a valid birth date." : value > new Date().toISOString().slice(0,10) ? "Birth date cannot be in the future." : "You must be at least 16 years old.") : undefined;
  write(400, "Edit profile", `<main id="main" class="profile-main"><h1>Change ${label}<span class="accent">.</span></h1><form method="post" action="${PREVIEW}"><input type="hidden" name="field" value="${selected}"><label>${label}${control}</label><p id="value-error">${birthMessage ?? `Enter a value that follows the rules for ${label.toLowerCase()}.`}</p><button class="button primary" type="submit">Review change</button></form><a class="text-link" href="/profile">Cancel</a></main>`);
}
export async function handleProfileEditPage(request: IncomingMessage, response: ServerResponse, service: ProfileEdit | undefined, origin: string | undefined, write: ProfileEditPageWriter, shownValue?: ShownProfileValue): Promise<boolean> {
  const path = new URL(request.url ?? "/", "http://gateway.invalid").pathname;
  if ((path !== PREVIEW && path !== CONFIRM) || !request.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) return false;
  if (request.method !== "POST") { error(write, 404); return true; } if (!service || !origin) { error(write, 503); return true; }
  if (request.headers.origin !== origin || request.headers["sec-fetch-site"] === "cross-site") { request.resume(); error(write, 403); return true; }
  try {
    const values = await body(request, true) as Record<string, string> | undefined; if (!values) { error(write, 400); return true; }
    if (path === PREVIEW) {
      if (Object.keys(values).sort().join() !== "field,value") { error(write, 400); return true; }
      const selected = field(values.field); if (!selected || typeof values.value !== "string") { error(write, 400); return true; }
      const sessionId = cookie(request.headers.cookie);
      const result = await service.preview(sessionId, values); if (result.status !== 200) { if (result.status === 400 && (result.body as { error?: string }).error === "invalid_value") invalidForm(write, selected, values.value); else error(write, result.status); return true; }
      const action = (result.body as { token: ActionToken }).token;
      const hidden = TOKEN_KEYS.map(key => `<input type="hidden" name="token.${key}" value="${esc(action[key])}">`).join("");
      const before = await shownValue?.(sessionId, selected);
      const summary = (value: string | undefined) => value ? esc(profileEditSummary(value)) : "Not recorded";
      const after = await service.displayValue(sessionId, selected, values.value!);
      write(200, "Review profile change", `<main id="main" class="profile-main"><h1>Review profile change<span class="accent">.</span></h1><p>${FIELD_LABELS[selected]}: <strong>${summary(before)}</strong> → <strong>${summary(after)}</strong></p><form method="post" action="${CONFIRM}"><input type="hidden" name="field" value="${selected}"><input type="hidden" name="value" value="${esc(values.value!)}">${hidden}<button class="button primary" type="submit">Confirm change</button></form><a class="text-link" href="/profile">Cancel</a></main>`); return true;
    }
    const expected = ["field", "value", ...TOKEN_KEYS.map(key => `token.${key}`)].sort(); if (Object.keys(values).sort().join() !== expected.join()) { error(write, 400); return true; }
    const action = Object.fromEntries(TOKEN_KEYS.map(key => [key, values[`token.${key}`]]));
    const result = await service.confirm(cookie(request.headers.cookie), { field: values.field, value: values.value, token: action }); if (result.status !== 200) { error(write, result.status); return true; }
    response.writeHead(303, { location: "/profile", "cache-control": "no-store" }); response.end(); return true;
  } catch { if (!response.headersSent) error(write, 503); else response.destroy(); return true; }
}
