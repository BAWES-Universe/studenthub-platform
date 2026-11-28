import { LifecycleError } from "../../../packages/private-documents/src/candidate-lifecycle.js";
import { CANDIDATE_DOCUMENT_TYPES, type CandidateDocumentType } from "../../../packages/private-documents/src/lifecycle-state.js";
import type { StaffDocuments } from "../../../packages/private-documents/src/staff-delivery.js";
import type { PeopleDirectoryPage } from "./people-directory.js";

/** The documents a person page may open with a short signed link. Civil ID photos open only from the Civil ID review. */
export const PERSON_PAGE_OPENABLE: ReadonlySet<CandidateDocumentType> = new Set<CandidateDocumentType>(["personal-photo", "resume"]);

export type PersonDocument = { readonly type: CandidateDocumentType; readonly state: "on_file" | "missing"; readonly mime?: string; readonly size?: number; readonly openable: boolean };
export type PersonDocumentsResult =
  | { status: 200; body: { readonly person: { readonly principalId: string; readonly name: string; readonly civilState: string }; readonly documents: readonly PersonDocument[]; readonly active: { readonly orgId: string; readonly role: "staff" | "admin" } } }
  | { status: 401 | 404 | 503; body: { error: string } };
export type PersonDocumentOpenResult = { status: 303; location: string } | { status: 401 | 404 | 503; body: { error: string } };

const failure = (error: unknown): { status: 404 | 503; body: { error: string } } =>
  error instanceof LifecycleError && error.status === 403 ? { status: 404, body: { error: "not_found" } } : { status: 503, body: { error: "documents_unavailable" } };

/**
 * A-03: one person's documents for operator staff and admin. The person read decides who may
 * see the page and that the person exists; the documents read is bound to that one id and
 * returns type, format and size only, never contents. StaffDocuments keeps its own grant check.
 */
export async function personDocuments(people: PeopleDirectoryPage | undefined, staffDocuments: StaffDocuments | undefined,
  session: string | undefined, principalId: string): Promise<PersonDocumentsResult> {
  if (!people?.person) return { status: 404, body: { error: "not_found" } };
  const result = await people.person(session, principalId);
  if (result.status !== 200) return result;
  if (!staffDocuments) return { status: 503, body: { error: "documents_unavailable" } };
  let stored;
  try { stored = await staffDocuments.documents(session, principalId); } catch (error) { return failure(error); }
  const documents = CANDIDATE_DOCUMENT_TYPES.map((type): PersonDocument => {
    const found = stored.filter((doc) => doc.type === type);
    return found.length === 1
      ? { type, state: "on_file", mime: found[0]!.mime, size: found[0]!.size, openable: PERSON_PAGE_OPENABLE.has(type) }
      : { type, state: "missing", openable: false };
  });
  const { person, active } = result.body;
  return { status: 200, body: { person: { principalId: person.principalId, name: person.name ?? person.universeName ?? "Unnamed", civilState: person.civilState }, documents, active } };
}

/** Open one photo or CV: the person check, then StaffDocuments issues (and audits) a 60-second link to the existing delivery. */
export async function openPersonDocument(people: PeopleDirectoryPage | undefined, staffDocuments: StaffDocuments | undefined,
  session: string | undefined, principalId: string, type: string): Promise<PersonDocumentOpenResult> {
  if (!people?.person) return { status: 404, body: { error: "not_found" } };
  const result = await people.person(session, principalId);
  if (result.status !== 200) return result;
  if (!PERSON_PAGE_OPENABLE.has(type as CandidateDocumentType)) return { status: 404, body: { error: "not_found" } };
  if (!staffDocuments) return { status: 503, body: { error: "documents_unavailable" } };
  try { return { status: 303, location: (await staffDocuments.issue(session, principalId, type as CandidateDocumentType, "person_page")).url }; }
  catch (error) { return failure(error); }
}
