import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readdir, readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import test from "node:test";
import type { GatewayRoute, GatewayRouteContext } from "../src/routes/context.js";
import { createGatewayServer } from "../src/index.js";

const routesModule = process.env.SHU497_ROUTES_MODULE ?? new URL("../src/routes/index.js", import.meta.url).href;
const contextModule = process.env.SHU497_CONTEXT_MODULE ?? new URL("../src/routes/context.js", import.meta.url).href;

test("PREP_ORDER routes retain the exact gateway handler order", async () => {
  const { ROUTES } = await import(routesModule) as typeof import("../src/routes/index.js");
  assert.deepEqual(ROUTES.map((route) => route.name), [
    "catalogue", "candidate-documents", "documents-upload", "documents-actions", "organization-documents", "profile-edit-page", "profile-edit",
    "profile-browser-edit", "language-preference-page", "language-preference", "bank-details",
    "organization-profile", "organization-status", "organization-commercial-terms",
    "organization-approved-to-hire", "organization-notes", "pay-contracts", "organization-brands",
    "organization-stores", "organization-deletion", "organization-creation",
    "organization-account-manager-page", "organization-account-manager", "profile-records", "legacy-link", "civil-id", "area",
  ]);
  assert.equal(ROUTES.length, 27);
  for (const route of ROUTES) assert.equal(typeof route.handle, "function");
});

test("PREP_FIRST_WINS runRoutes short-circuits, preserves context, returns false, and propagates", async () => {
  const { runRoutes } = await import(contextModule) as typeof import("../src/routes/context.js");
  const ctx = {} as GatewayRouteContext;
  const calls: GatewayRouteContext[] = [];
  const route = (name: string, result: boolean): GatewayRoute => ({ name, handle: async (seen) => { calls.push(seen); return result; } });
  assert.equal(await runRoutes([route("one", false), route("two", true), route("three", true)], ctx), true);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((seen) => seen === ctx));
  calls.length = 0;
  assert.equal(await runRoutes([route("one", false), route("two", false)], ctx), false);
  assert.equal(calls.length, 2);
  const failure = new Error("route failure");
  await assert.rejects(runRoutes([{ name: "throw", handle: async () => { throw failure; } }], ctx), (error) => error === failure);
});

test("PREP_LOOP compiled gateway delegates once before built-in routes", async () => {
  const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
  assert.equal((source.match(/runRoutes\(ROUTES,/g) ?? []).length, 1);
  assert.ok(source.indexOf("runRoutes(ROUTES,") < source.indexOf('request.url?.split("?", 1)[0] === "/"'));
  for (const name of [
    "handleCatalogue", "handleCandidateDocuments", "handleOrganizationDocuments", "handleProfileEditPage",
    "handleProfileEdit", "handleProfileBrowserEdit", "handleLanguagePreferencePage", "handleLanguagePreference",
    "handleBankDetails", "handleOrganizationProfile", "handleOrganizationStatus", "handleOrganizationCommercialTerms",
    "handleOrganizationApprovedToHire", "handleOrganizationNotes", "handlePayContracts", "handleOrganizationBrands",
    "handleOrganizationStores", "handleOrganizationDeletion", "handleOrganizationCreation",
    "handleOrganizationAccountManagerPage", "handleOrganizationAccountManager", "handleProfileRecords",
  ]) {
    assert.doesNotMatch(source, new RegExp(`\\b${name}\\b`));
  }
  assert.ok((source.match(/login as /g) ?? []).length <= 1);
  const routesDirectory = new URL("../src/routes/", import.meta.url);
  for (const file of await readdir(routesDirectory)) {
    if (file.endsWith(".js")) assert.doesNotMatch(await readFile(new URL(file, routesDirectory), "utf8"), /login as /);
  }
});

type Golden = {
  readonly name: string; readonly path: string; readonly method?: string; readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string; readonly status: number; readonly contentType: string | null; readonly location: string | null;
  readonly setCookie: string | null; readonly bodySha256: string; readonly calls: number;
};

const SESSION = "s".repeat(43);
const JSON_HEADERS = { "content-type": "application/json" };
const golden = (request: Pick<Golden, "name" | "path" | "method" | "headers" | "body">,
  status: number, bodySha256: string, calls: number): Golden => ({ ...request, status,
    contentType: "application/json", location: null, setCookie: null, bodySha256, calls });

// Recorded on the unmodified a6e2735 gateway. These rows deliberately cover every one of the six
// route files, including unauthenticated and cross-origin refusals, and pin service-call cardinality.
const GOLDEN: readonly Golden[] = [
  golden({ name: "catalogue unavailable", path: "/catalogue/bank", method: "GET" }, 503, "8a0099b516eff9e3a6ba93f411c07145ebff9763a1ccee0b0aa8e8f3cea99223", 0),
  golden({ name: "catalogue no session", path: "/catalogue/bank", method: "POST", headers: JSON_HEADERS, body: "{}" }, 401, "f6c54549eb3bc273614d8f00deb076908bb256103d32490e4ab8bce8261b9de8", 0),
  golden({ name: "candidate list", path: "/candidate-documents", method: "GET" }, 200, "f332a4181af7c4a82f09927e71369910957b21632a21eb990216dbd59c728dd3", 2),
  golden({ name: "candidate cross origin", path: "/candidate-documents/uploads", method: "POST", headers: { ...JSON_HEADERS, origin: "https://evil.invalid" }, body: "{}" }, 403, "ad2108b94373d55034905f6b8c47981deba9b28c6913ad98af821166727a3859", 1),
  golden({ name: "organization documents unavailable", path: "/organization-documents/upload", method: "POST", headers: JSON_HEADERS, body: "{}" }, 503, "a1a6c296f5ac79c18cb90eb6125de374e4238319ca1e1d295fec10d6c9794f54", 0),
  golden({ name: "organization documents unknown", path: "/organization-documents/unknown", method: "GET" }, 503, "a1a6c296f5ac79c18cb90eb6125de374e4238319ca1e1d295fec10d6c9794f54", 0),
  golden({ name: "language cross origin", path: "/profile/language/preview", method: "POST", headers: { ...JSON_HEADERS, origin: "https://evil.invalid" }, body: "{}" }, 403, "2edf7a53b7f57498ee2e3cf0d15d9f10d39053f4703b7e283a1124ac0193febb", 0),
  golden({ name: "bank details cross origin", path: "/candidate/bank-details/preview", method: "POST", headers: { ...JSON_HEADERS, origin: "https://evil.invalid" }, body: "{}" }, 403, "2edf7a53b7f57498ee2e3cf0d15d9f10d39053f4703b7e283a1124ac0193febb", 0),
  golden({ name: "organization profile receipt", path: `/organization/profile/org/receipts/${"0".repeat(64)}`, method: "GET", headers: { cookie: `__Host-studenthub_session=${SESSION}` } }, 401, "782eeaa7f1915f6783146f8180751785584f0f24bd4e503165c7fc4a597da600", 1),
  golden({ name: "account manager read", path: "/organization/account-manager/org", method: "GET", headers: { cookie: `__Host-studenthub_session=${SESSION}` } }, 401, "782eeaa7f1915f6783146f8180751785584f0f24bd4e503165c7fc4a597da600", 1),
  golden({ name: "pay contracts mine", path: "/pay-contracts/mine", method: "GET", headers: { cookie: `__Host-studenthub_session=${SESSION}` } }, 401, "782eeaa7f1915f6783146f8180751785584f0f24bd4e503165c7fc4a597da600", 1),
  golden({ name: "profile records unavailable", path: "/profile/records", method: "GET" }, 503, "1f6859950d100afe7d86bcff2981f2a40aa594b3b816429e5581c7a81c81a817", 0),
  { ...golden({ name: "profile edit page no session", path: "/profile/edit/preview", method: "POST", headers: { accept: "text/html", "content-type": "application/x-www-form-urlencoded" }, body: "field=phone&value=1" }, 403, "fa6812196d760afe7144fb31d4ea117f169f96fe86a861a9d6eb80e108040223", 0), contentType: "text/html; charset=utf-8" },
  { ...golden({ name: "language page no session", path: "/profile/language/preview", method: "POST", headers: { accept: "text/html", "content-type": "application/x-www-form-urlencoded" }, body: "language=en" }, 403, "91ac4e1a613a68736aa51da03bc58a151a91155cdcd2451e722dc0868a23b6ec", 0), contentType: "text/html; charset=utf-8" },
  { ...golden({ name: "account manager page no session", path: "/workspace/account-manager/preview", method: "POST", headers: { accept: "text/html", "content-type": "application/x-www-form-urlencoded" }, body: "orgId=org&field=account_manager&value=staff" }, 403, "da6c2dba740380f2e5997b0bfae8f5df5dd2f07f413254a32550ae733dd8b030", 0), contentType: "text/html; charset=utf-8" },
];

test("PREP_SAME route extraction preserves response bytes, headers, and service call counts", async () => {
  assert.ok(GOLDEN.length >= 12);
  for (const row of GOLDEN) {
    let calls = 0;
    const result = { status: 401 as const, body: { error: "unauthorized" } };
    const service = new Proxy({}, { get: (_target, key) => key === "options" ? { origin: "http://127.0.0.1" } : async () => { calls += 1; return result; } });
    const login = {
      start: async () => result, callback: async () => result, profile: async () => result, logout: async () => result,
      web: { origin: "http://127.0.0.1", returnTo: "http://127.0.0.1/", profiles: service },
      profileEdit: service, browserEdit: service, preferences: service, bankDetails: service,
      organizationProfile: service, organizationStatus: service, organizationCommercialTerms: service,
      organizationApprovedToHire: service, organizationNotes: service, payContracts: service,
      organizationBrands: service, organizationStores: service, organizationDeletion: service,
      organizationCreation: service, organizationAccountManager: service,
    } as never;
    const candidate = new Proxy({ options: { origin: "http://127.0.0.1" } }, { get: (target, key) => key === "options" ? target.options : async () => { calls += 1; return key === "list" ? [] : "person"; } }) as never;
    const server = createGatewayServer(undefined, undefined, undefined, login, null, undefined, candidate);
    const request = Readable.from(row.body ? [row.body] : []) as Readable & { method?: string; url?: string; headers: Record<string, string> };
    request.method = row.method; request.url = row.path; request.headers = { ...(row.headers ?? {}) };
    const response = new EventEmitter() as EventEmitter & {
      statusCode: number; headersSent: boolean; writableFinished: boolean; headers: Map<string, string>; chunks: string[];
      setHeader(name: string, value: unknown): void; writeHead(status: number, headers?: Record<string, unknown>): void; end(value?: unknown): void;
    };
    response.statusCode = 200; response.headersSent = false; response.writableFinished = false;
    response.headers = new Map(); response.chunks = [];
    response.setHeader = (name, value) => { response.headers.set(name.toLowerCase(), String(value)); };
    response.writeHead = (status, headers = {}) => { response.statusCode = status; response.headersSent = true; for (const [name, value] of Object.entries(headers)) response.setHeader(name, value); };
    const finished = new Promise<void>((resolve) => response.once("finish", resolve));
    response.end = (value) => { if (value !== undefined) response.chunks.push(String(value)); response.writableFinished = true; response.emit("finish"); };
    server.emit("request", request, response);
    await finished;
    const body = response.chunks.join("");
    const actual = {
      status: response.statusCode, contentType: response.headers.get("content-type") ?? null, location: response.headers.get("location") ?? null,
      setCookie: response.headers.get("set-cookie") ?? null, bodySha256: createHash("sha256").update(body).digest("hex"), calls,
    };
    assert.deepEqual(actual, {
      status: row.status, contentType: row.contentType, location: row.location,
      setCookie: row.setCookie, bodySha256: row.bodySha256, calls: row.calls,
    }, row.name);
  }
});
