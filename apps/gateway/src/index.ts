import { createRuntimeCatalogueFromEnv } from './catalogue-runtime.js';
import { PROFILE_RECORDS_CSS, type ProfileRecordsRuntime } from './profile-records-http.js';
import { createRuntimeProfileRecordsFromEnv } from './profile-records-runtime.js';
import { createRuntimeCandidateDocumentsFromEnv } from './candidate-documents-runtime.js';
import { type OrganizationDocumentsRuntime } from './organization-documents-http.js';
import { createRuntimeOrganizationDocumentsFromEnv } from './organization-documents-runtime.js';
import type { CandidateDocuments } from '../../../packages/private-documents/src/candidate-lifecycle.js';
import type { ReferenceCatalogue } from '@studenthub/reference-catalogue';
import type {BrowserResponse} from "@studenthub/login-contract";
import { createServer, type OutgoingHttpHeaders, type Server } from "node:http";
import { Telemetry, disabledTelemetry, telemetryMode, newSpan, inSpan, classifyJourney, type Fault } from '../../../packages/observability/src/index.js';
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  createHealthResponse,
  type McpAdapter,
  type McpToolCall,
  type McpToolResult,
} from "@studenthub/contracts";

import {
  authorizeRequest,
  createDenyAllAuthzMiddleware,
  type AuthzMiddleware,
} from "./authz-middleware.js";
import { createRuntimeLoginFromEnv } from "./login-runtime.js";
import { renderAdminJobs, type AdminJobsPage } from "./admin-jobs.js";
import {renderAdminOutbox,type AdminOutboxPage}from"./admin-outbox.js";
import { parseCompanyDirectoryExportQuery } from "./company-directory.js";
import {
  type BrowserLoginApplication, profileDocument, renderError, renderLanding,
  WEB_CSS, WORKSPACE_HISTORY_JS, wantsHtml, writeHtml, renderWorkspace, renderCompanyDirectory, renderAssignedCompanies, pageDocument,renderNotifications,
} from "./web-ui.js";
import {addNotificationBell} from "./web-ui.js";
import { ROUTES, runRoutes } from "./routes/index.js";
import type { GatewayRouteLogin } from "./routes/context.js";
import { createUniverseEmbedConfigFromEnv, type UniverseEmbedConfig } from "./universe/embed-policy.js";
import { gateUniverseEmbedRequest } from "./universe/embed-host-gate.js";

export * from "./authz-middleware.js";
export * from "./authz-audit.js";
export { createLoginApplication } from "./login-application.js";
export { createRuntimeLoginFromEnv } from "./login-runtime.js";

const DEFAULT_MCP_REQUEST_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_GATEWAY_PORT = 3000;
const DEFAULT_GATEWAY_HOST = "127.0.0.1";
const IMAGE_SOURCE_REVISION_PATH = "/image-source-revision";

async function signedInHtml(login:BrowserLoginApplication|undefined,sessionId:string|undefined,html:string):Promise<string>{try{return addNotificationBell(html,await login?.notifications?.count(sessionId)??0)}catch{return addNotificationBell(html,0)}}

export function readImageSourceRevision(path = IMAGE_SOURCE_REVISION_PATH): string | null {
  let revision: string;
  try {
    revision = readFileSync(path, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!/^[0-9a-f]{40}$/i.test(revision)) {
    throw new Error("image source revision must be a 40-character Git commit SHA");
  }
  return revision;
}

type RequestBodyReadResult =
  | { readonly ok: true; readonly body: Buffer }
  | { readonly ok: false; readonly error: "request_too_large" | "request_stream_error" };

export async function readRequestBody(
  stream: AsyncIterable<Uint8Array | string>,
  maxRequestBytes: number,
): Promise<RequestBodyReadResult> {
  const chunks: Buffer[] = [];
  let receivedBytes = 0;

  try {
    for await (const chunk of stream) {
      const buffer = Buffer.from(chunk);
      receivedBytes += buffer.byteLength;
      if (receivedBytes > maxRequestBytes) return { ok: false, error: "request_too_large" };
      chunks.push(buffer);
    }
  } catch {
    return { ok: false, error: "request_stream_error" };
  }

  return { ok: true, body: Buffer.concat(chunks) };
}

function isMcpToolCall(value: unknown): value is McpToolCall {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.name === "string" &&
    candidate.name.length > 0 &&
    typeof candidate.arguments === "object" &&
    candidate.arguments !== null &&
    !Array.isArray(candidate.arguments)
  );
}

export function parseGatewayPort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_GATEWAY_PORT;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError("PORT must be an integer between 1 and 65535");
  }
  return port;
}

export function parseGatewayHost(value: string | undefined): string {
  if (value === undefined) return DEFAULT_GATEWAY_HOST;
  if (value !== "127.0.0.1" && value !== "::1" && value !== "0.0.0.0") {
    throw new RangeError("HOST must be 127.0.0.1, ::1, or 0.0.0.0");
  }
  return value;
}

export function gatewayListenUrl(host: string, port: number): string {
  const urlHost = host.includes(":") ? `[${host}]` : host;
  return `http://${urlHost}:${port}`;
}

export class UnconfiguredMcpAdapter implements McpAdapter {
  async callTool(call: McpToolCall): Promise<McpToolResult> {
    return {
      ok: false,
      content: [{ type: "text", text: `Tool '${call.name}' is not configured` }],
    };
  }
}

export function createGatewayServer(
  adapter: McpAdapter = new UnconfiguredMcpAdapter(),
  maxRequestBytes = DEFAULT_MCP_REQUEST_LIMIT_BYTES,
  authz: AuthzMiddleware = createDenyAllAuthzMiddleware(),
  login?: BrowserLoginApplication,
  sourceRevision: string | null = readImageSourceRevision(),
  telemetry: Telemetry = disabledTelemetry,
  documents?: CandidateDocuments,
  catalogue?: ReferenceCatalogue,
  profileRecords?: ProfileRecordsRuntime,
  organizationDocuments?: OrganizationDocumentsRuntime,
  universeEmbed?: UniverseEmbedConfig,
): Server {
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes <= 0) {
    throw new RangeError("maxRequestBytes must be a positive safe integer");
  }

  // When reserved, the terminal gate supplies the missing-Host 400 and policy.
  // Otherwise retain Node's existing automatic Host-header requirement.
  return createServer({ requireHostHeader: universeEmbed === undefined }, (request, response) => {
    if (gateUniverseEmbedRequest(request, response, universeEmbed)) return;
    const span = newSpan(); // Ignore incoming request/trace IDs: they can contain PII.
    const started = performance.now();
    const journey = classifyJourney(request.url);
    const html = wantsHtml(request.headers.accept);
    const webSpan = html ? newSpan(span) : undefined;
    let fault: Fault = 'none';
    let completed = false;
    response.setHeader('x-request-id', span.traceId);
    const complete = (aborted: boolean) => {
      if (completed) return;
      completed = true;
      const outcome = aborted ? 'aborted' : response.statusCode >= 500 ? 'failure'
        : response.statusCode >= 400 ? 'refused' : 'success';
      const reason = aborted ? 'response_aborted' : fault === 'none' && response.statusCode >= 500 ? 'dependency_unavailable' : fault;
      telemetry.record(span, 'gateway', journey, outcome, reason, performance.now() - started);
      if (webSpan) telemetry.record(webSpan, 'web', journey, outcome, reason, performance.now() - started);
    };
    response.once('finish', () => complete(false));
    response.once('close', () => complete(!response.writableFinished));
    void inSpan(webSpan ?? span, async () => {
    try {
    const ctx = { request, response, login: login as GatewayRouteLogin | undefined, authz, documents, catalogue,
      profileRecords, organizationDocuments, writeHtml, pageDocument, renderError };
    if (await runRoutes(ROUTES, ctx)) return;
    if (request.method === "GET" && request.url?.split("?", 1)[0] === "/") {
      writeHtml(response, 200, renderLanding(login));
      return;
    }
    if (request.method === "GET" && request.url === "/assets/studenthub.css") {
      response.writeHead(200, {
        "content-type": "text/css; charset=utf-8", "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
      });
      response.end(WEB_CSS + PROFILE_RECORDS_CSS + (await import("./ui/profile-kit.js")).PROFILE_KIT_CSS);
      return;
    }
    if (request.method === "GET" && request.url === "/assets/workspace-history.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store", "x-content-type-options": "nosniff" });
      response.end(WORKSPACE_HISTORY_JS);
      return;
    }
    if (!login && html && request.url && ["/profile", "/login/universe", "/login/callback", "/logout"].includes(requestPath(request.url))) {
      writeHtml(response, 503, renderError(503));
      return;
    }
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(createHealthResponse("gateway", new Date(), sourceRevision)));
      return;
    }

    if (request.method === "GET" && request.url && requestPath(request.url) === "/admin/jobs") {
      const result=await (login as BrowserLoginApplication&{adminJobs?:AdminJobsPage}|undefined)?.adminJobs?.open(cookieValue(request.headers.cookie,"__Host-studenthub_session"))??{status:404 as const,body:{error:"not_found" as const}};
      if(result.status===200){if(html)writeHtml(response,result.status,renderAdminJobs(result),{},true);else writeBrowserResponseSafely(response,{...result,headers:{"cache-control":"no-store",vary:"Accept"}});return}
    }
    if(request.method==="GET"&&request.url&&requestPath(request.url)==="/admin/outbox"){const page=Number(new URL(request.url,"http://gateway.invalid").searchParams.get("page")??"1");const result=await(login as BrowserLoginApplication&{adminOutbox?:AdminOutboxPage}|undefined)?.adminOutbox?.open(cookieValue(request.headers.cookie,"__Host-studenthub_session"),page)??{status:404 as const,body:{error:"not_found" as const}};if(result.status===200){if(html)writeHtml(response,200,renderAdminOutbox(result),{},true);else writeBrowserResponseSafely(response,{...result,headers:{"cache-control":"no-store",vary:"Accept"}});return}}

    if(request.url&&requestPath(request.url)==="/notifications"&&request.method==="GET"){const requestedPage=Number(new URL(request.url,"http://gateway.invalid").searchParams.get("page")??"1"),page=Number.isInteger(requestedPage)&&requestedPage>0?requestedPage:1;const result=await login?.notifications?.open(cookieValue(request.headers.cookie,"__Host-studenthub_session"),page)??{status:404 as const,body:{error:"not_found" as const}};if(html)writeHtml(response,result.status,result.status===200?renderNotifications(result.body):renderError(result.status,login),{},true);else writeBrowserResponseSafely(response,{...result,headers:{"cache-control":"no-store",vary:"Accept"}} as unknown as BrowserResponse);return}
    if(request.url&&request.method==="POST"&&requestPath(request.url)==="/notifications/read-all"){if(request.headers["sec-fetch-site"]==="cross-site"||request.headers.origin!==login?.web?.origin){writeBrowserResponseSafely(response,{status:404,body:{error:"not_found"}});return}const result=await login?.notifications?.readAll(cookieValue(request.headers.cookie,"__Host-studenthub_session"))??{status:404 as const};response.writeHead(result.status===204?303:result.status,result.status===204?{location:"/notifications"}:{});response.end();return}
    if(request.url&&request.method==="POST"&&/^\/notifications\/[^/]+\/read$/.test(requestPath(request.url))){if(request.headers["sec-fetch-site"]==="cross-site"||request.headers.origin!==login?.web?.origin){writeBrowserResponseSafely(response,{status:404,body:{error:"not_found"}});return}const id=requestPath(request.url).split("/")[2]!;const result=await login?.notifications?.read(cookieValue(request.headers.cookie,"__Host-studenthub_session"),id)??{status:404 as const};if(result.status===204){response.writeHead(303,{location:"/notifications"});response.end()}else writeBrowserResponseSafely(response,{status:result.status,body:{error:"not_found"}});return}

    if (request.method === "GET" && request.url && requestPath(request.url) === "/workspace/my-companies") {
      const selected = new URL(request.url, "http://gateway.invalid").searchParams;
      const orgId = selected.get("org_id"), role = selected.get("role");
      const active = orgId && (role === "staff" || role === "admin")
        ? { orgId, role, organizationName: "" } as const
        : null;
      const service = login?.organizationAccountManager;
      let result: import("./organization-account-manager.js").AssignedCompaniesResult;
      try {
        result = service
          ? await service.assigned(cookieValue(request.headers.cookie, "__Host-studenthub_session"))
          : { status: 503, body: { error: "unavailable" } };
      } catch {
        result = { status: 503, body: { error: "unavailable" } };
      }
      if (html) writeHtml(response, active ? result.status : 403, await signedInHtml(login,cookieValue(request.headers.cookie,"__Host-studenthub_session"),login && active ? renderAssignedCompanies(result, login, active) : renderError(login ? 403 : 503, login)), {}, true);
      else writeBrowserResponseSafely(response, { ...result, headers: { "cache-control": "no-store", vary: "Accept" } });
      return;
    }

    if (request.method === "GET" && request.url && requestPath(request.url) === "/workspace/companies") {
      let result: import("./company-directory.js").CompanyDirectoryResult;
      try {
        result = login?.companies
          ? await login.companies.open(
            cookieValue(request.headers.cookie, "__Host-studenthub_session"),
            new URL(request.url, "http://gateway.invalid").searchParams,
          )
          : { status: 503, body: { error: "directory_unavailable" } };
      } catch {
        result = { status: 503, body: { error: "directory_unavailable" } };
      }
      if (html) {
        writeHtml(response, result.status, await signedInHtml(login,cookieValue(request.headers.cookie,"__Host-studenthub_session"),login ? renderCompanyDirectory(result, login) : renderError(503)), {}, true);
      } else {
        writeBrowserResponseSafely(response, { ...result, headers: { "cache-control": "no-store", vary: "Accept" } });
      }
      return;
    }

    if (request.method === "POST" && request.url && requestPath(request.url) === "/exports/company-directory") {
      const origin=request.headers.origin,contentType=request.headers["content-type"]?.split(";",1)[0];
      if(!login?.exports||request.headers["sec-fetch-site"]==="cross-site"||origin!==login.web?.origin||contentType!=="application/x-www-form-urlencoded"){writeBrowserResponseSafely(response,{status:404,body:{error:"not_found"}});return;}
      const filters=parseCompanyDirectoryExportQuery(new URL(request.url,"http://gateway.invalid").searchParams);
      if(!filters){writeBrowserResponseSafely(response,{status:404,body:{error:"not_found"}});return;}
      const result=await login.exports.request(cookieValue(request.headers.cookie,"__Host-studenthub_session"),filters);
      if(html){const content=result.status===200?`<main><h1>Export ready.</h1><p>${result.body.rowCount} companies exported.</p><a class="button primary" href="${result.body.downloadUrl}">Download CSV</a></main>`:result.status===409?`<main><h1>Export refused.</h1><p>This export exceeds the 10,000 row limit. Narrow the filters and try again.</p></main>`:`<main><h1>Export not found.</h1></main>`;writeHtml(response,result.status,pageDocument("Company export",content),{},true);return;}
      writeBrowserResponseSafely(response,{...result,headers:{"cache-control":"no-store"}});return;
    }

    if (request.method === "GET" && request.url && /^\/exports\/[^/]+$/.test(requestPath(request.url))) {
      const bytes=await login?.exports?.download(cookieValue(request.headers.cookie,"__Host-studenthub_session"),requestPath(request.url).slice(9));
      if(!bytes){writeBrowserResponseSafely(response,{status:404,body:{error:"not_found"}});return;}
      response.writeHead(200,{"content-type":"text/csv; charset=utf-8","content-disposition":'attachment; filename="company-directory.csv"',"cache-control":"no-store","x-content-type-options":"nosniff","referrer-policy":"no-referrer"});response.end(bytes);return;
    }

    if (request.method === "GET" && request.url && requestPath(request.url) === "/workspace") {
      let result: import("./context-navigation.js").NavigationResult;
      try {
        result = login?.navigation
          ? await login.navigation.open(
            cookieValue(request.headers.cookie, "__Host-studenthub_session"),
            new URL(request.url, "http://gateway.invalid").searchParams,
          )
          : { status: 503, body: { error: "context_unavailable" } };
      } catch {
        result = { status: 503, body: { error: "context_unavailable" } };
      }
      if (html) {
        writeHtml(response, result.status, await signedInHtml(login,cookieValue(request.headers.cookie,"__Host-studenthub_session"),login ? renderWorkspace(result, login, documents !== undefined) : renderError(503)), {}, true);
      } else {
        writeBrowserResponseSafely(response, { ...result, headers: { "cache-control": "no-store", vary: "Accept" } });
      }
      return;
    }

    if (login && request.method === "GET" && request.url && requestPath(request.url) === "/login/universe") {
      const url = new URL(request.url, "http://gateway.invalid");
      const returnTo = url.searchParams.get("return_to");
      if (!returnTo) {
        if (html) { writeHtml(response, 400, renderError(400, login)); return; }
        writeBrowserResponseSafely(response, { status: 400, body: { error: "login_rejected" } });
        return;
      }
      const browserSessionId = cookieValue(request.headers.cookie, "__Host-studenthub_browser")
        ?? randomBytes(32).toString("base64url");
      let result: import("@studenthub/login-contract").BrowserResponse;
      try {
        result = await login.start({ browserSessionId, returnTo });
      } catch {
        fault = 'dependency_unavailable';
        result = { status: 503, body: { error: "login_unavailable" } };
      }
      if (html && result.status >= 400) { writeHtml(response, result.status, renderError(result.status, login)); return; }
      writeBrowserResponseSafely(response, result, result.status === 302
        ? `__Host-studenthub_browser=${browserSessionId}; Path=/; HttpOnly; Secure; SameSite=Lax`
        : undefined);
      return;
    }

    if (login && request.method === "GET" && request.url && requestPath(request.url) === "/login/callback") {
      const url = new URL(request.url, "http://gateway.invalid");
      const browserSessionId = cookieValue(request.headers.cookie, "__Host-studenthub_browser");
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (!browserSessionId || !state || !code) {
        if (html) { writeHtml(response, 400, renderError(400, login)); return; }
        writeBrowserResponseSafely(response, { status: 400, body: { error: "login_rejected" } });
        return;
      }
      let result: import("@studenthub/login-contract").BrowserResponse;
      try {
        result = await login.callback({ browserSessionId, state, code });
      } catch {
        fault = 'dependency_unavailable';
        result = { status: 503, body: { error: "login_unavailable" } };
      }
      if (html && result.status >= 400) { writeHtml(response, result.status, renderError(result.status, login)); return; }
      writeBrowserResponseSafely(response, result);
      return;
    }

    if (login && request.method === "GET" && request.url && requestPath(request.url) === "/profile") {
      const url = new URL(request.url, "http://gateway.invalid");
      let result: import("@studenthub/login-contract").BrowserResponse;
      try {
        result = await login.profile({
          sessionId: cookieValue(request.headers.cookie, "__Host-studenthub_session"),
          personId: url.searchParams.get("person_id") ?? undefined,
        });
      } catch {
        fault = 'dependency_unavailable';
        result = { status: 503, body: { error: "login_unavailable" } };
      }
      if (result.status === 200 && login.web) {
        try {
          const requesterPrincipalId = result.body?.personId;
          if (typeof requesterPrincipalId !== "string" || requesterPrincipalId.length === 0) {
            throw new Error("invalid authorized profile");
          }
          const profile = await login.web.profiles.readOwn({
            requesterPrincipalId,
            targetPersonId: url.searchParams.get("person_id") ?? requesterPrincipalId,
          });
          result = profile.kind === "found"
            ? { status: 200, body: profile.profile }
            : profile.kind === "not_found"
              ? { status: 404, body: { error: "profile_not_found" } }
              : { status: 503, body: { error: "profile_unavailable" } };
        } catch {
          fault = 'dependency_unavailable';
          result = { status: 503, body: { error: "profile_unavailable" } };
        }
      }
      if (html) {
        try {
          const notice = await login.browserEdit?.notice(cookieValue(request.headers.cookie, "__Host-studenthub_session"), request.headers.cookie);
          const page = await profileDocument(result, login, notice?.notice, documents !== undefined);if(page.status===200)page.html=await signedInHtml(login,cookieValue(request.headers.cookie,"__Host-studenthub_session"),page.html);
          writeHtml(response, page.status, page.html, notice?.clearCookie ? { "set-cookie": notice.clearCookie } : {});
        } catch {
          fault = 'render_failure';
          writeHtml(response, 503, renderError(503, login));
        }
        return;
      }
      writeBrowserResponseSafely(response, {
        ...result,
        headers: { ...result.headers, "cache-control": "no-store", vary: "Accept" },
      });
      return;
    }

    if (login && request.method === "POST" && request.url && requestPath(request.url) === "/logout") {
      // Native browser forms must prove the configured origin; Host and forwarded
      // headers are not authority. Preserve non-browser clients without Origin.
      const origin = request.headers.origin;
      if (request.headers["sec-fetch-site"] === "cross-site"
        || (origin !== undefined && origin !== login.web?.origin)
        || (html && (!origin || !login.web?.origin))) {
        if (html) writeHtml(response, 403, renderError(403, login));
        else writeBrowserResponseSafely(response, { status: 403, body: { error: "login_rejected" } });
        return;
      }
      let result: import("@studenthub/login-contract").BrowserResponse;
      try {
        result = await login.logout(cookieValue(request.headers.cookie, "__Host-studenthub_session"));
      } catch {
        fault = 'dependency_unavailable';
        result = { status: 503, body: { error: "login_unavailable" } };
      }
      if (html) {
        if (result.status === 204) {
          response.writeHead(303, { ...result.headers, location: "/", "cache-control": "no-store", vary: "Accept" });
          response.end();
        } else {
          writeHtml(response, result.status, renderError(result.status, login));
        }
        return;
      }
      writeBrowserResponseSafely(response, result);
      return;
    }

    if (request.method === "POST" && request.url === "/mcp/tools/call") {
      // Gate the call BEFORE reading the body. There is no unauthenticated
      // path: `authz` has no undefined case, and its default denies every
      // request. When it allows, the active context has been derived
      // server-side from grants — no client-supplied role is ever trusted.
      {
        const raw = request.headers["x-actor-assertion"];
        const assertionWire = Array.isArray(raw) ? raw[0] : raw;
        // authorizeRequest is awaited inside an async listener: an escaping
        // rejection would send no response and can terminate the process under
        // Node's default unhandled-rejection policy. Dependency failures become
        // 503 and still never reach the adapter.
        let decision: Awaited<ReturnType<typeof authorizeRequest>>;
        try {
          decision = await authorizeRequest(assertionWire, authz);
        } catch {
          fault = 'dependency_unavailable';
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: false, error: "authz_unavailable" }));
          return;
        }
        if (decision.kind === "deny") {
          const body =
            decision.status === 401
              ? { ok: false, error: "unauthorized", reason: decision.reason }
              : { ok: false, error: "forbidden", reason: decision.reason };
          response.writeHead(decision.status, { "content-type": "application/json" });
          response.end(JSON.stringify(body));
          return;
        }
      }

      const bodyRead = await readRequestBody(request, maxRequestBytes);
      if (!bodyRead.ok) {
        if (!response.headersSent && !response.destroyed) {
          const status = bodyRead.error === "request_too_large" ? 413 : 400;
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: false, error: bodyRead.error }));
        }
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyRead.body.toString("utf8")) as unknown;
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, error: "invalid_request" }));
        return;
      }

      if (!isMcpToolCall(parsed)) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, error: "invalid_request" }));
        return;
      }

      try {
        const call = parsed;
        const result = await adapter.callTool(call);
        if (!result.ok) fault = 'adapter_failure';
        const status = result.ok ? 200 : adapter instanceof UnconfiguredMcpAdapter ? 501 : 502;
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
      } catch {
        fault = 'adapter_failure';
        response.writeHead(502, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, error: "adapter_failure" }));
      }
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: "not_found" }));
    } catch {
      fault = 'unhandled_failure';
      if (!response.headersSent && !response.destroyed) {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error: 'service_unavailable' }));
      } else response.destroy();
    }
    });
  });
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const item of header?.split(";") ?? []) {
    const [key, ...value] = item.trim().split("=");
    const candidate = value.join("=");
    if (key === name && /^[A-Za-z0-9_-]{43}$/.test(candidate)) return candidate;
  }
  return undefined;
}

function requestPath(raw: string): string {
  return new URL(raw, "http://gateway.invalid").pathname;
}

function writeBrowserResponse(
  response: import("node:http").ServerResponse,
  result: import("@studenthub/login-contract").BrowserResponse,
  additionalCookie?: string,
): void {
  const headers: OutgoingHttpHeaders = {
    "content-type": "application/json",
    ...result.headers,
  };
  if (additionalCookie) {
    const existing = result.headers?.["set-cookie"];
    headers["set-cookie"] = existing ? [existing, additionalCookie] : additionalCookie;
  }
  response.writeHead(result.status, headers);
  response.end(result.body === undefined ? undefined : JSON.stringify(result.body));
}

function writeBrowserResponseSafely(
  response: import("node:http").ServerResponse,
  result: import("@studenthub/login-contract").BrowserResponse,
  additionalCookie?: string,
): void {
  try {
    writeBrowserResponse(response, result, additionalCookie);
  } catch {
    response.destroy();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entrypoint === import.meta.url) {
  const port = parseGatewayPort(process.env.PORT);
  const host = parseGatewayHost(process.env.HOST);
  const runtimeLogin = createRuntimeLoginFromEnv();
  const universeEmbed = createUniverseEmbedConfigFromEnv(process.env, runtimeLogin?.application.web?.origin);
  const runtimeDocuments = await createRuntimeCandidateDocumentsFromEnv();
  const runtimeOrganizationDocuments = await createRuntimeOrganizationDocumentsFromEnv();
  const runtimeCatalogue = createRuntimeCatalogueFromEnv();
  const runtimeProfileRecords = createRuntimeProfileRecordsFromEnv();
  const telemetry = new Telemetry(telemetryMode(process.env));
  const server = createGatewayServer(
    new UnconfiguredMcpAdapter(),
    DEFAULT_MCP_REQUEST_LIMIT_BYTES,
    createDenyAllAuthzMiddleware(),
    runtimeLogin?.application,
    readImageSourceRevision(),
    telemetry,
    runtimeDocuments?.service,
    runtimeCatalogue?.service,
    runtimeProfileRecords,
    runtimeOrganizationDocuments,
    universeEmbed,
  );
  server.once("close", () => { void runtimeLogin?.close(); void runtimeDocuments?.close(); void runtimeOrganizationDocuments?.close(); void runtimeCatalogue?.close(); void runtimeProfileRecords?.close(); void telemetry.close(); });
  server.listen(port, host, () => {
    process.stdout.write(`studenthub gateway listening on ${gatewayListenUrl(host, port)}\n`);
  });
}
