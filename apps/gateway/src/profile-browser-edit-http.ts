import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PERSON_SELF_EDIT_FIELDS, kuwaitDate, validatePersonSelfEditValue, type PersonSelfEditField } from "@studenthub/profile";
import { PersonProfileBrowserRetryableError } from "@studenthub/db/profile";
import { browserChangeSetDigest, type BrowserBaseline, type BrowserWriteToken, type BrowserWriteOutcome, type BrowserReceiptStatus, type Receipt, type SafeWriteSecret } from "@studenthub/safe-write-contract";
import type { OriginChoices } from "./profile-edit-http.js";
import { profileControl, profileErrorSummary, type ProfileFieldKey } from "./ui/profile-kit.js";
import { profileCopyText, type ProfileCopyKey, type ProfileLanguage } from "./ui/profile-copy.js";

export interface BrowserProfilePrepared {
  readonly token: BrowserWriteToken;
  readonly persisted: BrowserBaseline["persisted"] & { readonly writtenAt: string | null };
  readonly shownFallback: null | { readonly sourceField: string; readonly value: string | boolean; readonly evidence: NonNullable<BrowserBaseline["shownFallback"]> };
}
export interface BrowserProfileSession {
  canEdit?(field: PersonSelfEditField): Promise<boolean>;
  validate?(field: PersonSelfEditField, canonicalValue: string): Promise<"choice" | "contact_unavailable" | null>;
  prepare(field: PersonSelfEditField): Promise<BrowserProfilePrepared>;
  save(input: { token: BrowserWriteToken; canonicalValue: string }): Promise<BrowserWriteOutcome>;
  receiptStatus(token: BrowserWriteToken): Promise<BrowserReceiptStatus>;
}
export interface VerifiedProfileNotice { readonly title: string; readonly message: string }
export interface ProfileBrowserResult { readonly status: number; readonly title: string; readonly html: string; readonly language?: ProfileLanguage; readonly setCookie?: string; readonly location?: string }
export interface ProfileBrowserEdit {
  edit(session: string | undefined, field: PersonSelfEditField, resolvedLanguage?: (language: ProfileLanguage) => void): Promise<ProfileBrowserResult>;
  submit(session: string | undefined, field: PersonSelfEditField, body: unknown, mode: "save" | "status", resolvedLanguage?: (language: ProfileLanguage) => void): Promise<ProfileBrowserResult>;
  notice(session: string | undefined, cookieHeader: string | undefined): Promise<{ notice?: VerifiedProfileNotice; clearCookie?: string }>;
}
type PlainCopyKey = { [K in ProfileCopyKey]: Parameters<typeof profileCopyText<K>>["length"] extends 2 ? K : never }[ProfileCopyKey];
const label = (language: ProfileLanguage, field: PersonSelfEditField): string => profileCopyText(language, `field.${field}` as `field.${PersonSelfEditField}`);
// Translate trusted interface copy only, never a submitted value or imported label.
const MESSAGE_KEYS = [
  "editor.requiredValue", "editor.length", "error.name", "error.arabicName", "editor.spacing", "editor.characters", "error.date", "error.future", "error.minimumAge", "error.choice", "editor.contactUnavailable",
  "error.session", "error.denied", "error.security", "error.unknown", "error.tokenPayloadMismatch", "editor.motherEligibility", "editor.recoverySecurity", "editor.recoveryUnavailable", "editor.noReceipt", "editor.differentChange", "editor.rollback", "editor.conflict", "editor.expired", "editor.serviceUnavailable", "editor.pageUnavailable", "editor.verifyRequest", "editor.invalidRequest",
] as const;
const messageKeys = new Map(MESSAGE_KEYS.map(key => [profileCopyText("en", key), key]));
const message = (language: ProfileLanguage, value: string): string => {
  const key = messageKeys.get(value);
  return key ? profileCopyText(language, key) : value;
};
const NOTICE = "studenthub_profile_notice", LIMIT = 65536, NOTICE_MS = 120000;
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
// Build the translated template before inserting data: placeholder-looking user
// values are escaped once and never reinterpreted as copy or markup.
const importedSelectionHtml = (language: ProfileLanguage, value: string): string =>
  profileCopyText(language,"editor.importedSelection",{value:"{value}"})
    .split("{value}").map(esc).join(`<bdi dir="auto">${esc(value)}</bdi>`);
const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${esc(value)}">`;
const selected = (s: string): s is PersonSelfEditField => PERSON_SELF_EDIT_FIELDS.includes(s as PersonSelfEditField);
const raw = (p: BrowserProfilePrepared) => p.persisted.kind === "null" ? "" : String(p.persisted.value);
function visible(p: BrowserProfilePrepared, field: PersonSelfEditField): string {
  if (p.persisted.kind === "present" || p.persisted.writtenAt !== null) return raw(p);
  // Imported reference labels are not canonical identifiers. Require an explicit selection.
  return field === "nationality" || field === "university" ? "" : p.shownFallback === null ? "" : String(p.shownFallback.value);
}
function exact(body: unknown, keys: string[]): body is Record<string, string> {
  return !!body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).sort().join() === keys.sort().join() && Object.values(body).every(v => typeof v === "string");
}
function parseToken(text: string): BrowserWriteToken | undefined {
  try { const t: unknown = JSON.parse(text); if (!t || typeof t !== "object" || Array.isArray(t)) return undefined;
    const keys = ["contractVersion","purpose","keyVersion","tokenId","tokenRef","principalRef","personRef","field","normalizationVersion","baselineDigest","issuedAt","expiresAt","mac"];
    return exact(t, keys) ? t as unknown as BrowserWriteToken : undefined;
  } catch { return undefined; }
}
function cookie(header: string | undefined, key: string): string | undefined {
  const values = (header ?? "").split(";").map(x => x.trim()).filter(x => x.startsWith(`${key}=`));
  return values.length === 1 ? values[0]!.slice(key.length + 1) : undefined;
}
const fail = (status: number, value: string, language: ProfileLanguage = "en"): ProfileBrowserResult => ({ status, language, title: profileCopyText(language,"editor.title"), html: `<main id="main" class="profile-ui"><div class="p-shell"><section class="p-main p-card p-stack"><h1>${esc(profileCopyText(language,"editor.unavailable"))}</h1><p>${esc(message(language,value))}</p><a class="p-button" href="/profile">${esc(profileCopyText(language,"nav.back"))}</a></section></div></main>` });
const RADIO_FIELDS: readonly PersonSelfEditField[] = ["gender","drivingLicence","jobSearchStatus","kuwaitiMother"];
const reasons: Record<string, string> = { required: "Enter a value.", length: "This value is too long. Shorten it and try again.", name: "Use at least two letter-based name parts with single spaces; check punctuation.", arabic_name: "Enter a name containing Arabic letters.", spacing: "Remove spaces at the start or end and repeated spaces.", characters: "Remove line breaks and unsupported characters.", date: "Enter a valid calendar date.", future: "Birth date cannot be in the future.", minimum_age: "You must be at least 16 to complete a StudentHub profile.", choice: "Choose one of the available options.", contact_unavailable: "This contact value is not available." };
function control(field: PersonSelfEditField, value: string, recovery: boolean, error: string | undefined, choices: OriginChoices | undefined, language: ProfileLanguage): string {
  const t = (key: PlainCopyKey) => profileCopyText(language,key);
  if (field === "nationality" || field === "university") {
    const list = (field === "nationality" ? choices?.countries : choices?.universities) ?? [];
    return `<div class="p-field"><label for="field-${field}">${esc(label(language,field))}</label><select class="p-control" id="field-${field}" name="value"${error ? ` aria-invalid="true" aria-describedby="field-${field}-error"` : ""}><option value="">${esc(t(field === "nationality" ? "editor.chooseNationality" : "value.missing"))}</option>${value && !list.some(c => c.id === value) ? `<option value="${esc(value)}" selected>${esc(t("editor.selectionOptionUnavailable"))}</option>` : ""}${list.map(c => `<option dir="auto" value="${esc(c.id)}"${c.id === value ? " selected" : ""}>${esc(c.name)}</option>`).join("")}</select>${error ? `<p class="p-error" id="field-${field}-error">${esc(error)}</p>` : ""}</div>`;
  }
  if (field === "kuwaitiMother") return `<fieldset class="p-choice-group" id="field-kuwaitiMother"${error ? ' aria-invalid="true" aria-describedby="field-kuwaitiMother-error"' : ""}><legend>${esc(label(language,field))}</legend>${[["",t("value.missing")],["true",t("value.yes")],["false",t("value.no")]].map(([v,l]) => `<label class="p-choice"><input type="radio" name="value" required value="${v}"${value === v ? " checked" : ""}>${esc(l!)}</label>`).join("")}${error ? `<p class="p-error" id="field-kuwaitiMother-error">${esc(error)}</p>` : ""}</fieldset>`;
  const values = field === "gender" ? [["male",t("value.male")],["female",t("value.female")],["other",t("value.other")]] : field === "drivingLicence" ? [["true",t("value.yes")],["false",t("value.no")]] : field === "jobSearchStatus" ? [["not_looking",t("value.notLooking")],["active",t("value.active")],["open_to_offers",t("value.open")]] : undefined;
  const hint = field === "displayName" || field === "arabicName" ? `${t(field === "displayName" ? "help.name" : "help.arabicName")} ${profileCopyText(language,"help.limit",{limit:255})}` : field === "objective" || field === "intro" || field === "preferredTime" ? `${field === "preferredTime" ? `${t("help.preferredTime")} ` : ""}${t("help.optional")} ${t("help.text")} ${profileCopyText(language,"help.limit",{limit:field === "intro" ? 5000 : 100})}` : field === "birthDate" ? `${t("help.date")} ${t("help.birth")}` : undefined;
  return profileControl({ key: field as ProfileFieldKey, label: label(language,field), value, recovery, ...(hint ? {hint} : {}), ...(error ? {error} : {}), ...(values ? { type: "radio" as const, required:true, requiredLabel:t("editor.required"), choices: values.map(([value,label]) => ({value:value!,label:label!})) } : {}) }).html;
}
function displayCurrent(field: PersonSelfEditField, value: string, choices: OriginChoices | undefined, language: ProfileLanguage): string {
  const t = (key: PlainCopyKey) => profileCopyText(language,key);
  if (value === "") return t("value.missing");
  if (field === "nationality" || field === "university") {
    const list = field === "nationality" ? choices?.countries : choices?.universities;
    return list?.find(choice => choice.id.toLowerCase() === value.toLowerCase())?.name ?? t("editor.selectionUnavailable");
  }
  if (field === "drivingLicence" || field === "kuwaitiMother") return ({true:t("value.yes"),false:t("value.no")} as Record<string,string>)[value] ?? t("editor.selectionUnavailable");
  if (field === "gender") return ({male:t("value.male"),female:t("value.female"),other:t("value.other")} as Record<string,string>)[value] ?? t("editor.selectionUnavailable");
  if (field === "jobSearchStatus") return ({not_looking:t("value.notLooking"),active:t("value.active"),open_to_offers:t("value.open")} as Record<string,string>)[value] ?? t("editor.selectionUnavailable");
  return value;
}
function form(field: PersonSelfEditField, token: BrowserWriteToken, value: string, options: { status?: number; error?: string; message?: string; importedSelection?: string; current?: string; currentImportedLabel?: string; recovery?: boolean; recoveryProof?: string; choices?: OriginChoices; language?: ProfileLanguage } = {}): ProfileBrowserResult {
  const language = options.language ?? "en", t = (key: PlainCopyKey) => profileCopyText(language,key);
  const error = options.error ? message(language,options.error) : undefined, safeValue = field === "phone" && (options.recovery || error) ? "" : value;
  const summary = error ? (["nationality","university","kuwaitiMother"].includes(field) ? `<section class="p-error-summary" tabindex="-1" id="profile-error-summary"><h2>${esc(t("state.invalid"))}</h2><a href="#field-${field}">${esc(error)}</a></section>` : profileErrorSummary(t("state.invalid"), [{key:field as ProfileFieldKey,message:error}]).html) : "";
  const title = profileCopyText(language,"title.edit",{field:label(language,field)});
  return {status:options.status ?? 200,language,title,html:`<main id="main" class="profile-ui"><div class="p-shell"><section class="p-main p-card p-stack"><a href="/profile">${esc(t("nav.back"))}</a><h1 id="profile-edit-heading">${esc(title)}</h1>${summary.replace('tabindex="-1"', 'tabindex="-1" autofocus')}${options.message ? `<p>${esc(message(language,options.message))}</p>` : ""}${options.importedSelection !== undefined ? `<p>${importedSelectionHtml(language,options.importedSelection)}</p>` : ""}${options.current !== undefined && field !== "phone" ? `<p>${esc(t("draft.current"))}: <bdi dir="auto">${esc(options.current || t("value.missing"))}</bdi></p><p>${esc(t("draft.yours"))}</p>` : ""}${field === "phone" && (options.recovery || error) ? `<p>${esc(t("draft.phoneReentry"))}</p>` : ""}<form class="p-stack" id="profile-edit-form" method="post" action="/profile/edit/${field}/save">${hidden("token",JSON.stringify(token))}${options.recoveryProof ? hidden("recovery",options.recoveryProof) : ""}${control(field,safeValue,!!options.recovery,error,options.choices,language)}<p class="p-hint">${esc(t("draft.cancelHelp"))}</p><div class="p-actions"><button class="p-button p-primary" type="submit">${esc(t("action.save"))}</button><a class="p-button" href="/profile">${esc(t("action.cancel"))}</a></div></form></section></div></main>`};
}
function recovery(field: PersonSelfEditField, token: BrowserWriteToken, value: string, text: string, retry: boolean, proof: string, language: ProfileLanguage): ProfileBrowserResult {
  const t = (key: PlainCopyKey) => profileCopyText(language,key);
  const tokenInput = hidden("token",JSON.stringify(token)) + hidden("recovery",proof), payload = field === "phone" ? "" : hidden("value", value);
  return {status:503,language,title:t("status.unknown"),html:`<main id="main" class="profile-ui"><div class="p-shell"><section class="p-main p-card p-stack"><h1>${esc(t("status.unknown"))}</h1><p>${esc(message(language,text))}</p><form method="post" action="/profile/edit/${field}/status">${tokenInput}${payload}<button class="p-button p-primary" type="submit">${esc(t("action.check"))}</button></form>${retry ? `<form class="p-stack" id="profile-edit-form" method="post" action="/profile/edit/${field}/save">${tokenInput}${field === "phone" ? `<p>${esc(t("editor.phoneRetry"))}</p><label for="field-phone">${esc(label(language,"phone"))}</label><input class="p-control" id="field-phone" dir="ltr" type="tel" name="value" value="">` : payload}<button class="p-button" type="submit">${esc(t("action.retry"))}</button></form>` : ""}<a href="/profile/edit/${field}">${esc(t("editor.reviewCurrent"))}</a><a href="/profile">${esc(t("action.cancel"))}</a></section></div></main>`};
}
export function createProfileBrowserEdit(ports: {
  authorize(session: string | undefined): Promise<{ actorRef: string; store: BrowserProfileSession; language?: ProfileLanguage } | null>;
  secret: SafeWriteSecret; secure?: boolean; clock?: { now(): Date }; choices?: () => Promise<OriginChoices>;
}): ProfileBrowserEdit {
  const key = Buffer.from(ports.secret), now = () => (ports.clock?.now() ?? new Date()).getTime();
  if (key.length < 32) throw new TypeError("Profile notice key needs at least 32 bytes");
  const mac = (data: string) => createHmac("sha256",key).update(`profile-notice-v1:${data}`).digest("base64url");
  const sessionRef = (session: string) => createHash("sha256").update(session).digest("hex");
  const attrs = `Path=/profile; HttpOnly; SameSite=Strict${ports.secure ? "; Secure" : ""}`;
  const clearCookie = `${NOTICE}=; Max-Age=0; ${attrs}`;
  const authorized = async (session: string | undefined) => session ? ports.authorize(session) : null;
  const choiceList = async (field: PersonSelfEditField) => field === "nationality" || field === "university" ? await ports.choices?.() : undefined;
  const render = async (session: string | undefined, field: PersonSelfEditField, token: BrowserWriteToken, value: string, options: Parameters<typeof form>[3] = {}) => {
    const choices = await choiceList(field), live = await authorized(session);
    if (!live || live.actorRef !== token.principalRef) return fail(401,"Sign in again to continue safely.",options.language ?? "en");
    return form(field,token,value,{...options,choices,language:live.language ?? "en",...(options.current !== undefined ? {current:displayCurrent(field,options.current,choices,live.language ?? "en")} : {}),...(options.currentImportedLabel !== undefined ? {current:profileCopyText(live.language ?? "en","editor.imported",{value:options.currentImportedLabel})} : {})});
  };
  const recover = async (session: string | undefined, field: PersonSelfEditField, token: BrowserWriteToken, value: string, message: string, retry: boolean, proof: string, language: ProfileLanguage = "en") => {
    const live = await authorized(session);
    if (!live || live.actorRef !== token.principalRef) return fail(401,"Sign in again to continue safely.",language);
    return recovery(field,token,value,message,retry,proof,live.language ?? "en");
  };
  function success(session: string, actorRef: string, token: BrowserWriteToken, receipt: Receipt, language: ProfileLanguage = "en"): ProfileBrowserResult {
    if (receipt.principalRef !== actorRef || receipt.personRef !== token.personRef || receipt.fields.length !== 1 || receipt.fields[0] !== token.field) return fail(403,"This profile is no longer available.",language);
    const data = Buffer.from(JSON.stringify({session:sessionRef(session),actor:actorRef,receipt:receipt.receiptRef,token,expires:now()+NOTICE_MS})).toString("base64url");
    return {status:303,language,title:profileCopyText(language,"editor.saved"),html:"",location:`/profile#field-${token.field}`,setCookie:`${NOTICE}=${data}.${mac(data)}; Max-Age=120; ${attrs}`};
  }
  const recoveryProof = (session: string, token: BrowserWriteToken, value: string) => {
    const data = Buffer.from(JSON.stringify({session:sessionRef(session),token:token.tokenRef,digest:mac(`payload:${browserChangeSetDigest(token,value)}`)})).toString("base64url");
    return `${data}.${mac(`recovery:${data}`)}`;
  };
  const verifyRecovery = (proof: string, session: string, token: BrowserWriteToken): string | undefined => {
    try { const [data,signature,...extra] = proof.split("."); if (!data || !signature || extra.length) return undefined;
      const expected = mac(`recovery:${data}`); if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature),Buffer.from(expected))) return undefined;
      const parsed = JSON.parse(Buffer.from(data,"base64url").toString("utf8")) as {session:string;token:string;digest:string};
      return parsed.session === sessionRef(session) && parsed.token === token.tokenRef && /^[A-Za-z0-9_-]{43}$/.test(parsed.digest) ? parsed.digest : undefined;
    } catch { return undefined; }
  };
  return {
    async edit(session, field, resolvedLanguage) {
      const auth = await authorized(session); if (!auth) return fail(401,"Sign in again to continue safely.");
      resolvedLanguage?.(auth.language ?? "en");
      const localizedFail = (status: number, text: string) => fail(status,text,auth.language ?? "en");
      if (field === "kuwaitiMother" && await auth.store.canEdit?.(field) !== true) return localizedFail(403,"This question applies only when your nationality is not Kuwaiti.");
      let prepared: BrowserProfilePrepared;
      try { prepared = await auth.store.prepare(field); } catch (error) { if (error instanceof Error && error.message === "not_authorized") return localizedFail(401,"Sign in again to continue safely."); throw error; }
      return render(session,field,prepared.token,visible(prepared,field),{language:auth.language ?? "en",...((field === "nationality" || field === "university") && prepared.persisted.kind === "null" && prepared.persisted.writtenAt === null && prepared.shownFallback ? {importedSelection:String(prepared.shownFallback.value)} : {})});
    },
    async submit(session, field, body, mode, resolvedLanguage) {
      const auth = await authorized(session); if (!auth) return fail(401,"Sign in again to continue safely.");
      resolvedLanguage?.(auth.language ?? "en");
      const localizedFail = (status: number, text: string) => fail(status,text,auth.language ?? "en");
      // Unchecked radio groups are omitted by browsers. Only this exact normal
      // save shape is recoverable; never repair missing payloads in proof retries.
      const missingRadio = mode === "save" && RADIO_FIELDS.includes(field) && exact(body,["token"]);
      if (missingRadio) body = {...body as Record<string,string>,value:""};
      const hasProof = !!body && typeof body === "object" && Object.hasOwn(body,"recovery");
      if (!exact(body, [...(mode === "status" && field === "phone" ? ["token"] : ["token","value"]), ...(hasProof ? ["recovery"] : [])])) return localizedFail(400,"We could not verify this request. Reopen the form and try again.");
      const token = parseToken(body.token!);
      if (!token || token.field !== field || token.principalRef !== auth.actorRef) return localizedFail(403,"We could not verify this request. Reopen the form and try again.");
      if (missingRadio) return render(session,field,token,"",{language:auth.language ?? "en",status:400,error:reasons.choice!,recovery:true});
      const proofDigest = hasProof ? verifyRecovery(body.recovery!,session!,token) : undefined;
      if ((hasProof && !proofDigest) || (mode === "status" && !proofDigest)) return localizedFail(403,"We could not verify this recovery request. Review your current profile.");
      if (mode === "status") {
        const status = await auth.store.receiptStatus(token);
        if (status.status === "committed") return success(session!,auth.actorRef,token,status.receipt,auth.language ?? "en");
        if (status.status === "not_authorized") return localizedFail(401,"Sign in again to continue safely.");
        if (status.status === "recovery_unavailable") return localizedFail(409,"Save recovery is unavailable. Review your current profile before editing again.");
        return recover(session,field,token,body.value ?? "",status.status === "not_found" ? "No saved receipt was found. This is not proof that an earlier request cannot still finish. You may retry the same change." : "We could not confirm whether your change was saved. Check its status before trying another change.",true,body.recovery!,auth.language ?? "en");
      }
      const validation = validatePersonSelfEditValue(field,body.value,kuwaitDate(new Date(now())));
      if (!validation.ok) return render(session,field,token,body.value!,{language:auth.language ?? "en",status:400,error:reasons[validation.reason]!,recovery:true,recoveryProof:body.recovery});
      if (proofDigest && !timingSafeEqual(Buffer.from(mac(`payload:${browserChangeSetDigest(token,validation.value)}`)),Buffer.from(proofDigest))) return localizedFail(409,"This is a different change. Review your current profile and open a new form before saving it.");
      const unavailable = await auth.store.validate?.(field,validation.value);
      if (unavailable) {
        const prior = await auth.store.receiptStatus(token);
        if (prior.status === "not_authorized") return localizedFail(401,"Sign in again to continue safely.");
        if (prior.status === "recovery_unavailable") return localizedFail(409,"Save recovery is unavailable. Review your current profile before editing again.");
        if (prior.status === "unknown") return recover(session,field,token,validation.value,"We could not confirm whether your change was saved. Check its status before trying another change.",true,body.recovery ?? recoveryProof(session!,token,validation.value),auth.language ?? "en");
        if (prior.status === "committed" && prior.receipt.changeSetDigest === browserChangeSetDigest(token,validation.value)) return success(session!,auth.actorRef,token,prior.receipt,auth.language ?? "en");
        return render(session,field,token,body.value!,{language:auth.language ?? "en",status:400,error:reasons[unavailable]!,recovery:true,recoveryProof:body.recovery});
      }
      let outcome: BrowserWriteOutcome;
      try { outcome = await auth.store.save({token,canonicalValue:validation.value}); }
      catch (error) {
        if (error instanceof PersonProfileBrowserRetryableError) return recover(session,field,token,validation.value,"Nothing was saved, try again.",true,body.recovery ?? recoveryProof(session!,token,validation.value),auth.language ?? "en");
        return recover(session,field,token,validation.value,"We could not confirm whether your change was saved. Check its status before trying another change.",true,body.recovery ?? recoveryProof(session!,token,validation.value),auth.language ?? "en");
      }
      if (outcome.status === "committed" || outcome.status === "already_committed") return success(session!,auth.actorRef,token,outcome.receipt,auth.language ?? "en");
      if (outcome.status === "not_authorized") return localizedFail(401,"Sign in again to continue safely.");
      if (outcome.status === "unknown") return recover(session,field,token,validation.value,"We could not confirm whether your change was saved. Check its status before trying another change.",true,body.recovery ?? recoveryProof(session!,token,validation.value),auth.language ?? "en");
      if (outcome.status === "recovery_unavailable") return localizedFail(409,"Save recovery is unavailable. Review your current profile before editing again.");
      let fresh: BrowserProfilePrepared;
      try { fresh = await auth.store.prepare(field); } catch (error) { if (error instanceof Error && error.message === "not_authorized") return localizedFail(401,"Sign in again to continue safely."); throw error; }
      return render(session,field,fresh.token,body.value!,{language:auth.language ?? "en",status:409,recovery:true,current:visible(fresh,field),currentImportedLabel:(field === "nationality" || field === "university") && fresh.persisted.kind === "null" && fresh.persisted.writtenAt === null && fresh.shownFallback ? String(fresh.shownFallback.value) : undefined,message:outcome.status === "state_changed" ? "This value changed since you opened the form. Review the current value and your draft before saving." : outcome.status === "expired" ? "This form expired. Review the current value before saving your draft." : "This save attempt contains a different change. Review your draft before saving again."});
    },
    async notice(session, header) {
      const encoded = cookie(header,NOTICE); if (!encoded) return (header ?? "").split(";").some(part => part.trim().startsWith(`${NOTICE}=`)) ? {clearCookie} : {};
      const result: {notice?:VerifiedProfileNotice;clearCookie:string} = {clearCookie};
      // Notice delivery is optional. The profile route independently requires its
      // own authorization; this catch must not bypass or replace that check.
      let auth: Awaited<ReturnType<typeof authorized>>;
      try { auth = await authorized(session); } catch { return result; }
      if (!auth) return result;
      try {
        if (encoded.length > 4096) return result;
        const parts = encoded.split("."); if (parts.length !== 2) return result;
        const [data, signature] = parts as [string,string]; const expected = mac(data);
        if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature),Buffer.from(expected))) return result;
        const notice = JSON.parse(Buffer.from(data,"base64url").toString("utf8")) as {session:string;actor:string;receipt:string;token:BrowserWriteToken;expires:number};
        const checkedAt = now();
        if (notice.session !== sessionRef(session!) || notice.actor !== auth.actorRef || !Number.isFinite(notice.expires) || notice.expires <= checkedAt || notice.expires > checkedAt+NOTICE_MS) return result;
        const token = parseToken(JSON.stringify(notice.token)); if (!token || !selected(token.field) || token.principalRef !== auth.actorRef) return result;
        const status = await auth.store.receiptStatus(token);
        if (status.status !== "committed" || status.receipt.receiptRef !== notice.receipt || status.receipt.principalRef !== auth.actorRef || status.receipt.personRef !== token.personRef || status.receipt.fields.length !== 1 || status.receipt.fields[0] !== token.field) return result;
        // Cookies are shared across tabs. Confirm only the verified operation, never
        // imply that this receipt belongs to the tab that followed the redirect.
        result.notice = {title:profileCopyText(auth.language ?? "en","editor.noticeTitle"),message:profileCopyText(auth.language ?? "en","editor.noticeMessage")};
        return result;
      } catch { return result; }
    },
  };
}

export async function handleProfileBrowserEdit(request: IncomingMessage,response: ServerResponse,service: ProfileBrowserEdit | undefined,origin: string | undefined,write: (status: number, title: string, body: string, language?: ProfileLanguage) => void): Promise<boolean> {
  const path = new URL(request.url ?? "/","http://gateway.invalid").pathname;
  const match = /^\/profile\/edit\/([A-Za-z]+)(\/(?:save|status))?$/.exec(path);
  if (!match || !selected(match[1]!)) return false;
  const field = match[1], mode = match[2] === "/status" ? "status" : "save";
  // Request-local presentation only. Never infer a locale from untrusted form data.
  let language: ProfileLanguage = "en";
  const resolvedLanguage = (value: ProfileLanguage) => { language = value; };
  const send = (r: ProfileBrowserResult) => {
    response.setHeader("cache-control","no-store"); response.setHeader("referrer-policy","no-referrer"); response.setHeader("x-content-type-options","nosniff");
    if (r.setCookie) response.setHeader("set-cookie",r.setCookie);
    if (r.location) {response.writeHead(r.status,{location:r.location});response.end();} else write(r.status,r.title,r.html,r.language ?? "en");
  };
  try {
    if (!service || !origin) {send(fail(503,"The profile service is unavailable. Please try again."));return true;}
    const session = cookie(request.headers.cookie,"__Host-studenthub_session");
    if (request.method === "GET" && !match[2]) {send(await service.edit(session,field,resolvedLanguage));return true;}
    if (request.method !== "POST" || !match[2]) {send(fail(404,"This page is not available."));return true;}
    if (request.headers.origin !== origin || request.headers["sec-fetch-site"] === "cross-site") {request.resume();send(fail(403,"We could not verify this request."));return true;}
    if (!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "") || Number(request.headers["content-length"]) > LIMIT) {request.resume();send(fail(400,"Invalid request."));return true;}
    const chunks:Buffer[]=[];let size=0;
    for await (const chunk of request.iterator({destroyOnReturn:false})) {const bytes=Buffer.from(chunk);size+=bytes.length;if(size>LIMIT){request.resume();send(fail(400,"Invalid request."));return true;}chunks.push(bytes);}
    const body:Record<string,string>=Object.create(null) as Record<string,string>;
    for (const [key,value] of new URLSearchParams(Buffer.concat(chunks).toString("utf8"))) {if(Object.hasOwn(body,key)){send(fail(400,"Invalid request."));return true;}body[key]=value;}
    send(await service.submit(session,field,body,mode,resolvedLanguage));
  } catch {if(!response.headersSent)send(fail(503,"The profile service is unavailable. Please try again.",language));else response.destroy();}
  return true;
}
