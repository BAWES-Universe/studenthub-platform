import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionStore } from "@studenthub/login-contract";
import { isOrganizationStoreId, organizationStoresView, parseOrganizationStoreFields, type OrganizationStoreFields, type OrganizationStoreRow } from "@studenthub/organizations";

// SHU-165 O7a: HTTP surface for an organization's stores.
//   POST /organization/stores/create  {orgId, store:{name, location?, brandId?, mallId?}}
//   POST /organization/stores/update  {orgId, storeId, store:{...}}
//   POST /organization/stores/remove  {orgId, storeId}
//   GET  /organization/stores/:orgId
// A refused caller, an unknown organization and a deleted one all answer 404.

type Refusal = { kind: "not_found" | "brand_not_found" | "mall_not_found" };
export interface OrganizationStoresStore {
  create(principalId: string, orgId: string, store: OrganizationStoreFields): Promise<{ kind: "created"; storeId: string } | Refusal>;
  update(principalId: string, orgId: string, storeId: string, store: OrganizationStoreFields): Promise<{ kind: "updated" | "unchanged" | "store_not_found" } | Refusal>;
  remove(principalId: string, orgId: string, storeId: string): Promise<{ kind: "removed" | "not_found" | "store_not_found" }>;
  list(principalId: string, orgId: string): Promise<OrganizationStoreRow[] | null>;
}
type Result = { status: 200; body: unknown } | { status: 400 | 401 | 403 | 404 | 503; body: { error: string } };
export interface OrganizationStores {
  create(session: string | undefined, body: unknown): Promise<Result>;
  update(session: string | undefined, body: unknown): Promise<Result>;
  remove(session: string | undefined, body: unknown): Promise<Result>;
  list(session: string | undefined, orgId: string): Promise<Result>;
}

const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const org = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(v);
const keys = (v: Record<string, unknown>, expected: string) => Object.keys(v).sort().join() === expected;
const BAD: Result = { status: 400, body: { error: "invalid_request" } };
const UNAUTHORIZED: Result = { status: 401, body: { error: "unauthorized" } };
const refusal = (kind: string): Result => ({ status: 404, body: { error: kind } });

export function createOrganizationStores(p: { sessions: Pick<SessionStore, "get">; store: OrganizationStoresStore }): OrganizationStores {
  const principal = async (s: string | undefined) => (s ? (await p.sessions.get(s))?.personId : undefined);
  return {
    async create(s, body) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      if (!object(body) || !keys(body, "orgId,store") || !org(body.orgId)) return BAD;
      const fields = parseOrganizationStoreFields(body.store);
      if (!fields) return BAD;
      const r = await p.store.create(id, body.orgId, fields);
      return r.kind === "created" ? { status: 200, body: { storeId: r.storeId, changed: true } } : refusal(r.kind);
    },
    async update(s, body) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      if (!object(body) || !keys(body, "orgId,store,storeId") || !org(body.orgId) || !isOrganizationStoreId(body.storeId)) return BAD;
      const fields = parseOrganizationStoreFields(body.store);
      if (!fields) return BAD;
      const storeId = body.storeId.toLowerCase();
      const r = await p.store.update(id, body.orgId, storeId, fields);
      return r.kind === "updated" || r.kind === "unchanged" ? { status: 200, body: { storeId, changed: r.kind === "updated" } } : refusal(r.kind);
    },
    async remove(s, body) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      if (!object(body) || !keys(body, "orgId,storeId") || !org(body.orgId) || !isOrganizationStoreId(body.storeId)) return BAD;
      const storeId = body.storeId.toLowerCase();
      const r = await p.store.remove(id, body.orgId, storeId);
      return r.kind === "removed" ? { status: 200, body: { storeId, changed: true } } : refusal(r.kind);
    },
    async list(s, orgId) {
      const id = await principal(s);
      if (!id) return UNAUTHORIZED;
      if (!org(orgId)) return BAD;
      const rows = await p.store.list(id, orgId);
      return rows ? { status: 200, body: { stores: organizationStoresView(rows) } } : refusal("not_found");
    },
  };
}

const WRITES: Readonly<Record<string, "create" | "update" | "remove">> = {
  "/organization/stores/create": "create",
  "/organization/stores/update": "update",
  "/organization/stores/remove": "remove",
};
const LIST = /^\/organization\/stores\/([^/]+)$/, LIMIT = 4096;

function cookie(header: string | undefined) {
  for (const item of header?.split(";") ?? []) {
    const [k, ...v] = item.trim().split("=");
    if (k === "__Host-studenthub_session" && /^[A-Za-z0-9_-]{43}$/.test(v.join("="))) return v.join("=");
  }
}

async function json(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let n = 0;
  if (Number(req.headers["content-length"]) > LIMIT) { req.resume(); return; }
  for await (const c of req.iterator({ destroyOnReturn: false })) {
    const b = Buffer.from(c);
    if ((n += b.length) > LIMIT) { req.resume(); return; }
    chunks.push(b);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()) as unknown; } catch { return; }
}

export async function handleOrganizationStores(req: IncomingMessage, res: ServerResponse, s: OrganizationStores | undefined, origin: string | undefined) {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  const write = Object.hasOwn(WRITES, path) ? WRITES[path] : undefined;
  const list = write ? null : LIST.exec(path);
  if (!write && !list) return false;
  const send = (r: Result) => {
    res.writeHead(r.status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
    res.end(JSON.stringify(r.body));
  };
  try {
    if (!s || !origin) { send({ status: 503, body: { error: "organization_stores_unavailable" } }); return true; }
    const session = cookie(req.headers.cookie);
    if (list) {
      if (req.method !== "GET") { send({ status: 404, body: { error: "not_found" } }); return true; }
      let id: string;
      try { id = decodeURIComponent(list[1]!); } catch { send(BAD); return true; }
      send(await s.list(session, id));
      return true;
    }
    if (req.method !== "POST") { send({ status: 404, body: { error: "not_found" } }); return true; }
    if (req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") { req.resume(); send({ status: 403, body: { error: "origin_rejected" } }); return true; }
    if (req.headers["content-type"] !== "application/json") { req.resume(); send(BAD); return true; }
    const body = await json(req);
    if (body === undefined) { send(BAD); return true; }
    send(await s[write!](session, body));
  } catch {
    if (!res.headersSent) send({ status: 503, body: { error: "organization_stores_unavailable" } });
    else res.destroy();
  }
  return true;
}
