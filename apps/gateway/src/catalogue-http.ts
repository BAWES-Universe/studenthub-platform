import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isRole } from "@studenthub/contracts";
import { CatalogueError, type CatalogueActor, type ReferenceCatalogue } from "@studenthub/reference-catalogue";
import { authorizeRequest, type AuthzMiddleware } from "./authz-middleware.js";

const BODY_LIMIT = 32 * 1024;

export async function handleCatalogue(
  request: IncomingMessage,
  response: ServerResponse,
  service: ReferenceCatalogue | undefined,
  authz: AuthzMiddleware,
): Promise<boolean> {
  if (!request.url) return false;
  const url = new URL(request.url, "http://gateway.invalid");
  if (!url.pathname.startsWith("/catalogue/")) return false;
  const parts = url.pathname.split("/").filter(Boolean);

  try {
    if (request.method === "GET" && parts.length === 2 && parts[1] !== "submissions") {
      requireService(service);
      send(response, 200, await service.list(parts[1], {
        cursor: url.searchParams.get("cursor") ?? undefined,
        pageSize: url.searchParams.get("page_size") ?? undefined,
      }));
      return true;
    }

    const actor = await authorizedActor(request, response, authz);
    if (!actor) return true;
    requireService(service);

    if (request.method === "POST" && parts.length === 2 && parts[1] !== "submissions") {
      send(response, 201, await service.create(actor, parts[1], await jsonBody(request)));
      return true;
    }
    if (request.method === "PATCH" && parts.length === 3 && parts[1] !== "submissions") {
      send(response, 200, await service.update(actor, parts[1], parts[2]!, await jsonBody(request)));
      return true;
    }
    if (request.method === "DELETE" && parts.length === 3 && parts[1] !== "submissions") {
      send(response, 200, await service.remove(actor, parts[1], parts[2]!));
      return true;
    }
    if (request.method === "POST" && parts.length === 3 && parts[1] === "submissions") {
      send(response, 201, await service.submit(actor, parts[2], await jsonBody(request)));
      return true;
    }
    if (request.method === "GET" && parts.length === 2 && parts[1] === "submissions") {
      send(response, 200, await service.submissions(actor, {
        status: url.searchParams.get("status") ?? undefined,
        type: url.searchParams.get("type") ?? undefined,
        cursor: url.searchParams.get("cursor") ?? undefined,
        pageSize: url.searchParams.get("page_size") ?? undefined,
      }));
      return true;
    }
    if (request.method === "POST" && parts.length === 4 && parts[1] === "submissions" && parts[3] === "decision") {
      const body = await jsonBody(request);
      const keys = typeof body === "object" && body !== null && !Array.isArray(body) ? Object.keys(body as object) : [];
      if (keys.length !== 1 || keys[0] !== "decision") throw new CatalogueError("invalid_moderation_decision", 400);
      send(response, 200, await service.moderate(actor, parts[2]!, (body as { decision?: unknown }).decision));
      return true;
    }
    send(response, 404, { error: "not_found" });
  } catch (error) {
    if (error instanceof CatalogueError) send(response, error.status, { error: error.code });
    else send(response, 503, { error: "catalogue_unavailable" });
  }
  return true;
}

async function authorizedActor(request: IncomingMessage, response: ServerResponse, authz: AuthzMiddleware): Promise<CatalogueActor | undefined> {
  const raw = request.headers["x-actor-assertion"];
  const wire = Array.isArray(raw) ? raw[0] : raw;
  let decision: Awaited<ReturnType<typeof authorizeRequest>>;
  try { decision = await authorizeRequest(wire, authz); }
  catch { send(response, 503, { error: "authz_unavailable" }); return undefined; }
  if (decision.kind === "deny") {
    send(response, decision.status, { error: decision.status === 401 ? "unauthorized" : "forbidden", reason: decision.reason });
    return undefined;
  }
  if (!isRole(decision.role)) { send(response, 403, { error: "forbidden" }); return undefined; }
  return { principalRef: createHash("sha256").update(decision.subject).digest("hex"), orgId: decision.orgId, role: decision.role };
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > BODY_LIMIT) throw new CatalogueError("catalogue_request_too_large", 400);
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new CatalogueError("invalid_catalogue_json", 400); }
}

function requireService(service: ReferenceCatalogue | undefined): asserts service is ReferenceCatalogue {
  if (!service) throw new CatalogueError("catalogue_unavailable", 503);
}
function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}
