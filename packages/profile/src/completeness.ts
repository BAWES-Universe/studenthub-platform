import type { PendingProfileRequirement } from "./types.js";
import type { SelfEditField } from "./self-edit.js";

/**
 * SHU-143 (S2): profile completeness, recomputed on every self-edit. It follows
 * `Candidate::isInCompleteProfile` (`Candidate.php:3410-3510`) requirement for
 * requirement and in the same order, including the three at the end that a
 * column-only reading misses: the conditional Kuwaiti-mother flag, at least one
 * education row and at least one skill row.
 */
export interface CompletenessFacts {
  /** The candidate's self-edited fields; a missing or null entry is not recorded. */
  readonly fields: Readonly<Partial<Record<SelfEditField, string | null>>>;
  readonly emailRecorded: boolean;
  readonly personalPhoto: boolean;
  readonly civilId: boolean;
  readonly civilExpiry: boolean;
  readonly civilFront: boolean;
  readonly civilBack: boolean;
  /** Legacy accepts coordinates or an area. Undefined when the location is not recorded. */
  readonly location: { readonly inKuwait: boolean } | undefined;
  /** Whether the recorded nationality is Kuwaiti; undefined when none is recorded. */
  readonly nationalityKuwaiti: boolean | undefined;
  readonly educationCount: number;
  readonly skillCount: number;
}

/**
 * Legacy also requires `candidate_uid`, which it generates on first save, so it is
 * never pending there. The platform's principal id plays that part and always
 * exists, so the requirement is satisfied by construction and not listed here.
 */
export function pendingProfileRequirements(facts: CompletenessFacts): readonly PendingProfileRequirement[] {
  const recorded = (field: SelfEditField) => typeof facts.fields[field] === "string";
  const pending: PendingProfileRequirement[] = [];
  const need = (missing: boolean, requirement: PendingProfileRequirement) => { if (missing) pending.push(requirement); };
  need(!recorded("nationality"), "nationality");
  need(!recorded("display_name"), "display_name");
  need(!recorded("arabic_name"), "arabic_name");
  need(!recorded("gender"), "gender");
  need(!recorded("objective"), "objective");
  need(!facts.personalPhoto, "personal_photo");
  need(!facts.emailRecorded, "email");
  need(!recorded("phone"), "phone");
  need(!recorded("birth_date"), "birth_date");
  need(!facts.civilId, "civil_id");
  need(!facts.civilExpiry, "civil_expiry");
  need(!facts.civilFront, "civil_front");
  need(!facts.civilBack, "civil_back");
  need(!recorded("driving_licence"), "driving_licence");
  need(facts.location === undefined, "location");
  // `:3480-3489`: a candidate living in Kuwait who is not Kuwaiti must say whether their mother is.
  need(facts.location?.inKuwait === true && facts.nationalityKuwaiti === false && !recorded("kuwaiti_mother"), "kuwaiti_mother");
  need(facts.educationCount === 0, "education");
  need(facts.skillCount === 0, "skill");
  return Object.freeze(pending);
}
