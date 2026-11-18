import { randomBytes } from "node:crypto";
import type { GrantScope } from "@studenthub/contracts";
import type { GrantOption, HeldGrant } from "./grant-catalogue.js";
import {
  INVITATION_ACCEPTED_REASON,
  INVITATION_TTL_MS,
  MEMBER_REMOVED_REASON,
  decideAccept,
  decideInvite,
  decideRemove,
  hashInvitationToken,
  isInvitationTokenShape,
  newInvitationToken,
  normalizeInvitationEmail,
  teamCatalogue,
  teamReadOnly,
  type AcceptSnapshot,
  type InvitationRefusal,
  type InviteSnapshot,
  type RemoveSnapshot,
} from "./invitations.js";
import { NO_SEND_INVITATION_MAILER, type InvitationMailer } from "./invitation-mail.js";
import { STORE_ACCESS_GRANTED_REASON, STORE_ACCESS_REMOVED_REASON, STORE_MANAGER, decideStoreAccessChange, mayManageStoreAccess, type StoreAccessRefusal, type StoreOfferSnapshot } from "./store-access.js";

/**
 * Access lane A2: the Team page and invitations, over a store port that runs
 * each write in one transaction and calls back into the pure decisions with
 * what it read inside that transaction.
 */

type Refused<R extends string> = { readonly kind: "refused"; readonly reason: R };

export interface TeamMember {
  readonly principalId: string;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly role: string;
  readonly scope: GrantScope;
}

export interface PendingInvitation {
  readonly id: string;
  readonly store: null | { readonly storeId: string; readonly name: string };
  readonly email: string;
  readonly role: string;
  readonly scope: GrantScope;
  readonly invitedBy: { readonly principalId: string; readonly displayName: string | null };
  readonly expiresAt: string;
}

export interface StoreManagerListRow {
  readonly principalId: string;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly storeId: string;
  readonly storeName: string;
}

export interface InvitationStore {
  context(callerId: string, orgId: string): Promise<{
    readonly callerGrants: readonly HeldGrant[];
    readonly organization: null | { readonly orgId: string; readonly name: string; readonly ancestors: readonly string[] };
  }>;
  team(orgId: string, now: Date): Promise<{
    readonly members: readonly TeamMember[]; readonly invitations: readonly PendingInvitation[];
    readonly storeManagers: readonly StoreManagerListRow[]; readonly stores: readonly { readonly storeId: string; readonly name: string }[];
  }>;
  invitation(tokenHash: string, now: Date): Promise<null | { readonly orgId: string; readonly orgName: string; readonly role: string; readonly scope: GrantScope; readonly storeName: string | null }>;
  invite<R extends string>(input: {
    readonly callerId: string; readonly orgId: string; readonly email: string; readonly role: string; readonly scope: GrantScope;
    readonly tokenHash: string; readonly now: Date; readonly ttlMs: number; readonly storeId?: string | null;
    readonly decide: (snapshot: InviteSnapshot) => { readonly kind: "ok" } | Refused<R>;
  }): Promise<{ readonly kind: "invited"; readonly id: string; readonly expiresAt: string } | Refused<R>>;
  revokeInvitation<R extends string>(input: {
    readonly callerId: string; readonly orgId: string; readonly invitationId: string; readonly now: Date;
    readonly decide: (snapshot: { readonly callerGrants: readonly HeldGrant[]; readonly orgAncestors: readonly string[] }) => { readonly kind: "ok" } | Refused<R>;
  }): Promise<{ readonly kind: "revoked" } | Refused<R | "not_found">>;
  accept(input: {
    readonly tokenHash: string; readonly principalId: string; readonly now: Date; readonly reason: string; readonly storeReason?: string;
    /** Read again once the store holds its locks; `now` is only the starting value. */
    readonly clock?: () => Date;
    readonly decide: (snapshot: AcceptSnapshot) => { readonly kind: "accept" } | { readonly kind: "invalid" } | { readonly kind: "wrong_address" };
  }): Promise<{ readonly kind: "accepted" | "already_held"; readonly orgId: string; readonly role: string; readonly scope: GrantScope; readonly storeId?: string } | { readonly kind: "invalid" } | { readonly kind: "wrong_address" }>;
  removeMember<R extends string>(input: {
    readonly callerId: string; readonly orgId: string; readonly targetId: string; readonly reason: string;
    readonly decide: (snapshot: RemoveSnapshot) => { readonly kind: "remove"; readonly roles: readonly string[] } | Refused<R>;
  }): Promise<{ readonly kind: "removed"; readonly roles: readonly string[] } | Refused<R>>;
  removeStoreManager<R extends string>(input: {
    readonly callerId: string; readonly orgId: string; readonly storeId: string; readonly targetId: string; readonly reason: string; readonly now: Date;
    readonly decide: (snapshot: StoreOfferSnapshot) => { readonly kind: "ok" } | Refused<R>;
  }): Promise<{ readonly kind: "removed" } | Refused<R | "not_found">>;
}

export interface TeamView {
  readonly orgId: string;
  readonly orgName: string;
  /** True for an owner; false for operator staff or admin, who see it read-only. */
  readonly writable: boolean;
  readonly options: readonly GrantOption[];
  readonly members: readonly TeamMember[];
  readonly invitations: readonly PendingInvitation[];
  /** A4: true when the caller may offer and take away store manager access (owners, staff, admin). */
  readonly storesWritable: boolean;
  readonly storeManagers: readonly StoreManagerListRow[];
  readonly stores: readonly { readonly storeId: string; readonly name: string }[];
}

export type InviteResult =
  | { readonly kind: "invited"; readonly link: string; readonly mailed: boolean; readonly email: string; readonly expiresAt: string }
  | Refused<InvitationRefusal | "invalid_email">;

export interface CompanyTeamService {
  /** Null when the caller may not see this company's Team page (answered as an unknown path). */
  team(callerId: string, orgId: string): Promise<TeamView | null>;
  invite(callerId: string, orgId: string, input: { readonly email: string; readonly role: string; readonly scope: string; readonly storeId?: string | null }, origin: string): Promise<InviteResult>;
  revoke(callerId: string, orgId: string, invitationId: string): Promise<{ readonly kind: "revoked" } | Refused<InvitationRefusal>>;
  remove(callerId: string, orgId: string, targetId: string): Promise<{ readonly kind: "removed"; readonly roles: readonly string[] } | Refused<InvitationRefusal>>;
  /** A4: take away one person's store manager access to one store of this company. */
  removeStoreManager(callerId: string, orgId: string, storeId: string, targetId: string): Promise<{ readonly kind: "removed" } | Refused<StoreAccessRefusal>>;
  /** What the invitation page may show, never the address; null for every dead link. */
  invitation(token: string): Promise<null | { readonly orgName: string; readonly role: string; readonly scope: GrantScope; readonly storeName: string | null }>;
  accept(token: string, principalId: string): Promise<{ readonly kind: "accepted" | "already_held"; readonly orgId: string; readonly role: string; readonly storeId?: string } | { readonly kind: "invalid" } | { readonly kind: "wrong_address" }>;
}

export function createCompanyTeamService(options: {
  readonly store: InvitationStore;
  readonly mailer?: InvitationMailer;
  readonly now?: () => Date;
  readonly entropy?: (length: number) => Buffer;
}): CompanyTeamService {
  const { store } = options;
  const mailer = options.mailer ?? NO_SEND_INVITATION_MAILER;
  const now = options.now ?? (() => new Date());
  const entropy = options.entropy ?? randomBytes;

  const service: CompanyTeamService = {
    async team(callerId: string, orgId: string): Promise<TeamView | null> {
      const context = await store.context(callerId, orgId);
      const org = context.organization;
      if (!org) return null;
      const options = teamCatalogue(context.callerGrants, org.orgId, org.ancestors);
      const writable = options.length > 0;
      if (!writable && !teamReadOnly(context.callerGrants, org.orgId, org.ancestors)) return null;
      const team = await store.team(org.orgId, now());
      return Object.freeze({
        orgId: org.orgId, orgName: org.name, writable, options, members: team.members, invitations: team.invitations,
        storesWritable: mayManageStoreAccess(context.callerGrants, org.orgId, org.ancestors), storeManagers: team.storeManagers, stores: team.stores,
      });
    },

    async invite(callerId, orgId, input, origin): Promise<InviteResult> {
      const email = normalizeInvitationEmail(input.email);
      if (!email) return { kind: "refused", reason: "invalid_email" };
      if (input.scope !== "self" && input.scope !== "subtree") return { kind: "refused", reason: "role_not_allowed" };
      const storeId = input.role === STORE_MANAGER ? input.storeId ?? null : null;
      if (input.role === STORE_MANAGER && (!storeId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(storeId))) return { kind: "refused", reason: "unknown_store" };
      const { token, tokenHash } = newInvitationToken(entropy);
      const at = now();
      const result = await store.invite({
        callerId, orgId, email, role: input.role, scope: input.scope, tokenHash, now: at, ttlMs: INVITATION_TTL_MS, storeId,
        decide: (snapshot) => decideInvite(orgId, { role: input.role, scope: input.scope, storeId }, snapshot),
      });
      if (result.kind === "refused") return result;
      const link = new URL(`/invitations/${token}`, origin).href;
      // The invitation is saved: whatever happens to the mail, the owner gets the link.
      let mailed = false;
      try {
        const context = await store.context(callerId, orgId);
        mailed = await mailer.send({ to: email, organizationName: context.organization?.name ?? "", role: input.role, link, expiresAt: result.expiresAt });
      } catch {
        mailed = false;
      }
      return { kind: "invited", link, mailed, email, expiresAt: result.expiresAt };
    },

    async revoke(callerId, orgId, invitationId) {
      return store.revokeInvitation<InvitationRefusal>({
        callerId, orgId, invitationId, now: now(),
        decide: (snapshot) => teamCatalogue(snapshot.callerGrants, orgId, snapshot.orgAncestors).length > 0
          ? { kind: "ok" as const } : { kind: "refused" as const, reason: "not_owner" as InvitationRefusal },
      });
    },

    async remove(callerId, orgId, targetId) {
      return store.removeMember({ callerId, orgId, targetId, reason: MEMBER_REMOVED_REASON, decide: (snapshot) => decideRemove(orgId, snapshot) });
    },

    async removeStoreManager(callerId, orgId, storeId, targetId) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(storeId)) return { kind: "refused", reason: "unknown_store" };
      return store.removeStoreManager<StoreAccessRefusal>({
        callerId, orgId, storeId, targetId, reason: STORE_ACCESS_REMOVED_REASON, now: now(),
        decide: (snapshot) => decideStoreAccessChange(orgId, snapshot),
      });
    },

    async invitation(token) {
      if (!isInvitationTokenShape(token)) return null;
      const found = await store.invitation(hashInvitationToken(token), now());
      return found ? { orgName: found.orgName, role: found.role, scope: found.scope, storeName: found.storeName } : null;
    },

    async accept(token, principalId) {
      if (!isInvitationTokenShape(token)) return { kind: "invalid" };
      const outcome = await store.accept({
        tokenHash: hashInvitationToken(token), principalId, now: now(), clock: now, reason: INVITATION_ACCEPTED_REASON, storeReason: STORE_ACCESS_GRANTED_REASON, decide: decideAccept,
      });
      return outcome.kind === "accepted" || outcome.kind === "already_held"
        ? { kind: outcome.kind, orgId: outcome.orgId, role: outcome.role, ...(outcome.storeId ? { storeId: outcome.storeId } : {}) } : outcome;
    },
  };
  return Object.freeze(service);
}
