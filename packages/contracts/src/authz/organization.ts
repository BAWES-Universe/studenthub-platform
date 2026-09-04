/**
 * Organizations form a parent/sub-company tree. The tree is the ONLY source of
 * hierarchy used by the resolver; it is declared data, not hardcoded rules.
 */
export interface Organization {
  readonly id: string;
  readonly name: string;
  /** Omitted for root organizations (no parent). */
  readonly parentOrgId?: string;
}

export function createOrganization(input: {
  readonly id: string;
  readonly name: string;
  readonly parentOrgId?: string;
}): Organization {
  const { id, name, parentOrgId } = input;
  if (id.trim().length === 0) throw new TypeError("organization id must be a non-empty string");
  if (name.trim().length === 0) throw new TypeError("organization name must be a non-empty string");
  if (parentOrgId === id) throw new TypeError(`organization '${id}' cannot be its own parent`);
  return Object.freeze(
    parentOrgId === undefined ? { id, name } : { id, name, parentOrgId },
  );
}

export interface OrgIndex {
  readonly byId: ReadonlyMap<string, Organization>;
  readonly childrenByParent: ReadonlyMap<string, readonly string[]>;
}

export function indexOrganizations(organizations: readonly Organization[]): OrgIndex {
  const byId = new Map<string, Organization>();
  const childrenByParent = new Map<string, string[]>();
  for (const org of organizations) {
    byId.set(org.id, org);
    if (org.parentOrgId !== undefined) {
      const siblings = childrenByParent.get(org.parentOrgId) ?? [];
      siblings.push(org.id);
      childrenByParent.set(org.parentOrgId, siblings);
    }
  }
  for (const [parent, children] of childrenByParent) children.sort();
  return Object.freeze({ byId, childrenByParent });
}

/** Ancestor chain of `orgId` including itself, nearest first. Cycle-safe. */
export function ancestorOrgIdsIncludingSelf(
  organizations: readonly Organization[],
  orgId: string,
): readonly string[] {
  const byId = indexOrganizations(organizations).byId;
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: Organization | undefined = byId.get(orgId);
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current.id);
    current = current.parentOrgId === undefined ? undefined : byId.get(current.parentOrgId);
  }
  return chain;
}

/** Every org in the subtree rooted at `ancestorId`, including itself. */
export function descendantOrgIdsIncludingSelf(
  organizations: readonly Organization[],
  ancestorId: string,
): readonly string[] {
  const { childrenByParent } = indexOrganizations(organizations);
  const out: string[] = [];
  const stack = [ancestorId];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    out.push(current);
    for (const child of childrenByParent.get(current) ?? []) stack.push(child);
  }
  return out;
}

/** True when `descendantId` is `ancestorId` itself or below it in the tree. */
export function isSameOrDescendantOf(
  organizations: readonly Organization[],
  descendantId: string,
  ancestorId: string,
): boolean {
  return ancestorOrgIdsIncludingSelf(organizations, descendantId).includes(ancestorId);
}
