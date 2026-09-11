// Local visual QA only: synthetic people, no database or real identity provider.
// Never used by start:gateway or either production container entrypoint.
import { createServer } from "node:http";
import { InMemoryAuthzStore } from "@studenthub/contracts";
import { createContextNavigation } from "../../../dist/apps/gateway/src/context-navigation.js";
import { createSyntheticLoginRig } from "@studenthub/login-contract";
import { createLoginApplication } from "../../../dist/apps/gateway/src/login-application.js";
import { createGatewayServer } from "../../../dist/apps/gateway/src/index.js";
import { profileDocument, renderLanding } from "../../../dist/apps/gateway/src/web-ui.js";

if (process.env.NODE_ENV === "production") throw new Error("Synthetic web preview is forbidden in production");
const rig = createSyntheticLoginRig(createLoginApplication);
const session = "v".repeat(43);
await rig.sessions.put({ id: session, personId: "person-preview" });
const navigationStore = new InMemoryAuthzStore({
  principals: [{ id: "person-preview", pbuuids: [] }],
  organizations: [{ id: "preview-company", name: "Example Company" }, { id: "preview-campus", name: "Example Campus" }],
});
await navigationStore.grantMany("person-preview", [
  { orgId: "preview-company", role: "candidate" }, { orgId: "preview-company", role: "staff" },
  { orgId: "preview-campus", role: "recruiter" },
]);
const login = { ...rig.app, navigation: createContextNavigation(rig.sessions, navigationStore), web: {
  origin: "http://terminal.local:4173",
  returnTo: rig.config.allowedReturnUrls[1],
  async readProfile(id) { return { id, displayName: "Noor — synthetic preview", email: "noor@example.invalid" }; },
} };
const gateway = createGatewayServer(undefined, undefined, undefined, login);
const ownPage = await profileDocument(await login.profile({ sessionId: session }), login);
const attribute = (html) => html.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const preview = createServer((request, response) => {
  if (request.url === "/__preview/responsive") {
    // Isolated iframe viewports exercise the unchanged production stylesheet.
    // This is a layout lab, not mobile-device or secure-cookie/OIDC evidence.
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    const largeText = ownPage.html.replace("</head>", "<style>:root{font-size:200% !important}</style></head>");
    response.end(`<!doctype html><html lang="en"><head><title>Synthetic responsive QA</title></head><body><h1>Synthetic responsive QA — not a deployment</h1><div style="display:flex;gap:24px;flex-wrap:wrap">${[
      ["Mobile welcome", renderLanding(login)], ["Mobile profile", ownPage.html], ["Profile at 200% text", largeText],
    ].map(([title, html]) => `<section><h2>${title}</h2><iframe title="${title}" width="390" height="900" srcdoc="${attribute(html)}"></iframe></section>`).join("")}</div></body></html>`);
    return;
  }
  // Explicit visual fixture route only. The real /profile remains unauthenticated
  // unless a real session cookie is provided; HTTP tests exercise that boundary.
  if (request.url === "/__preview/profile") {
    request.url = "/profile";
    request.headers.cookie = `__Host-studenthub_session=${session}`;
  }
  if (request.url?.split("?", 1)[0] === "/__preview/workspace") {
    request.url = request.url.replace("/__preview/workspace", "/workspace");
    request.headers.cookie = `__Host-studenthub_session=${session}`;
  }
  gateway.emit("request", request, response);
});
const portIndex = process.argv.indexOf("--port");
const port = Number(portIndex >= 0 ? process.argv[portIndex + 1] : process.env.PORT ?? 4173);
preview.listen(port, "0.0.0.0", () => process.stdout.write(`Synthetic web preview listening on ${port}\n`));
