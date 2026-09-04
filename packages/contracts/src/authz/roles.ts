/**
 * Platform roles.
 *
 * The role set is deliberately small and closed: every product built on this
 * authorization contract (this platform is the reference implementation for
 * third-party businesses joining Universe) enforces the SAME roles, so a grant
 * issued by one product is meaningful in another. Adding a role is a contract
 * change and must be versioned, never ad-hoc.
 */
export const ROLES = [
  "candidate",
  "staff",
  "admin",
  "org-owner",
  "recruiter",
  "finance",
] as const;

export type Role = (typeof ROLES)[number];

/** Named accessors so call sites never scatter string literals. */
export const ROLE = {
  CANDIDATE: "candidate",
  STAFF: "staff",
  ADMIN: "admin",
  ORG_OWNER: "org-owner",
  RECRUITER: "recruiter",
  FINANCE: "finance",
} as const satisfies Readonly<Record<string, Role>>;

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}
