import { createHash, randomBytes } from "node:crypto";

export const SESSION_COOKIE = "__Host-studenthub_session";
export const BROWSER_COOKIE = "__Host-studenthub_browser";
export const EMBED_COOKIE = "__Host-studenthub_embed";

/** `__Host-` rules: Path=/, Secure, no Domain. Route scope is enforced server-side. */
const ATTRIBUTES = "Path=/; HttpOnly; Secure; SameSite=Lax";

export function setCookie(name: string, value: string): string {
  return `${name}=${value}; ${ATTRIBUTES}`;
}

/** Clearing sends the identical name, path and attributes with Max-Age=0. */
export function clearCookie(name: string): string {
  return `${name}=; ${ATTRIBUTES}; Max-Age=0`;
}

/** Only exact 32-byte base64url references are accepted; anything else is absent. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  let found: string | undefined;
  for (const item of header?.split(";") ?? []) {
    const [key, ...rest] = item.trim().split("=");
    const candidate = rest.join("=");
    if (key !== name) continue;
    // A duplicated cookie name is ambiguous (cookie tossing); treat it as absent.
    if (found !== undefined) return undefined;
    if (!/^[A-Za-z0-9_-]{43}$/.test(candidate)) return undefined;
    found = candidate;
  }
  return found;
}

export function newReference(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Per-transaction value for state-changing embed requests, derived from the
 * HttpOnly embed reference. Same-site siblings can send the cookie but cannot
 * read it, so they cannot produce this value; the exact Origin is checked too.
 */
export function requestToken(embedRef: string): string {
  return createHash("sha256").update(`studenthub.embed.request\u0000${embedRef}`).digest("base64url");
}
