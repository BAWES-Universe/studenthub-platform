import type { IncomingMessage } from "node:http";
import type { SessionStore } from "@studenthub/login-contract";
import { managedStores, openManagedStore, type ManagedStoreRow } from "../../../../packages/access/src/index.js";
import { escapeHtml, sessionCookie, type AccessPageWriter } from "./admin-access.js";

/**
 * Access lane A4: a store manager's workspace.
 *
 * GET /workspace/my-stores          the stores this person manages now
 * GET /workspace/stores/{storeId}   one of them
 *
 * These pages read only the person's own store grant rows (with the store and
 * company state read in the same query). They never read grants and never
 * call resolveActiveContext, so a company role neither opens nor hides a
 * store here. Any store the person does not manage answers the unknown-path 404.
 */

export interface StoreManagerPorts {
  readonly sessions: Pick<SessionStore, "get">;
  readonly stores: { rows(principalId: string): Promise<readonly ManagedStoreRow[]> };
}

const STORE = /^\/workspace\/stores\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const e = escapeHtml;
const brand = `<a class="brand" href="/" aria-label="StudentHub home"><span class="brand-mark" aria-hidden="true">s</span>studenthub<span class="brand-dot" aria-hidden="true">.</span></a>`;

function layout(main: string, current: "list" | "store"): string {
  return `<header class="topbar">${brand}<form action="/logout" method="post"><button class="sign-out" type="submit">Sign out</button></form></header><div class="workspace"><aside class="sidebar"><div class="eyebrow">YOUR WORKSPACE</div><nav aria-label="Workspace"><a class="nav-item" href="/profile">My profile</a><a class="nav-item" href="/workspace">Workspaces</a><a class="nav-item${current === "list" ? " active" : ""}" href="/workspace/my-stores"${current === "list" ? ' aria-current="page"' : ""}>My stores</a></nav></aside><main id="main" class="profile-main">${main}<footer class="profile-footer">StudentHub · Connected by Universe</footer></main></div>`;
}

const details = (store: ManagedStoreRow): string =>
  `<dl class="org-facts"><dt>Company</dt><dd>${e(store.orgName)}</dd><dt>Location</dt><dd>${store.location ? e(store.location) : "Not recorded"}</dd><dt>Brand</dt><dd>${store.brand ? e(store.brand) : "Not recorded"}</dd><dt>Mall</dt><dd>${store.mall ? e(store.mall) : "Not recorded"}</dd></dl>`;

export function renderMyStores(stores: readonly ManagedStoreRow[]): string {
  const body = stores.length === 0
    ? `<p class="empty-contexts" role="status">You don’t manage a store. A company owner can invite you as a store manager.</p>`
    : `<nav class="context-list" aria-label="Your stores">${stores.map((store) =>
      `<a class="context-option" href="/workspace/stores/${e(store.storeId)}"><span>${e(store.name)}</span><strong>${e(store.orgName)}</strong><span aria-hidden="true">→</span></a>`).join("")}</nav>`;
  return layout(`<div class="profile-heading"><h1>My stores<span class="accent">.</span></h1></div>${body}`, "list");
}

export function renderManagedStore(store: ManagedStoreRow): string {
  return layout(`<div class="profile-heading"><div><div class="eyebrow">STORE MANAGER</div><h1>${e(store.name)}<span class="accent">.</span></h1></div></div>${details(store)}<p><a class="text-link" href="/workspace/my-stores">All my stores</a></p>`, "store");
}

export async function handleStoreManager(req: IncomingMessage, ports: StoreManagerPorts | undefined, write: AccessPageWriter): Promise<boolean> {
  if (!ports || req.method !== "GET") return false;
  const path = new URL(req.url ?? "/", "http://gateway.invalid").pathname;
  const match = STORE.exec(path);
  if (path !== "/workspace/my-stores" && !match) return false;
  const session = sessionCookie(req.headers.cookie);
  const principalId = session ? (await ports.sessions.get(session))?.personId : undefined;
  if (!principalId) return false;
  const rows = await ports.stores.rows(principalId);
  if (!match) {
    write(200, "My stores", renderMyStores(managedStores(principalId, rows)));
    return true;
  }
  const store = openManagedStore(principalId, match[1]!, rows);
  if (!store) return false;
  write(200, store.name, renderManagedStore(store));
  return true;
}
