import { InMemoryAuthzStore, createOrganization, createPrincipal } from "@studenthub/contracts";
import { CivilIdError } from "./format.js";
import type { CivilIdAudit, CivilIdDependencies, CivilIdRow, CivilIdStore, CivilIdTransaction, OcrJob } from "./verification.js";

/** Synthetic only. No document samples or real identities. */
export const CIVIL_ID_FIXTURES = Object.freeze({
  P: "candidate-P", Q: "candidate-Q", S: "staff-S", U: "staff-U",
  number: "289010112345", otherNumber: "289010112346", bhNumber: "890112345",
  expiryDate: "2026-10-05", now: "2026-10-05T20:59:00.000Z",
});

/** Transactional fake, with rollback and serialization; not runtime persistence. */
export class InMemoryCivilIdStore implements CivilIdStore {
  rows = new Map<string, CivilIdRow>();
  jobs = new Map<string, OcrJob>();
  audits: CivilIdAudit[] = [];
  private tail: Promise<void> = Promise.resolve();
  async transaction<T>(_keys: { candidateRef?: string; jobId?: string }, work: (tx: CivilIdTransaction) => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const rows = structuredClone(this.rows), jobs = structuredClone(this.jobs), audits = structuredClone(this.audits);
    try {
      const result = await work({
        read: async (id) => structuredClone(rows.get(id)),
        write: async (row) => {
          if ([...rows.values()].some((other) => other.candidateRef !== row.candidateRef
            && !other.candidateDeleted && !row.candidateDeleted
            && other.countryCode === row.countryCode && other.civilIdNumber === row.civilIdNumber)) {
            throw new CivilIdError("civil_id_duplicate");
          }
          rows.set(row.candidateRef, structuredClone(row));
        },
        readJob: async (id) => structuredClone(jobs.get(id)),
        writeJob: async (job) => { jobs.set(job.jobId, structuredClone(job)); },
        audit: async (event) => { audits.push(structuredClone(event)); },
        listReview: async () => structuredClone([...rows.values()].filter((row) => row.needVerification && !row.candidateDeleted)
          .sort((a, b) => a.candidateRef.localeCompare(b.candidateRef))),
      });
      this.rows = rows; this.jobs = jobs; this.audits = audits;
      return result;
    } finally { release(); }
  }
}

export async function civilIdFixture(store: CivilIdStore = new InMemoryCivilIdStore()): Promise<CivilIdDependencies & { authz: InMemoryAuthzStore }> {
  const f = CIVIL_ID_FIXTURES;
  const authz = new InMemoryAuthzStore({
    organizations: [createOrganization({ id: "root", name: "Synthetic operator" }),
      createOrganization({ id: "company", name: "Synthetic company", parentOrgId: "root" })],
    principals: [f.P, f.Q, f.S, f.U, "admin", "self-staff"].map((id) => createPrincipal({ id })),
  });
  await authz.grantMany(f.S, [{ orgId: "root", role: "staff", scope: "subtree" }]);
  await authz.grantMany(f.U, [{ orgId: "company", role: "staff", scope: "subtree" }]);
  await authz.grantMany("admin", [{ orgId: "root", role: "admin", scope: "subtree" }]);
  await authz.grantMany("self-staff", [{ orgId: "root", role: "staff", scope: "self" }]);
  return { store, authz, now: () => new Date(f.now), links: {
    resolveLink: async (principal) => (principal === f.P || principal === f.Q)
      ? { kind: "linked", candidateRef: principal } : { kind: "missing" },
  } };
}
