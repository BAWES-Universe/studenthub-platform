import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthzMiddleware } from "./authz-middleware.js";
import type { GatewayRouteLogin } from "./routes/context.js";
import type { ProfileRecordsRuntime } from "./profile-records-http.js";
import { currentProfileAvatar } from "./profile-avatar.js";
import { wantsHtml } from "./web-ui.js";
import type { CompletenessEvidence } from "@studenthub/profile";
import type { Principal } from "@studenthub/contracts";

type Country = { readonly id: string; readonly code: string; readonly name: string };
type Prepared = { readonly evidence?: CompletenessEvidence; readonly choices?: Readonly<{ countries: readonly Country[]; universities: readonly { readonly id: string; readonly name: string }[] }>; readonly principal?: Principal };
const context = new AsyncLocalStorage<IncomingMessage>();
const reads = new Map<IncomingMessage, Prepared>();
const credential = (request: IncomingMessage) => (request.headers.cookie?.split(";") ?? []).map(value => value.trim())
  .find(value => value.startsWith("__Host-studenthub_session="))?.slice("__Host-studenthub_session=".length);

export async function prepareProfileCompleteness(request: IncomingMessage, response: ServerResponse, login: GatewayRouteLogin | undefined,
  authz: AuthzMiddleware, records: ProfileRecordsRuntime | undefined): Promise<void> {
  if (request.method !== "GET" || (request.url ?? "").split("?")[0] !== "/profile" || !wantsHtml(request.headers.accept)) return;
  context.enterWith(request);
  const cleanup = () => reads.delete(request); response.once("finish", cleanup); response.once("close", cleanup);
  try {
    const session = credential(request);
    if (!session || !records || !login?.civilId || !login.profileEdit?.choices) throw new Error("completeness unavailable");
    const ownerId = (await records.sessions.get(session))?.personId;
    const avatar = currentProfileAvatar();
    if (!ownerId || !avatar) throw new Error("completeness unavailable");
    const [principal, background, choices] = await Promise.all([
      authz.store.getPrincipal(ownerId), records.service.background(ownerId), login.profileEdit.choices(),
    ]);
    if (!principal) throw new Error("completeness unavailable");
    const countries = choices.countries.map(country => ({ id: country.id, code: country.code, name: country.name })) as readonly Country[];
    reads.set(request, { choices: { countries, universities: choices.universities }, principal, evidence: {
      emailPresent: typeof principal.email === "string" && principal.email.trim().length > 0,
      documents: avatar.documents, hasEducation: background.education.length > 0, hasSkill: background.skill.length > 0,
      countries,
    } });
  } catch { reads.set(request, {}); }
}

export function currentProfileCompleteness(): Prepared | undefined {
  const request = context.getStore(); return request ? reads.get(request) : undefined;
}

/** Reuses the principal fetched for the HTML check when OwnProfileRepository authorizes the same request. */
export async function readPreparedProfilePrincipal(store: Pick<AuthzMiddleware["store"], "getPrincipal">, principalId: string): Promise<Principal | undefined> {
  const prepared = currentProfileCompleteness();
  return prepared?.principal?.id === principalId ? prepared.principal : store.getPrincipal(principalId);
}
