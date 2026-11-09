import type { ServerResponse } from "node:http";
import { isIP } from "node:net";

const validatedConfig = Symbol("validated universe embed configuration");
const validatedPolicy = Symbol("validated universe response policy");

export interface EmbedResponsePolicy {
  readonly [validatedPolicy]: true;
  readonly headers: Readonly<Record<string, string>>;
}

export interface UniverseEmbedConfig {
  readonly [validatedConfig]: true;
  readonly origin: string;
  readonly host: string;
  readonly mainOrigin: string;
  readonly enabled: boolean;
  readonly ancestors: readonly string[];
  readonly callbackUrl?: string;
}

const BASE_CSP = "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'";
const commonHeaders = {
  "cache-control": "no-store",
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "vary": "Accept",
};

/** These headers apply only to the reserved host, never to ordinary responses. */
export const APP_POLICY: EmbedResponsePolicy = Object.freeze({
  [validatedPolicy]: true as const,
  headers: Object.freeze({ ...commonHeaders,
    "content-security-policy": `${BASE_CSP}; frame-ancestors 'none'`,
    "x-frame-options": "DENY",
  }),
});

/** Parse an authority, not a URL. Do not let URL parsing repair malformed Host. */
export function canonicalEmbedHost(value: string, scheme: "https:" | "http:" = "https:"): string | undefined {
  if (!value || value !== value.trim()) return undefined;
  let hostname: string;
  let portText: string | undefined;
  if (value.startsWith("[")) {
    const match = /^\[([0-9a-fA-F:.]+)\](?::([0-9]+))?$/.exec(value);
    if (!match || isIP(match[1]!) !== 6) return undefined;
    hostname = new URL(`${scheme}//[${match[1]}]`).hostname;
    portText = match[2];
  } else {
    const match = /^([a-zA-Z0-9.-]+)(?::([0-9]+))?$/.exec(value);
    if (!match) return undefined;
    hostname = match[1]!.toLowerCase();
    if (hostname.endsWith("..")) return undefined;
    if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);
    if (hostname.length > 253 || !hostname.split(".").every((label) =>
      label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return undefined;
    // Reject ambiguous legacy numeric-address spellings, rather than comparing
    // one spelling here and letting a downstream URL parser interpret another.
    try {
      if (new URL(`${scheme}//${hostname}`).hostname !== hostname) return undefined;
    } catch { return undefined; }
    portText = match[2];
  }
  const port = portText === undefined ? undefined : Number(portText);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) return undefined;
  return hostname + (port === undefined || port === (scheme === "https:" ? 443 : 80) ? "" : `:${port}`);
}

function fail(): never {
  // Do not include environment values (or accidentally supplied credentials).
  throw new Error("Invalid Universe embed configuration");
}

function origin(value: string, allowHttp = false): { origin: string; host: string } {
  const match = /^(https?:)\/\/([^/?#]+)$/i.exec(value);
  if (!match || (!allowHttp && match[1]!.toLowerCase() !== "https:")) return fail();
  const scheme = match[1]!.toLowerCase() as "http:" | "https:";
  const host = canonicalEmbedHost(match[2]!, scheme);
  if (!host) return fail();
  return { origin: `${scheme}//${host}`, host };
}

/** Empty/misspelled values are partial configuration, not an enablement bypass. */
export function createUniverseEmbedConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  mainOrigin?: string,
): UniverseEmbedConfig | undefined {
  const rawOrigin = env.UNIVERSE_EMBED_ORIGIN;
  const enabled = env.UNIVERSE_EMBED_ENABLED;
  const rawAncestors = env.UNIVERSE_EMBED_ANCESTORS;
  const rawCallback = env.UNIVERSE_EMBED_OIDC_CALLBACK_URL;
  if ([rawOrigin, enabled, rawAncestors, rawCallback].every((value) => value === undefined)) return undefined;
  if (rawOrigin === undefined || (enabled !== undefined && enabled !== "true" && enabled !== "false")) return fail();
  const embed = origin(rawOrigin);
  // The origin is trusted runtime configuration, never an incoming Host. With
  // no known main origin, separation cannot be established: refuse to start.
  if (!mainOrigin) return fail();
  const main = origin(mainOrigin, true);
  // The gate interprets Host using the embed scheme even behind TLS termination.
  // Refuse every main authority that would match there, including HTTP on 443.
  if (embed.host === canonicalEmbedHost(main.host)) return fail();
  const ancestors = rawAncestors === undefined ? [] : rawAncestors.split(",").map((value) => origin(value.trim()).origin);
  let callbackUrl: string | undefined;
  if (rawCallback !== undefined) {
    const match = /^(https:\/\/[^/?#]+)(\/[^?#]*)$/i.exec(rawCallback);
    if (!match || origin(match[1]!).origin !== embed.origin || /[\s\\]/.test(rawCallback)) return fail();
    const url = new URL(rawCallback);
    if (url.search || url.hash || url.username || url.password) return fail();
    callbackUrl = `${embed.origin}${url.pathname}`;
  }
  if (enabled === "true" && (ancestors.length === 0 || callbackUrl === undefined)) return fail();
  return Object.freeze({ [validatedConfig]: true as const, origin: embed.origin, host: embed.host,
    mainOrigin: main.origin, enabled: enabled === "true", ancestors: Object.freeze([...new Set(ancestors)]),
    ...(callbackUrl === undefined ? {} : { callbackUrl }),
  });
}

/** No string/header input can construct a frameable policy without validation. */
export function universeEmbedPolicy(config: UniverseEmbedConfig): EmbedResponsePolicy {
  if (!config[validatedConfig] || !config.enabled || config.ancestors.length === 0) return fail();
  return Object.freeze({ [validatedPolicy]: true as const, headers: Object.freeze({ ...commonHeaders,
    "content-security-policy": `${BASE_CSP}; frame-ancestors ${config.ancestors.join(" ")}; script-src 'self'; connect-src 'self'`,
  }) });
}

export function writeEmbedResponse(response: ServerResponse, status: number, body: string,
  contentType: string, policy: EmbedResponsePolicy = APP_POLICY,
  headers: Readonly<Record<string, string>> = {}): void {
  const additional = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  // A caller cannot add XFO to the embed display, nor remove it from app policy.
  delete additional["x-frame-options"];
  response.removeHeader("x-frame-options");
  response.writeHead(status, { ...additional, ...policy.headers, "content-type": contentType });
  response.end(body);
}
