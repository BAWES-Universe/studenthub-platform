/**
 * A gateway serving My profile through the production composition, for tests.
 *
 * wireProfile (src/wiring/profile.ts) builds the civil ID service and the
 * merged My profile read over Postgres stores, which a test sandbox cannot
 * reach. This helper builds the same pieces over in-memory stores: the civil
 * ID service from createCivilId with a vault opened from REAL_PROFILE_CIVIL_KEY
 * (a canonical base64 CIVIL_ID_ENCRYPTION_KEY value), and the My profile read
 * from composeOwnProfiles, the function wireProfile itself calls. Requests go
 * through createGatewayServer with a real session cookie, so a test sees what a
 * browser sees.
 *
 * New tests that need My profile or a civil ID route import this helper
 * instead of passing a hand-built login to createGatewayServer. A card that
 * needs another service on the login (for example a new route's handler)
 * passes it through `extend`, which receives the services built here.
 */
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { InMemoryAuthzStore, createPrincipal } from "@studenthub/contracts";
import { createSyntheticLoginRig } from "@studenthub/login-contract";
import {
  CivilIdVault,
  InMemoryApprovedProfileAdapter,
  InMemoryCivilIdStore,
  InMemoryLocationStore,
  SYNTHETIC_PROFILE_FIXTURES,
  createArea,
  createCivilId,
} from "@studenthub/profile";
import { createGatewayServer, createLoginApplication } from "../../src/index.js";
import type { BrowserLoginApplication } from "../../src/web-ui.js";
import type { CandidateDocuments } from "../../../../packages/private-documents/src/candidate-lifecycle.js";
import type { CivilIdReviewStore } from "@studenthub/profile";
import { composeOwnProfiles } from "../../src/wiring/profile.js";

export const REAL_PROFILE_ORIGIN = "https://studenthub.test.invalid";
export const REAL_PROFILE_PERSON = "person-1";
export const REAL_PROFILE_OTHER_PERSON = "person-2";
export const REAL_PROFILE_SESSION = "s".repeat(43);
export const REAL_PROFILE_OTHER_SESSION = "t".repeat(43);
/** The CIVIL_ID_ENCRYPTION_KEY value the helper's vault is opened with. */
export const REAL_PROFILE_CIVIL_KEY = Buffer.alloc(32, 9).toString("base64");

export type RealProfileServices = {
  readonly civilId: ReturnType<typeof createCivilId>;
  readonly civilStore: InMemoryCivilIdStore;
  readonly vault: CivilIdVault;
  readonly profiles: ReturnType<typeof composeOwnProfiles>;
  readonly now: () => Date;
};

export type RealProfileServerOptions = {
  /** The approved profile row for person-1; defaults to the populated fixture with English as its language. */
  readonly row?: unknown;
  /** The clock the civil ID service reads; defaults to 2026-11-12T09:00:00Z. */
  readonly now?: () => Date;
  /** The date My profile derives ages and expiry from; defaults to now() in Asia/Kuwait. */
  readonly today?: () => string;
  /** The countries the completeness check reads, as wireProfile's personProfiles.readOriginChoices() returns them. */
  readonly countries?: readonly { readonly id: string; readonly code: string | null }[];
  /** Extra services on the login application, built from the helper's own. */
  readonly extend?: (services: RealProfileServices) => Partial<BrowserLoginApplication>;
  readonly civilIdReview?: (services: RealProfileServices) => { store: CivilIdReviewStore; isStaff?(principalId: string): Promise<boolean>; reading?(principalId:string):Promise<{state:string;last4?:string|null;expiry?:string|null}|null>; secret?:Buffer };
  readonly documents?: CandidateDocuments;
  readonly staff?: readonly string[];
};

const kuwaitDate = (now: Date): string => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuwait", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

export async function startRealProfileServer(t: TestContext, options: RealProfileServerOptions = {}) {
  const key = Buffer.from(REAL_PROFILE_CIVIL_KEY, "base64");
  assert.equal(key.length, 32);
  const now = options.now ?? (() => new Date("2026-11-12T09:00:00.000Z"));
  const rig = createSyntheticLoginRig(createLoginApplication);
  await rig.sessions.put({ id: REAL_PROFILE_SESSION, personId: REAL_PROFILE_PERSON });
  await rig.sessions.put({ id: REAL_PROFILE_OTHER_SESSION, personId: REAL_PROFILE_OTHER_PERSON });
  const authz = new InMemoryAuthzStore({ principals: [
    createPrincipal({ id: REAL_PROFILE_PERSON, pbuuids: ["pbuuid-1"], displayName: "Registry Name", email: "registry@example.invalid" }),
    createPrincipal({ id: REAL_PROFILE_OTHER_PERSON, pbuuids: ["pbuuid-2"] }),
  ], organizations: [{id:"root",name:"StudentHub"}] });
  await authz.grantMany(REAL_PROFILE_PERSON, [{ orgId: `candidate:${REAL_PROFILE_PERSON}`, role: "candidate", scope: "self" }]);
  for (const principalId of options.staff ?? []) await authz.grantMany(principalId, [{orgId:"root",role:"staff",scope:"subtree"}]);
  const rows = new Map<string, unknown>([
    ["candidate-1", options.row ?? { ...SYNTHETIC_PROFILE_FIXTURES.populated, candidate_language_pref: "en" }],
    ["candidate-2", { ...SYNTHETIC_PROFILE_FIXTURES.partial, candidate_id: 232, candidate_name: "Other Person" }],
  ]);
  const source = new InMemoryApprovedProfileAdapter({
    links: [
      { principalId: REAL_PROFILE_PERSON, candidateRef: "candidate-1" },
      { principalId: REAL_PROFILE_OTHER_PERSON, candidateRef: "candidate-2" },
    ],
    rows,
  });
  const civilStore = new InMemoryCivilIdStore();
  const vault = new CivilIdVault(key);
  const civilId = createCivilId({ store: civilStore, vault, clock: { now } });
  const area = createArea({ store: new InMemoryLocationStore() });
  // Every civil read, from the My profile render or a civil ID route, is counted.
  const counts = { profileReads: 0, civilReads: 0 };
  const countedCivil = { ...civilId, async readOwn(id: string) { counts.civilReads++; return civilId.readOwn(id); } } as typeof civilId;
  const profiles = composeOwnProfiles({ principals: authz, source, civilId: countedCivil, area, today: options.today ?? (() => kuwaitDate(now())) });
  const countedProfiles = { async readOwn(request: Parameters<typeof profiles.readOwn>[0]) { counts.profileReads++; return profiles.readOwn(request); } };
  const services: RealProfileServices = { civilId, civilStore, vault, profiles, now };
  const review = options.civilIdReview?.(services);
  const login: BrowserLoginApplication = {
    ...rig.app,
    civilId: countedCivil,
    // As wireProfile: the area service with the session store and origin.
    area: { area, sessions: rig.sessions, origin: REAL_PROFILE_ORIGIN },
    ...(options.extend?.(services) ?? {}),
    ...(review ? { civilIdReview: { ...review, vault, now, isStaff: review.isStaff ?? (async id => (await authz.listGrantsForPrincipal(id)).some(g => (g.role==="staff"||g.role==="admin")&&g.scope==="subtree"&&g.orgId==="root")) } } : {}),
    // As wireProfile: the completeness check reads the same civil ID service.
    web: { origin: REAL_PROFILE_ORIGIN, returnTo: rig.config.allowedReturnUrls[1], profiles: countedProfiles,
      profileCompleteness: { choices: async () => ({ countries: options.countries ?? [] }), civilId: countedCivil } },
  } as BrowserLoginApplication;
  const server = createGatewayServer(undefined, undefined, undefined, login, undefined, undefined, options.documents);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const cookie = (session = REAL_PROFILE_SESSION) => `__Host-studenthub_session=${session}`;
  return {
    url, rig, rows, counts, login, ...services,
    cookie,
    /** A browser GET with the session cookie. */
    get: (path: string, session = REAL_PROFILE_SESSION) => fetch(`${url}${path}`, { headers: { accept: "text/html", cookie: cookie(session) }, redirect: "manual" }),
    /** A same-origin urlencoded POST with the session cookie. */
    post: (path: string, form: Record<string, string>, session = REAL_PROFILE_SESSION) => fetch(`${url}${path}`, { method: "POST", redirect: "manual",
      headers: { accept: "text/html", cookie: cookie(session), origin: REAL_PROFILE_ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString() }),
  };
}
