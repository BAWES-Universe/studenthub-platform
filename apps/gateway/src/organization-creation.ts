import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionStore } from "@studenthub/login-contract";
import { parseOrganizationName } from "@studenthub/organizations";

export interface OrganizationCreationStore { create(principalId: string, parentId: string, name: string): Promise<{ kind: "created"; orgId: string } | { kind: "not_found" | "hierarchy" | "name_taken" }> }
type Result = { status: 200; body: { orgId: string; changed: true } } | { status: 400 | 401 | 404 | 409; body: { error: string } };
export interface OrganizationCreation { create(session: string | undefined, body: unknown): Promise<Result> }
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const org = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(v);
const BAD: Result = { status: 400, body: { error: "invalid_request" } };

export function createOrganizationCreation(p: { sessions: Pick<SessionStore, "get">; store: OrganizationCreationStore }): OrganizationCreation {
  return { async create(session, body) {
    const principal = session ? (await p.sessions.get(session))?.personId : undefined;
    if (!principal) return { status: 401, body: { error: "unauthorized" } };
    if (!object(body) || Object.keys(body).sort().join() !== "name,parentOrgId" || !org(body.parentOrgId)) return BAD;
    const name = parseOrganizationName(body.name);
    if (!name) return BAD;
    const result = await p.store.create(principal, body.parentOrgId, name);
    if (result.kind === "created") return { status: 200, body: { orgId: result.orgId, changed: true } };
    if (result.kind === "hierarchy") return { status: 409, body: { error: "hierarchy_too_deep" } };
    return { status: result.kind === "name_taken" ? 409 : 404, body: { error: result.kind } };
  } };
}

const LIMIT = 4096;
function cookie(header: string | undefined) { for (const item of header?.split(";") ?? []) { const [k, ...v] = item.trim().split("="); if (k === "__Host-studenthub_session" && /^[A-Za-z0-9_-]{43}$/.test(v.join("="))) return v.join("="); } }
async function json(req: IncomingMessage) { const chunks: Buffer[] = []; let n = 0; if (Number(req.headers["content-length"]) > LIMIT) { req.resume(); return; } for await (const c of req.iterator({ destroyOnReturn: false })) { const b = Buffer.from(c); if ((n += b.length) > LIMIT) { req.resume(); return; } chunks.push(b); } try { return JSON.parse(Buffer.concat(chunks).toString()) as unknown; } catch { return; } }

export async function handleOrganizationCreation(req: IncomingMessage, res: ServerResponse, service: OrganizationCreation | undefined, origin: string | undefined) {
  if (new URL(req.url ?? "/", "http://x").pathname !== "/organization/create") return false;
  const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" }); res.end(JSON.stringify(body)); };
  try {
    if (!service || !origin) { send(503, { error: "organization_creation_unavailable" }); return true; }
    if (req.method !== "POST") { send(404, { error: "not_found" }); return true; }
    if (req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") { req.resume(); send(403, { error: "origin_rejected" }); return true; }
    if (req.headers["content-type"] !== "application/json") { req.resume(); send(400, { error: "invalid_request" }); return true; }
    const body = await json(req); if (body === undefined) { send(400, { error: "invalid_request" }); return true; }
    const result = await service.create(cookie(req.headers.cookie), body); send(result.status, result.body);
  } catch { if (!res.headersSent) send(503, { error: "organization_creation_unavailable" }); else res.destroy(); }
  return true;
}
