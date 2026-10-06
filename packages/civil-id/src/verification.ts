import { createHash } from "node:crypto";
import { resolveActiveContext, resolvePrincipalId, type AuthzStore, type RequestIdentity } from "@studenthub/contracts";
import { principalAuditRef } from "@studenthub/db";
import { CIVIL_ID_DECISIONS, type CivilIdCountry } from "./decisions.js";
import { CivilIdError, normalizeCivilId, type CivilIdErrorCode } from "./format.js";
import { isCivilIdDate, isCivilIdValidOn } from "./expiry-gate.js";
import type { OcrPort } from "./ocr-port.js";

export interface CivilIdRow {
  candidateRef: string;
  civilIdNumber: string;
  countryCode: CivilIdCountry;
  expiryDate: string;
  needVerification: boolean;
  source: "ocr" | "manual" | "staff";
  candidateDeleted: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface OcrJob {
  jobId: string;
  candidateRef: string;
  status: "succeeded" | "failed";
  code: CivilIdErrorCode | null;
  expired: boolean | null;
  timeZone: string;
  occurredAt: string;
}
export interface CivilIdAudit {
  actorRef: string;
  candidateRefHash: string;
  jobRef: string | null;
  operation: "ocr" | "manual" | "confirm";
  outcome: "written" | "failed";
  code: CivilIdErrorCode | null;
  occurredAt: string;
}
export interface CivilIdTransaction {
  read(candidateRef: string): Promise<CivilIdRow | undefined>;
  write(row: CivilIdRow): Promise<void>;
  readJob(jobId: string): Promise<OcrJob | undefined>;
  writeJob(job: OcrJob): Promise<void>;
  audit(event: CivilIdAudit): Promise<void>;
  listReview(): Promise<readonly CivilIdRow[]>;
}
/** Internal trusted persistence port. Public entry points below enforce ownership/scope. */
export interface CivilIdStore {
  transaction<T>(keys: { candidateRef?: string; jobId?: string }, work: (tx: CivilIdTransaction) => Promise<T>): Promise<T>;
}
export interface CivilIdDependencies {
  store: CivilIdStore;
  authz: AuthzStore;
  /** Authoritative principal-to-candidate mapping, never a request-supplied target. */
  links: { resolveLink(principalId: string): Promise<{ kind: string; candidateRef?: string }> };
  now: () => Date;
}
export type WriteResult = { kind: "written"; expired: boolean; revision: number };
export type JobResult = { kind: "processed" | "already_processed"; job: OcrJob };

export function civilIdRef(value: string): string {
  return createHash("sha256").update("studenthub:civil-id-ref:v1\0").update(value).digest("hex");
}
function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 512 || value.includes("\0")) {
    throw new CivilIdError("civil_id_request_invalid");
  }
}
function instant(deps: Pick<CivilIdDependencies, "now">): string {
  const value = deps.now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new CivilIdError("civil_id_unavailable");
  return value.toISOString();
}
/** Sanitizes all dependency failures, including PostgreSQL's number-bearing detail. */
async function safe<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof CivilIdError) throw new CivilIdError(error.code);
    throw new CivilIdError("civil_id_unavailable");
  }
}
async function operator(identity: RequestIdentity, deps: CivilIdDependencies): Promise<string> {
  for (const orgId of CIVIL_ID_DECISIONS.operatorOrgIds) {
    for (const role of ["staff", "admin"] as const) {
      const result = await resolveActiveContext(identity, { orgId, role }, deps.authz);
      if (result.kind === "authorized" && result.context.scope === "subtree"
        && CIVIL_ID_DECISIONS.operatorOrgIds.includes(result.context.grantedByOrgId)) return result.context.principalId;
    }
  }
  throw new CivilIdError("not_found");
}
async function save(
  tx: CivilIdTransaction, candidateRef: string, input: { countryCode: unknown; civilIdNumber: unknown; expiryDate: unknown },
  source: "ocr" | "manual", occurredAt: string,
): Promise<WriteResult> {
  const fields = normalizeCivilId(input.countryCode, input.civilIdNumber);
  if (!isCivilIdDate(input.expiryDate)) throw new CivilIdError("civil_id_expiry_invalid");
  const existing = await tx.read(candidateRef);
  if (existing?.candidateDeleted) throw new CivilIdError("not_found");
  const row: CivilIdRow = {
    candidateRef, ...fields, expiryDate: input.expiryDate,
    needVerification: true, source, candidateDeleted: false,
    revision: (existing?.revision ?? 0) + 1, createdAt: existing?.createdAt ?? occurredAt, updatedAt: occurredAt,
  };
  await tx.write(row);
  return { kind: "written", expired: !isCivilIdValidOn(row.expiryDate, new Date(occurredAt)), revision: row.revision };
}
function event(actor: string, candidateRef: string, operation: CivilIdAudit["operation"], occurredAt: string,
  jobId: string | null = null, code: CivilIdErrorCode | null = null): CivilIdAudit {
  return { actorRef: principalAuditRef(actor), candidateRefHash: civilIdRef(candidateRef),
    jobRef: jobId === null ? null : civilIdRef(jobId), operation, outcome: code === null ? "written" : "failed", code, occurredAt };
}

export async function setOwnCivilId(
  request: { identity: RequestIdentity; countryCode: unknown; civilIdNumber: unknown; expiryDate: unknown },
  deps: CivilIdDependencies,
): Promise<WriteResult> {
  return safe(async () => {
    const principal = await resolvePrincipalId(request.identity, deps.authz);
    if (principal === null) throw new CivilIdError("not_found");
    const link = await deps.links.resolveLink(principal);
    if (link.kind !== "linked" || !link.candidateRef) throw new CivilIdError("not_found");
    const candidateRef = link.candidateRef;
    identifier(candidateRef);
    return deps.store.transaction({ candidateRef }, async (tx) => {
      const occurredAt = instant(deps);
      const result = await save(tx, candidateRef, request, "manual", occurredAt);
      await tx.audit(event(principal, candidateRef, "manual", occurredAt));
      return result;
    });
  });
}

/** Trusted internal job entry point, not a candidate-facing API. Holds candidate/job
 * locks through OCR so an older in-flight read cannot overwrite a newer manual edit.
 * Terminal failures are deduped too; a new attempt needs a new jobId.
 */
export async function runCivilIdOcrJob(
  request: { jobId: string; candidateRef: string; frontImage: Uint8Array },
  deps: Pick<CivilIdDependencies, "store" | "now"> & { ocr: OcrPort },
): Promise<JobResult> {
  return safe(async () => {
    identifier(request.jobId); identifier(request.candidateRef);
    if (!(request.frontImage instanceof Uint8Array)) throw new CivilIdError("civil_id_request_invalid");
    return deps.store.transaction(request, async (tx) => {
      const prior = await tx.readJob(request.jobId);
      if (prior) {
        if (prior.candidateRef !== request.candidateRef) throw new CivilIdError("civil_id_request_invalid");
        return { kind: "already_processed", job: prior };
      }
      let input: unknown;
      let code: CivilIdErrorCode | null = null;
      try { input = await deps.ocr.readCivilId(request.frontImage); }
      catch { code = "civil_id_ocr_failed"; }
      const occurredAt = instant(deps);
      let expired: boolean | null = null;
      if (code === null) {
        if (typeof input !== "object" || input === null || Array.isArray(input)) code = "civil_id_ocr_unreadable";
        else {
          const read = input as Record<string, unknown>;
          try {
            const result = await save(tx, request.candidateRef, {
              countryCode: read.countryCode, civilIdNumber: read.civilIdNumber, expiryDate: read.expiryDate,
            }, "ocr", occurredAt);
            expired = result.expired;
          } catch (error) {
            if (!(error instanceof CivilIdError) || error.code === "civil_id_unavailable") throw error;
            code = error.code;
          }
        }
      }
      const job: OcrJob = { jobId: request.jobId, candidateRef: request.candidateRef,
        status: code === null ? "succeeded" : "failed", code, expired,
        timeZone: CIVIL_ID_DECISIONS.timeZone, occurredAt };
      await tx.writeJob(job);
      await tx.audit(event("civil-id-ocr-worker", request.candidateRef, "ocr", occurredAt, request.jobId, code));
      return { kind: "processed", job };
    });
  });
}

export async function confirmCivilId(
  request: { identity: RequestIdentity; candidateRef: string; expectedRevision: number }, deps: CivilIdDependencies,
): Promise<WriteResult> {
  return safe(async () => {
    const actor = await operator(request.identity, deps);
    identifier(request.candidateRef);
    return deps.store.transaction({ candidateRef: request.candidateRef }, async (tx) => {
      const row = await tx.read(request.candidateRef);
      if (!row || row.candidateDeleted) throw new CivilIdError("not_found");
      if (row.revision !== request.expectedRevision) throw new CivilIdError("civil_id_review_changed");
      const occurredAt = instant(deps);
      const expired = !isCivilIdValidOn(row.expiryDate, new Date(occurredAt));
      if (!row.needVerification) return { kind: "written", expired, revision: row.revision };
      const revision = row.revision + 1;
      await tx.write({ ...row, needVerification: false, source: "staff", revision, updatedAt: occurredAt });
      await tx.audit(event(actor, row.candidateRef, "confirm", occurredAt));
      return { kind: "written", expired, revision };
    });
  });
}

/** Restricted queue returns the private data needed for review. Never log rows. */
export async function listCivilIdReviewQueue(identity: RequestIdentity, deps: CivilIdDependencies): Promise<readonly CivilIdRow[]> {
  return safe(async () => {
    await operator(identity, deps);
    return deps.store.transaction({}, (tx) => tx.listReview());
  });
}
