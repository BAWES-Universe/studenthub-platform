import type { AuthzStore } from "@studenthub/contracts";
import type { SessionStore } from "@studenthub/login-contract";
import { DEFAULT_OPERATOR_ORG_IDS } from "@studenthub/organizations";
import type { GatewayRouteContext } from "../routes/context.js";
import { wantsHtml } from "../web-ui.js";
import { INTEGRATION_REGISTER, type Disposition, type RegisteredIntegration, type RotationState } from "./integration-register.js";

/**
 * Platform integrations (release matrix A-27; legacy admin settings and the integration
 * inventory): one read-only page where a StudentHub admin sees every outside service the old
 * platform used, what happens to it at the move (keep, replace, drop, or waiting for a decision)
 * and the state of its credentials. It shows the committed register only: no credential name or
 * value, no live connection check and no way to change anything. The legacy settings API's
 * analytics keys belong to integrations still waiting for a decision, so nothing is editable.
 *
 * Only an admin at an operator organization is answered, checked on every request; anyone else,
 * signed out included, gets the gateway's unknown-path answer (the handler returns false).
 */
export const PLATFORM_INTEGRATIONS_PATH = "/platform/integrations";

export interface PlatformIntegrationsView {
  readonly counts: Readonly<Record<Disposition, number>>;
  readonly integrations: readonly RegisteredIntegration[];
}
export interface PlatformIntegrations {
  /** The register for an admin at an operator organization; null for anyone else. */
  open(sessionId: string | undefined): Promise<PlatformIntegrationsView | null>;
}

export function createPlatformIntegrations(deps: {
  readonly sessions: Pick<SessionStore, "get">;
  readonly authz: Pick<AuthzStore, "listGrantsForPrincipal">;
  readonly register?: readonly RegisteredIntegration[];
}): PlatformIntegrations {
  const register = deps.register ?? INTEGRATION_REGISTER;
  return {
    async open(sessionId) {
      const session = sessionId ? await deps.sessions.get(sessionId) : undefined;
      if (!session) return null;
      const grants = await deps.authz.listGrantsForPrincipal(session.personId);
      if (!grants.some(g => g.role === "admin" && (DEFAULT_OPERATOR_ORG_IDS as readonly string[]).includes(g.orgId))) return null;
      const counts: Record<Disposition, number> = { keep: 0, replace: 0, drop: 0, pending: 0 };
      for (const entry of register) counts[entry.disposition]++;
      return { counts, integrations: register };
    },
  };
}

const escapeHtml = (v: string) => v.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export const DISPOSITION_LABELS: Readonly<Record<Disposition, string>> = {
  keep: "Keep", replace: "Replace", drop: "Drop", pending: "Waiting for a decision",
};
export const ROTATION_LABELS: Readonly<Record<RotationState, string>> = {
  "rotate-revoke": "Rotate or revoke before the move",
  "operator-check": "An operator checks it",
  "db-state-unknown": "Kept in the old database, not yet checked",
  none: "No credential",
};

function render(v: PlatformIntegrationsView): string {
  const e = escapeHtml, c = v.counts;
  const pending = c.pending === 0 ? "" : `<p class="status-warn" role="status">${c.pending === 1 ? "1 integration is" : `${c.pending} integrations are`} waiting for a decision. Until it is made, the integration is not connected and its old service is not retired.</p>`;
  const rows = v.integrations.map(i => `<tr><th scope="row">${e(i.name)}</th><td>${i.disposition === "pending" ? `<strong>${e(DISPOSITION_LABELS.pending)}</strong>` : e(DISPOSITION_LABELS[i.disposition])}</td><td>${e(ROTATION_LABELS[i.rotationState])}</td><td>${e(i.notes)}</td></tr>`).join("");
  return `<main id="main" class="profile-main"><h1>Integrations</h1>${pending}
    <p>Every outside service the old platform used, and what happens to it at the move. Credentials are never shown here.</p>
    <dl class="profile-fields">
      <div><dt>Keep</dt><dd>${c.keep}</dd></div><div><dt>Replace</dt><dd>${c.replace}</dd></div>
      <div><dt>Drop</dt><dd>${c.drop}</dd></div><div><dt>Waiting for a decision</dt><dd>${c.pending}</dd></div>
    </dl>
    <table><caption>Integration register</caption><thead><tr><th scope="col">Integration</th><th scope="col">Plan</th><th scope="col">Credentials</th><th scope="col">Notes</th></tr></thead><tbody>${rows}</tbody></table>
    <p><a class="text-link" href="/platform/operations">Operations</a></p></main>`;
}

const sessionCookie = (header: string | undefined) => {
  for (const part of header?.split(";") ?? []) {
    const [key, ...rest] = part.trim().split("=");
    const value = rest.join("=");
    if (key === "__Host-studenthub_session" && /^[A-Za-z0-9_-]{43}$/.test(value)) return value;
  }
  return undefined;
};

/** GET or HEAD on `/platform/integrations`; false for any other request or a refused caller. */
export async function handlePlatformIntegrations(ctx: GatewayRouteContext): Promise<boolean> {
  const { request, response } = ctx;
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const url = new URL(request.url ?? "/", "http://gateway.invalid");
  if (url.pathname !== PLATFORM_INTEGRATIONS_PATH) return false;
  const service = ctx.login?.platformIntegrations;
  if (!service) return false;
  const view = await service.open(sessionCookie(request.headers.cookie));
  if (!view) return false;
  if (wantsHtml(request.headers.accept)) { ctx.writeHtml(response, 200, ctx.pageDocument("Integrations", render(view)), { "cache-control": "no-store", vary: "Accept" }); return true; }
  response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", vary: "Accept" });
  response.end(request.method === "HEAD" ? undefined : JSON.stringify({ status: "ok", ...view }));
  return true;
}
