import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { createGatewayServer, createLoginApplication } from "../src/index.js";
import { createSyntheticLoginRig } from "@studenthub/login-contract";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CommitInput, Receipt, SafeWriteStore } from "@studenthub/safe-write-contract";
import { bankDetailsRecordRef, bankDetailsValue, InMemoryFinanceReferenceResolver } from "@studenthub/pay-contracts";
import { principalAuditRef } from "@studenthub/db/access";
import { createBankDetails, handleBankDetailsPage, type BankDetailsService } from "../src/bank-details.js";

// C-15: the candidate's own bank details page. Synthetic fixtures only: a made-up person,
// banks and checksum-valid test IBANs.
const ORIGIN = "https://studenthub.example.invalid";
const SESSION = "c".repeat(43);
const PERSON = "candidate-person";
const SECRET = "c15-bank-details-page-secret-at-least-32-bytes";
const BANK = "3333abcd-3333-4333-8333-33333333abcd";
const OTHER_BANK = "4444abcd-4444-4444-8444-44444444abcd";
const IBAN = "KW81CBKU0000000000001234560101";
const NEW_IBAN = IBAN;
const CHOICES = [{ id: BANK, name: "Synthetic Bank <One>" }, { id: OTHER_BANK, name: "Second Synthetic Bank" }];

function rig(options: { candidate?: boolean; stored?: string | null } = {}) {
  let value: string | null = options.stored ?? null;
  const receipts = new Map<string, Receipt>();
  const banks = new InMemoryFinanceReferenceResolver();
  banks.set("bank", BANK);
  banks.set("bank", OTHER_BANK);
  const store = {
    forPrincipal(principalId: string): SafeWriteStore {
      return {
        ownedRecord: (ref) => options.candidate !== false && principalId === PERSON && ref === principalAuditRef(PERSON)
          ? bankDetailsRecordRef(PERSON) : null,
        readField: () => value,
        commit: (input: CommitInput) => {
          if (value !== input.expectedBefore) return { ok: false, reason: "state_changed" };
          value = input.value;
          receipts.set(input.receipt.receiptRef, input.receipt);
          return { ok: true };
        },
      };
    },
    readReceipt: async (principalId: string, ref: string) => principalId === PERSON ? receipts.get(ref) ?? null : null,
  };
  const sessions = { get: async (id: string) => id === SESSION ? { id: SESSION, personId: PERSON } : undefined };
  const service = createBankDetails({ sessions: sessions as never, store, banks, secret: SECRET, choices: async () => CHOICES });
  return { service, value: () => value, set: (next: string | null) => { value = next; } };
}

interface Page { readonly handled: boolean; readonly status: number; readonly title: string; readonly html: string; readonly headers: Record<string, string>; readonly raw: string }

async function call(service: BankDetailsService | undefined, path: string, form: string | Record<string, string> | undefined, overrides: {
  method?: string; origin?: string; contentType?: string; cookie?: string | null; accept?: string; site?: string;
} = {}): Promise<Page> {
  const raw = form === undefined ? "" : typeof form === "string" ? form : new URLSearchParams(form).toString();
  const method = overrides.method ?? (form === undefined ? "GET" : "POST");
  const req = Readable.from(method === "GET" ? [] : [raw]) as IncomingMessage;
  req.url = path;
  req.method = method;
  req.headers = {
    origin: overrides.origin ?? ORIGIN,
    accept: overrides.accept ?? "text/html",
    "content-type": overrides.contentType ?? "application/x-www-form-urlencoded",
    ...(overrides.site ? { "sec-fetch-site": overrides.site } : {}),
    ...(overrides.cookie === null ? {} : { cookie: overrides.cookie ?? `__Host-studenthub_session=${SESSION}` }),
  };
  let status = 0, title = "", html = "", body = "";
  let headers: Record<string, string> = {};
  const fake = {
    headersSent: false,
    writeHead(code: number, next: Record<string, string>) { status = code; headers = next; fake.headersSent = true; return fake; },
    setHeader() { return fake; },
    end(chunk?: string) { body = chunk ?? ""; return fake; },
    destroy() { return fake; },
  };
  const handled = await handleBankDetailsPage(req, fake as unknown as ServerResponse, service, ORIGIN,
    (code, pageTitle, content) => { status = code; title = pageTitle; html = content; });
  return { handled, status, title, html, headers, raw: body };
}

const hiddenFields = (html: string) => Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)]
  .map(([, name, value]) => [name!, value!.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")]));
const stored = (iban = IBAN) => bankDetailsValue({ bankId: BANK, iban, beneficiaryName: "Synthetic Person" });
const MASKED = "KW81••••••••••••••••••••••0101";

test("C15_BANK_PAGE shows the person's own details masked, never the full IBAN, with a change form", async () => {
  const x = rig({ stored: stored() });
  const page = await call(x.service, "/profile/bank", undefined);
  assert.equal(page.handled, true);
  assert.equal(page.status, 200);
  assert.equal(page.title, "Bank details");
  assert.ok(page.html.includes(MASKED), "masked IBAN shown");
  assert.equal(page.html.includes(IBAN), false, "full IBAN never on the page");
  assert.equal(page.html.includes("0000000000001234"), false, "no middle digits");
  assert.ok(page.html.includes("Synthetic Bank &lt;One&gt;"), "bank name, escaped");
  assert.equal(page.html.includes("<One>"), false);
  assert.ok(page.html.includes("Synthetic Person"));
  assert.match(page.html, /<form method="post" action="\/profile\/bank\/review" novalidate>/);
  assert.match(page.html, /<input name="iban" required autocomplete="off"[^>]*>/);
  assert.equal(/name="iban"[^>]*value=/.test(page.html), false, "the IBAN field starts empty");
  assert.ok(page.html.includes('<option value="4444abcd-4444-4444-8444-44444444abcd">Second Synthetic Bank</option>'));
  assert.equal(page.html.includes("were saved"), false);

  const none = await call(rig().service, "/profile/bank", undefined);
  assert.equal(none.status, 200);
  assert.ok(none.html.includes("You haven’t added bank details yet."));
  assert.ok(none.html.includes("<h2>Add your bank details</h2>"));
});

test("C15_BANK_PAGE_FLOW review shows before and after masked, confirm saves through the checked write, then the page says so", async () => {
  const x = rig({ stored: stored() });
  const review = await call(x.service, "/profile/bank/review", { bankId: OTHER_BANK.toUpperCase(), iban: "kw81 cbku 0000 0000 0000 1234 5601 01", beneficiaryName: "  Synthetic   Person Two " });
  assert.equal(review.status, 200, review.html);
  assert.equal(review.title, "Review bank details");
  assert.match(review.html, /<h2>Now<\/h2><dl class="profile-facts"><dt>Bank<\/dt><dd>Synthetic Bank &lt;One&gt;<\/dd><dt>IBAN<\/dt><dd><span class="masked">KW81•+0101<\/span>/);
  assert.match(review.html, /<h2>After the change<\/h2><dl class="profile-facts"><dt>Bank<\/dt><dd>Second Synthetic Bank<\/dd><dt>IBAN<\/dt><dd><span class="masked">KW81•+0101<\/span><\/dd><dt>Account holder<\/dt><dd>Synthetic Person Two<\/dd>/);
  assert.equal(x.value(), stored(), "a review changes nothing");
  const hidden = hiddenFields(review.html);
  assert.deepEqual(Object.keys(hidden).sort(), ["bankId", "beneficiaryName", "iban", "token.changeSetDigest", "token.expectedBeforeDigest",
    "token.expiresAt", "token.issuedAt", "token.mac", "token.principalRef", "token.tokenId"]);
  // The only full IBAN on the review page is the person's own entry, carried to confirm in a hidden field.
  assert.equal(review.html.replace(/<input type="hidden"[^>]*>/g, "").includes("1234"), false, "nothing but the masked IBAN is shown");

  const confirm = await call(x.service, "/profile/bank/confirm", hidden);
  assert.equal(confirm.status, 303);
  assert.match(confirm.headers.location ?? "", /^\/profile\/bank\?saved=[0-9a-f]{64}$/);
  assert.equal(confirm.headers["cache-control"], "no-store");
  assert.equal(x.value(), bankDetailsValue({ bankId: OTHER_BANK, iban: NEW_IBAN, beneficiaryName: "Synthetic Person Two" }));

  const after = await call(x.service, confirm.headers.location!, undefined);
  assert.ok(after.html.includes('<p class="notice" role="status">Your bank details were saved.</p>'));
  // A synthetic reread: a fresh service over the same stored row shows the saved details, masked.
  const reread = await call(rig({ stored: x.value() }).service, "/profile/bank", undefined);
  assert.match(reread.html, /<dt>Bank<\/dt><dd>Second Synthetic Bank<\/dd><dt>IBAN<\/dt><dd><span class="masked">KW81•+0101<\/span><\/dd><dt>Account holder<\/dt><dd>Synthetic Person Two<\/dd>/);
  assert.equal(reread.html.includes(IBAN), false);
  assert.equal(reread.html.includes("were saved"), false, "a plain reread claims no save");
  const replay = await call(x.service, "/profile/bank/confirm", hidden);
  assert.equal(replay.status, 409, "a used token is refused");
  assert.ok(replay.html.includes("Your bank details weren’t changed."));
});

test("C15_BANK_PAGE_INPUT a refused entry keeps the bank and name, never writes the IBAN back, and saves nothing", async () => {
  const x = rig();
  for (const [form, message] of [
    [{ bankId: BANK, iban: "KW00NOTANIBAN", beneficiaryName: "Synthetic Person" }, "Enter a valid IBAN."],
    [{ bankId: "not-a-bank", iban: IBAN, beneficiaryName: "Synthetic Person" }, "Choose your bank from the list."],
    [{ bankId: "9999abcd-9999-4999-8999-99999999abcd", iban: IBAN, beneficiaryName: "Synthetic Person" }, "Choose your bank from the list."],
    [{ bankId: BANK, iban: IBAN, beneficiaryName: "x" }, "Enter the account holder's name"],
  ] as const) {
    const page = await call(x.service, "/profile/bank/review", form);
    assert.equal(page.status, 400, JSON.stringify(form));
    assert.ok(page.html.includes(`role="alert">${message.replace("'", "&#39;")}`), page.html);
    assert.match(page.html, /aria-invalid="true"/);
    assert.equal(page.html.includes(form.iban), false, "the IBAN is not echoed");
    assert.equal(/name="iban"[^>]*value=/.test(page.html), false);
    assert.ok(page.html.includes(`value="${form.beneficiaryName}"`), "the name is kept");
  }
  const kept = await call(x.service, "/profile/bank/review", { bankId: BANK, iban: "bad", beneficiaryName: "<b>Synthetic</b>" });
  assert.ok(kept.html.includes('value="&lt;b&gt;Synthetic&lt;/b&gt;"'), "kept name is escaped");
  assert.ok(kept.html.includes(`<option value="${BANK}" selected>`), "kept bank is selected");
  assert.equal(x.value(), null);
});

test("C15_BANK_PAGE_HIDDEN signed out is the signed-out page; someone without a bank record gets the shared not-found answer", async () => {
  const x = rig({ stored: stored() });
  const signedOut = await call(x.service, "/profile/bank", undefined, { cookie: null });
  assert.equal(signedOut.status, 401);
  assert.equal(signedOut.html, "", "the route renders the shared signed-out page");

  const staff = rig({ candidate: false, stored: stored() });
  const unknown = await call(staff.service, "/no/such/page", undefined);
  assert.equal(unknown.handled, false);
  const wildcard = await call(undefined, "/profile/bank", undefined);
  for (const page of [
    await call(staff.service, "/profile/bank", undefined),
    await call(staff.service, "/profile/bank/review", { bankId: BANK, iban: IBAN, beneficiaryName: "Synthetic Person" }),
    // Ownership is checked before any correction form: a non-owner never sees one.
    await call(staff.service, "/profile/bank/review", { bankId: BANK, iban: "not an iban", beneficiaryName: "Synthetic Person" }),
    await call(staff.service, "/profile/bank/review", { bankId: "", iban: "", beneficiaryName: "" }),
    wildcard,
  ]) {
    assert.equal(page.status, 404);
    assert.equal(page.title, "", "not a bank page");
    assert.equal(page.raw, wildcard.raw, "byte-identical to the shared not-found page");
    assert.equal(page.raw.includes("Synthetic Person"), false);
    assert.equal(page.raw.includes(MASKED), false);
  }
  const json = await call(staff.service, "/profile/bank", undefined, { accept: "application/json" });
  assert.equal(json.status, 404);
  assert.equal(json.raw, '{"ok":false,"error":"not_found"}');
  assert.equal(staff.value(), stored(), "nothing changed");
});

test("C15_BANK_PAGE_BOUNDARY origin, method, form shape and token binding are enforced; only page paths are taken", async () => {
  const x = rig();
  const form = { bankId: BANK, iban: IBAN, beneficiaryName: "Synthetic Person" };
  assert.equal((await call(x.service, "/profile/bank/review", form, { origin: "https://evil.example.invalid" })).status, 403);
  assert.equal((await call(x.service, "/profile/bank/review", form, { site: "cross-site" })).status, 403);
  assert.equal((await call(x.service, "/profile/bank/review", JSON.stringify(form), { contentType: "application/json" })).status, 400);
  assert.equal((await call(x.service, "/profile/bank/review", `${new URLSearchParams(form)}&iban=${IBAN}`)).status, 400, "duplicate key");
  assert.equal((await call(x.service, "/profile/bank/review", { ...form, extra: "1" })).status, 400, "extra key");
  assert.equal((await call(x.service, "/profile/bank/review", { bankId: BANK, iban: IBAN })).status, 400, "missing key");
  assert.equal((await call(x.service, "/profile/bank/review", undefined, { method: "GET" })).status, 404);
  assert.equal((await call(x.service, "/profile/bank", form, { method: "POST" })).status, 404);
  assert.equal((await call(x.service, "/profile/bank/review", form, { cookie: null })).status, 401);
  assert.equal((await call(undefined, "/profile/bank/review", form)).status, 503);
  for (const path of ["/candidate/bank-details/preview", "/candidate/bank-details/confirm", "/profile/banking", "/profile/bank/"]) {
    assert.equal((await call(x.service, path, form)).handled, false, path);
  }

  const review = await call(x.service, "/profile/bank/review", form);
  const hidden = hiddenFields(review.html);
  const tampered = await call(x.service, "/profile/bank/confirm", { ...hidden, iban: "KW81CBKU0000000000001234569999" });
  assert.notEqual(tampered.status, 303, "a changed IBAN does not match the reviewed token");
  assert.equal((await call(x.service, "/profile/bank/confirm", { ...hidden, "token.mac": "x" })).status, 409);
  const { ["token.tokenId"]: _dropped, ...missing } = hidden;
  assert.equal((await call(x.service, "/profile/bank/confirm", missing)).status, 400);
  assert.equal((await call(x.service, "/profile/bank/confirm", hidden, { origin: "https://evil.example.invalid" })).status, 403);
  assert.equal(x.value(), null, "nothing saved by any refused confirm");
  assert.equal((await call(x.service, "/profile/bank/confirm", hidden)).status, 303);
  assert.equal(x.value(), stored());
});

test("C15_BANK_PAGE_QUIET a failing dependency answers 503 and nothing is logged on any path", async () => {
  const x = rig({ stored: stored() });
  const logged: unknown[] = [];
  const original = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const key of Object.keys(original) as (keyof typeof original)[]) console[key] = (...args: unknown[]) => { logged.push(args); };
  try {
    const review = await call(x.service, "/profile/bank/review", { bankId: BANK, iban: IBAN, beneficiaryName: "Synthetic Person" });
    await call(x.service, "/profile/bank/confirm", hiddenFields(review.html));
    await call(x.service, "/profile/bank", undefined);
    const broken = { ...x.service, current: async () => { throw new Error(`database said ${IBAN}`); } } as BankDetailsService;
    const failed = await call(broken, "/profile/bank", undefined);
    assert.equal(failed.status, 503);
    assert.equal(failed.html.includes(IBAN), false);
    assert.equal(failed.html.includes("database"), false);
    const noChoices = { ...x.service, bankChoices: async () => { throw new Error("catalogue down"); } } as BankDetailsService;
    assert.equal((await call(noChoices, "/profile/bank", undefined)).status, 503);
    // A 503 at confirm can follow a committed write (the receipt step failed): the page never says nothing changed.
    const receiptFailed = { ...x.service, confirm: async () => ({ status: 503 as const, body: { error: "receipt_failed" } }) } as BankDetailsService;
    const again = await call(x.service, "/profile/bank/review", { bankId: OTHER_BANK, iban: IBAN, beneficiaryName: "Synthetic Person" });
    const unsure = await call(receiptFailed, "/profile/bank/confirm", hiddenFields(again.html));
    assert.equal(unsure.status, 503);
    assert.equal(unsure.html.includes("weren’t changed"), false, "C15_BANK_PAGE_QUIET a 503 never claims nothing changed");
    assert.ok(unsure.html.includes("<h1>We couldn’t finish this right now.</h1><p>If you were saving a change, it may have gone through. Open your bank details to see what is saved now before you try again.</p><a class=\"button primary\" href=\"/profile/bank\">Open bank details</a>"), unsure.html);
  } finally {
    Object.assign(console, original);
  }
  assert.deepEqual(logged, []);
});

test("C15_BANK_PAGE_GATEWAY the gateway serves the page, the review and the save; the JSON API stays as it was", async (t) => {
  const x = rig({ stored: stored() });
  const login = createSyntheticLoginRig(createLoginApplication);
  const originHolder = { value: "" };
  const app = { ...login.app, bankDetails: x.service, web: { get origin() { return originHolder.value; }, profiles: {} } };
  const server = createGatewayServer(undefined, undefined, undefined, app as never);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  originHolder.value = `http://127.0.0.1:${address.port}`;
  const cookie = `__Host-studenthub_session=${SESSION}`;
  const page = await fetch(`${originHolder.value}/profile/bank`, { headers: { cookie, accept: "text/html" } });
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(html, /<title>[^<]*Bank details/);
  assert.ok(html.includes(MASKED) && !html.includes(IBAN));
  const headers = { cookie, accept: "text/html", origin: originHolder.value, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" };
  const review = await (await fetch(`${originHolder.value}/profile/bank/review`, { method: "POST", headers,
    body: new URLSearchParams({ bankId: OTHER_BANK, iban: IBAN, beneficiaryName: "Synthetic Person" }) })).text();
  const done = await fetch(`${originHolder.value}/profile/bank/confirm`, { method: "POST", headers, body: new URLSearchParams(hiddenFields(review)), redirect: "manual" });
  assert.equal(done.status, 303);
  assert.match(done.headers.get("location") ?? "", /^\/profile\/bank\?saved=[0-9a-f]{64}$/);
  const shown = await (await fetch(`${originHolder.value}${done.headers.get("location")}`, { headers: { cookie, accept: "text/html" } })).text();
  assert.ok(shown.includes("Your bank details were saved.") && shown.includes("Second Synthetic Bank"));
  assert.equal(x.value(), bankDetailsValue({ bankId: OTHER_BANK, iban: IBAN, beneficiaryName: "Synthetic Person" }));
  const signedOut = await fetch(`${originHolder.value}/profile/bank`, { headers: { accept: "text/html" } });
  assert.equal(signedOut.status, 401);
  assert.match(await signedOut.text(), /Sign in/);
  const api = await fetch(`${originHolder.value}/candidate/bank-details/preview`, { method: "POST",
    headers: { cookie, origin: originHolder.value, "content-type": "application/json" },
    body: JSON.stringify({ bankId: BANK, iban: IBAN, beneficiaryName: "Synthetic Person" }) });
  assert.equal(api.status, 200);
  assert.equal(((await api.json()) as { after: { ibanMasked: string } }).after.ibanMasked, MASKED);
});

test("C15_BANK_PAGE_FORMS empty and partial forms name every missing part, invalid ones say what to fix, and nothing claims a save", async () => {
  const x = rig({ stored: stored() });
  const empty = await call(x.service, "/profile/bank/review", { bankId: "", iban: "", beneficiaryName: "" });
  assert.equal(empty.status, 400);
  assert.ok(empty.html.includes('<div id="bank-error" class="form-error" role="alert"><p>Your bank details weren’t saved yet:</p><ul><li>Choose your bank.</li><li>Enter your IBAN.</li><li>Enter the account holder&#39;s name.</li></ul></div>'), empty.html);
  for (const [form, expected] of [
    [{ bankId: BANK, iban: "", beneficiaryName: "" }, ["Enter your IBAN.", "Enter the account holder&#39;s name."]],
    [{ bankId: "", iban: "KW81 CBKU 0000 0000 0000 1234 5601 01", beneficiaryName: "Synthetic Person" }, ["Choose your bank."]],
    [{ bankId: BANK, iban: "   ", beneficiaryName: "Synthetic Person" }, ["Enter your IBAN."]],
  ] as const) {
    const page = await call(x.service, "/profile/bank/review", form);
    assert.equal(page.status, 400, JSON.stringify(form));
    for (const message of expected) assert.ok(page.html.includes(message), `${message} in ${page.html}`);
    assert.equal(/name="iban"[^>]*value=/.test(page.html), false, "the IBAN is not echoed");
    assert.equal(page.html.includes("1234"), false, "no part of a typed IBAN comes back");
    assert.equal(page.html.includes("were saved"), false);
  }
  // Invalid entries get one message saying what to fix (C15_BANK_PAGE_INPUT covers each kind).
  const invalid = await call(x.service, "/profile/bank/review", { bankId: BANK, iban: "KW81CBKU0000000000001234569999", beneficiaryName: "Synthetic Person" });
  assert.ok(invalid.html.includes('role="alert">Enter a valid IBAN.'));
  assert.equal(invalid.html.includes("9999"), false);
  assert.equal(x.value(), stored(), "nothing saved by any refused form");

  // The saved notice needs this person's own receipt, not a hand-typed link.
  for (const path of ["/profile/bank?saved", `/profile/bank?saved=${"a".repeat(64)}`, "/profile/bank?saved=x", `/profile/bank?saved=${"a".repeat(64)}&x=1`]) {
    const page = await call(x.service, path, undefined);
    assert.equal(page.status, 200, path);
    assert.equal(page.html.includes("were saved"), false, path);
  }
  const review = await call(x.service, "/profile/bank/review", { bankId: OTHER_BANK, iban: IBAN, beneficiaryName: "Synthetic Person" });
  const done = await call(x.service, "/profile/bank/confirm", hiddenFields(review.html));
  const other = rig({ stored: stored() });
  assert.equal((await call(other.service, done.headers.location!, undefined)).html.includes("were saved"), false, "another store's receipt is not this one's");
  assert.equal((await call(x.service, done.headers.location!, undefined, { cookie: null })).status, 401);
});
