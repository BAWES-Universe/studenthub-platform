import type { GrantScope } from "@studenthub/contracts";
import { DEFAULT_OPERATOR_ORG_IDS } from "@studenthub/organizations";
import {
  decideGrantChange,
  issueGrantToken,
  verifyGrantToken,
  type GrantChangeRequest,
  type GrantDecision,
  type GrantRefusal,
  type GrantSnapshot,
  type GrantToken,
} from "./grant-change.js";

/**
 * Access lane A1: the preview and confirm of one grant change over a store port.
 *
 * The store reads the snapshot and applies the change. For a confirm it does
 * both inside one transaction, re-running `decide` on what it read there, so
 * the caller's right and the target's state are those at commit time, not
 * those of the page that rendered the form.
 */
export interface AccessGrantWriteStore {
  snapshot(callerId: string, request: GrantChangeRequest): Promise<GrantSnapshot>;
  apply(input: {
    readonly callerId: string;
    readonly request: GrantChangeRequest;
    readonly tokenId: string;
    readonly expectedBefore: GrantScope | null;
    readonly decide: (snapshot: GrantSnapshot) => GrantDecision;
    readonly requestId?: string;
    /** The token's deadline in epoch milliseconds: the store refuses with token_expired once its locks are held past it. */
    readonly expiresAt?: number;
    readonly now?: () => number;
  }): Promise<GrantApplyOutcome>;
}

export type GrantApplyOutcome =
  | { readonly kind: "applied"; readonly before: GrantScope | null; readonly after: GrantScope | null }
  | { readonly kind: "unchanged" }
  | { readonly kind: "refused"; readonly reason: GrantRefusal };

export type GrantPreviewResult =
  | { readonly ok: true; readonly kind: "unchanged"; readonly current: GrantScope | null }
  | { readonly ok: true; readonly kind: "change"; readonly before: GrantScope | null; readonly after: GrantScope | null; readonly token: GrantToken }
  | { readonly ok: false; readonly reason: GrantRefusal };

export type GrantConfirmResult = GrantApplyOutcome;

export interface AccessGrantService {
  preview(callerId: string, request: GrantChangeRequest): Promise<GrantPreviewResult>;
  confirm(callerId: string, request: GrantChangeRequest, token: GrantToken, requestId?: string): Promise<GrantConfirmResult>;
}

export function createAccessGrantService(options: {
  readonly store: AccessGrantWriteStore;
  readonly secret: Buffer;
  readonly now?: () => Date;
  readonly entropy?: (length: number) => Buffer;
  readonly operatorOrgIds?: readonly string[];
}): AccessGrantService {
  const now = options.now ?? (() => new Date());
  const operatorOrgIds = options.operatorOrgIds ?? DEFAULT_OPERATOR_ORG_IDS;
  return {
    async preview(callerId, request) {
      const snapshot = await options.store.snapshot(callerId, request);
      const decision = decideGrantChange(callerId, request, snapshot, operatorOrgIds);
      if (decision.kind === "refused") return { ok: false, reason: decision.reason };
      if (decision.kind === "unchanged") return { ok: true, kind: "unchanged", current: snapshot.current };
      const token = issueGrantToken({
        secret: options.secret, callerId, request, before: decision.before, now: now(),
        ...(options.entropy ? { entropy: options.entropy } : {}),
      });
      return { ok: true, kind: "change", before: decision.before, after: decision.after, token };
    },
    async confirm(callerId, request, token, requestId) {
      const verified = verifyGrantToken({ secret: options.secret, token, callerId, request, now: now() });
      if (!verified.ok) return { kind: "refused", reason: verified.reason };
      return options.store.apply({
        callerId,
        request,
        tokenId: token.tokenId,
        expectedBefore: verified.before,
        decide: (snapshot) => decideGrantChange(callerId, request, snapshot, operatorOrgIds),
        expiresAt: Date.parse(token.expiresAt),
        now: () => now().getTime(),
        ...(requestId ? { requestId } : {}),
      });
    },
  };
}

/**
 * The read side the pages need. Every list is one query whatever its length.
 */
export interface AccessPerson {
  readonly principalId: string;
  readonly displayName: string | null;
  readonly email: string | null;
}

export interface AccessGrantRow {
  readonly orgId: string;
  readonly orgName: string;
  readonly role: string;
  readonly scope: GrantScope;
  /** Null for a grant made before the Access page existed. */
  readonly grantedBy: { readonly principalId: string; readonly displayName: string | null } | null;
  readonly grantedAt: string | null;
  readonly reason: string | null;
}

export interface AccessEventRow {
  readonly orgId: string;
  readonly orgName: string;
  readonly role: string;
  readonly scope: GrantScope;
  readonly action: "grant" | "revoke";
  readonly actor: { readonly principalId: string; readonly displayName: string | null };
  readonly reason: string;
  readonly occurredAt: string;
}

export interface AccessOrganization {
  readonly orgId: string;
  readonly name: string;
  readonly ancestors: readonly string[];
}

export interface OwnAccessRow {
  readonly orgId: string;
  readonly orgName: string;
  readonly role: string;
  readonly scope: GrantScope;
}

export interface AccessReadStore {
  callerGrants(callerId: string): Promise<readonly { readonly orgId: string; readonly role: string; readonly scope: string }[]>;
  findPeople(query: PeopleQuery): Promise<readonly AccessPerson[]>;
  person(principalId: string): Promise<AccessPerson | null>;
  grants(principalId: string): Promise<readonly AccessGrantRow[]>;
  history(principalId: string): Promise<readonly AccessEventRow[]>;
  findOrganizations(query: string): Promise<readonly AccessOrganization[]>;
  organization(orgId: string): Promise<AccessOrganization | null>;
  /** Live organizations among `orgIds`, in one read. */
  organizations(orgIds: readonly string[]): Promise<readonly AccessOrganization[]>;
  ownGrants(principalId: string): Promise<readonly OwnAccessRow[]>;
}

export const PEOPLE_LOOKUP_LIMIT = 25;
export const ORGANIZATION_LOOKUP_LIMIT = 25;
export const HISTORY_LIMIT = 50;

/** An exact email address, or a name prefix of at least 3 characters. */
export interface PeopleQuery { readonly kind: "email" | "name"; readonly value: string }

export function parsePeopleQuery(raw: string | null): PeopleQuery | undefined {
  const value = (raw ?? "").trim();
  if ([...value].length < 3 || [...value].length > 254) return undefined;
  if (value.includes("@")) return { kind: "email", value: value.toLowerCase() };
  return { kind: "name", value };
}
