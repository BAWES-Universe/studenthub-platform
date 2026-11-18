import { BlockList, isIP } from "node:net";
import { DEFAULT_OPERATOR_ORG_IDS } from "@studenthub/organizations";
import type { HeldGrant } from "./grant-catalogue.js";
import { REASON_MAX, REASON_MIN } from "./grant-change.js";

/**
 * Access lane A8: per-person limits on writes and uploads, shared across the
 * person's sessions, and an admin-managed block list of network addresses.
 *
 * The client address is the socket's peer. Forwarding headers are read only
 * when that peer is one of the configured trusted proxies, and then from the
 * right: the first address that is not itself a trusted proxy is the client.
 */

export type LimitKind = "write" | "upload";

export interface Limit {
  readonly max: number;
  readonly windowSeconds: number;
}

/** Generous for a person, tight for a script: 120 writes per 10 minutes, 30 uploads per hour. */
export const PERSON_LIMITS: Readonly<Record<LimitKind, Limit>> = Object.freeze({
  write: Object.freeze({ max: 120, windowSeconds: 600 }),
  upload: Object.freeze({ max: 30, windowSeconds: 3600 }),
});

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const UPLOAD_TYPES = new Set(["multipart/form-data", "application/octet-stream", "application/pdf"]);

/**
 * The media type of a Content-Type header, without parameters, trimmed and
 * lower-cased: " Application/PDF ; charset=binary" is "application/pdf".
 */
export function mediaType(contentType: string | readonly string[] | undefined): string {
  const value = Array.isArray(contentType) ? contentType[0] ?? "" : (contentType as string | undefined) ?? "";
  return value.split(";", 1)[0]!.trim().toLowerCase();
}

/** Which limit a request counts against, or undefined for a read. */
export function limitKind(method: string | undefined, contentType: string | readonly string[] | undefined): LimitKind | undefined {
  if (!method || !WRITE_METHODS.has(method.toUpperCase())) return undefined;
  const type = mediaType(contentType);
  return UPLOAD_TYPES.has(type) || type.startsWith("image/") ? "upload" : "write";
}

/** The start of the fixed window `now` falls in, in epoch seconds. */
export function windowStart(nowEpochSeconds: number, limit: Limit): number {
  return nowEpochSeconds - (nowEpochSeconds % limit.windowSeconds);
}

export type LimitDecision = { readonly kind: "allow" } | { readonly kind: "limited"; readonly retryAfterSeconds: number };

export function decideLimit(count: number, nowEpochSeconds: number, limit: Limit): LimitDecision {
  if (count <= limit.max) return { kind: "allow" };
  return { kind: "limited", retryAfterSeconds: Math.max(1, windowStart(nowEpochSeconds, limit) + limit.windowSeconds - nowEpochSeconds) };
}

// --- Addresses -----------------------------------------------------------------

export interface Cidr {
  readonly address: string;
  readonly prefix: number;
  readonly family: "ipv4" | "ipv6";
}

/** Strips the IPv4-mapped IPv6 form so one address has one spelling. */
export function normalizeAddress(raw: string): string | undefined {
  const value = raw.trim();
  const address = unmapped(value) ?? value;
  return isIP(address) ? address.toLowerCase() : undefined;
}

/** The IPv4 address inside an IPv4-mapped IPv6 address, in either spelling (::ffff:203.0.113.9 or ::ffff:cb00:7109). */
function unmapped(value: string): string | undefined {
  const dotted = /^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (dotted && isIP(value) === 6) return dotted[1]!;
  const hex = /^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(value);
  if (!hex || isIP(value) !== 6) return undefined;
  const high = parseInt(hex[1]!, 16), low = parseInt(hex[2]!, 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

/** "203.0.113.7", "203.0.113.0/24" or "2001:db8::/32"; host bits must be zero. */
export function parseCidr(raw: string): Cidr | undefined {
  const [addressPart, prefixPart, extra] = raw.trim().split("/");
  if (extra !== undefined || addressPart === undefined) return undefined;
  const address = normalizeAddress(addressPart);
  if (!address) return undefined;
  const family = isIP(address) === 4 ? "ipv4" : "ipv6";
  const width = family === "ipv4" ? 32 : 128;
  if (prefixPart !== undefined && !/^\d{1,3}$/.test(prefixPart)) return undefined;
  // A mapped address keeps its IPv6 prefix (PostgreSQL renders ::ffff:cb00:7100/120
  // as ::ffff:203.0.113.0/120): count it from the IPv4 part, so /120 is /24.
  const mapped = family === "ipv4" && isIP(addressPart.trim()) === 6;
  if (mapped && prefixPart !== undefined && Number(prefixPart) < 96) return undefined;
  const prefix = prefixPart === undefined ? width : Number(prefixPart) - (mapped ? 96 : 0);
  if (prefix < (family === "ipv4" ? 8 : 16) || prefix > width) return undefined;
  // Host bits must be zero, so one network has one spelling.
  if (!sameNetwork(address, prefix, family)) return undefined;
  return Object.freeze({ address, prefix, family });
}

function sameNetwork(address: string, prefix: number, family: "ipv4" | "ipv6"): boolean {
  const bits = family === "ipv4" ? ipv4Bits(address) : ipv6Bits(address);
  return bits !== undefined && bits.slice(prefix).every((bit) => bit === 0);
}

function ipv4Bits(address: string): number[] | undefined {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
  return parts.flatMap((part) => [...part.toString(2).padStart(8, "0")].map(Number));
}

function ipv6Bits(address: string): number[] | undefined {
  const [head, tail] = address.split("::");
  const groups = (part: string | undefined) => (part ? part.split(":") : []);
  const left = groups(head), right = groups(tail);
  // A dotted tail (::192.0.2.1, as PostgreSQL renders it) is the last two groups.
  const last = tail === undefined ? left : right;
  const dotted = last.length ? /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(last[last.length - 1]!) : null;
  if (dotted) {
    const octets = dotted.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return undefined;
    last.splice(last.length - 1, 1, ((octets[0]! << 8) | octets[1]!).toString(16), ((octets[2]! << 8) | octets[3]!).toString(16));
  }
  if ([...left, ...right].some((group) => group.includes("."))) return undefined;
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? left.length !== 8 : missing < 1) return undefined;
  const all = [...left, ...Array(tail === undefined ? 0 : missing).fill("0"), ...right];
  if (all.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return undefined;
  return all.flatMap((group) => [...parseInt(group, 16).toString(2).padStart(16, "0")].map(Number));
}

export function cidrText(cidr: Cidr): string {
  return `${cidr.address}/${cidr.prefix}`;
}

/**
 * One BlockList per family. Node's BlockList matches an IPv4 address against
 * IPv6 rules through the mapped form, so a single list would let an IPv6 rule
 * such as ::/16 cover every IPv4 caller. Mapped addresses are normalized to
 * IPv4 before they get here, so each family is checked only against its own.
 */
export interface AddressList {
  readonly ipv4: BlockList;
  readonly ipv6: BlockList;
}

export function blockListOf(cidrs: readonly Cidr[]): AddressList {
  const list = { ipv4: new BlockList(), ipv6: new BlockList() };
  for (const cidr of cidrs) list[cidr.family].addSubnet(cidr.address, cidr.prefix, cidr.family);
  return Object.freeze(list);
}

export function listed(list: AddressList, address: string): boolean {
  const family = isIP(address);
  if (family === 4) return list.ipv4.check(address, "ipv4");
  if (family === 6) return list.ipv6.check(address, "ipv6");
  return false;
}

/** The client address: the socket peer, or, behind a trusted proxy, the rightmost untrusted forwarded address. */
export function clientAddress(remoteAddress: string | undefined, forwardedFor: string | string[] | undefined, trustedProxies: AddressList): string | undefined {
  const peer = remoteAddress ? normalizeAddress(remoteAddress) : undefined;
  if (!peer || !listed(trustedProxies, peer)) return peer;
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor ?? "";
  const hops = header.trim() === "" ? [] : header.split(",").map((hop) => hop.trim());
  for (let index = hops.length - 1; index >= 0; index -= 1) {
    const hop = normalizeAddress(hops[index]!);
    if (!hop) return peer; // A malformed hop ends the trusted chain: never guess past it.
    if (!listed(trustedProxies, hop)) return hop;
  }
  return peer;
}

/** GATEWAY_TRUSTED_PROXIES: comma-separated addresses or CIDRs; anything malformed refuses to start. */
export function parseTrustedProxies(raw: string | undefined): readonly Cidr[] {
  if (raw === undefined || raw.trim() === "") return [];
  return raw.split(",").map((item) => {
    const cidr = parseCidr(item);
    if (!cidr) throw new Error("GATEWAY_TRUSTED_PROXIES must list addresses or CIDRs");
    return cidr;
  });
}

// --- Block list changes ----------------------------------------------------------

export interface BlockChangeRequest {
  readonly action: "block" | "unblock";
  readonly cidr: Cidr;
  readonly reason: string;
}

export function parseBlockChange(raw: Readonly<Record<string, unknown>>): BlockChangeRequest | undefined {
  const { action, cidr, reason } = raw;
  if (action !== "block" && action !== "unblock") return undefined;
  if (typeof cidr !== "string" || typeof reason !== "string") return undefined;
  const parsed = parseCidr(cidr);
  if (!parsed) return undefined;
  const trimmed = reason.trim().replace(/\r\n?/g, "\n");
  const length = [...trimmed].length;
  if (length < REASON_MIN || length > REASON_MAX) return undefined;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) return undefined;
  return Object.freeze({ action, cidr: parsed, reason: trimmed });
}

/** Only an operator administrator manages the block list. */
export function mayManageBlocks(callerGrants: readonly HeldGrant[], operatorOrgIds: readonly string[] = DEFAULT_OPERATOR_ORG_IDS): boolean {
  return callerGrants.some((grant) => operatorOrgIds.includes(grant.orgId) && grant.role === "admin");
}

export interface IpBlockRow {
  readonly id: string;
  readonly cidr: string;
  readonly reason: string;
  readonly createdAt: string;
  readonly createdBy: { readonly principalId: string; readonly displayName: string | null };
}

export type BlockChangeOutcome =
  | { readonly kind: "blocked" | "unblocked" }
  | { readonly kind: "refused"; readonly reason: "already_blocked" | "not_blocked" | "own_address" | "not_allowed" };

/** The Postgres side of A8. */
export interface AbuseStore {
  /** Counts one request against the person's window and answers the count including it. */
  hit(principalId: string, kind: LimitKind, windowStartEpochSeconds: number): Promise<number>;
  /** The live block list. */
  blocks(): Promise<readonly IpBlockRow[]>;
  /** Re-reads the caller's grants inside the write's transaction and changes nothing unless `mayChange` holds. */
  changeBlock(callerId: string, request: BlockChangeRequest, mayChange: (callerGrants: readonly HeldGrant[]) => boolean): Promise<BlockChangeOutcome>;
}
