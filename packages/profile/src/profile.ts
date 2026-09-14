import type { PrincipalStore } from "@studenthub/contracts";

import {
  OWN_PROFILE_VERSION,
  PROFILE_PARITY_REVISION,
  type ApprovedProfileAdapter,
  type AvailableProfileField,
  type FieldFreshness,
  type FieldProvenance,
  type Gender,
  type JobSearchStatus,
  type LanguagePreference,
  type OwnProfileFieldContract,
  type OwnProfileFieldName,
  type OwnProfileFields,
  type OwnProfileProjection,
  type OwnProfileReadRequest,
  type OwnProfileReadResult,
  type PendingProfileRequirement,
  type ProfileField,
  type UnavailableProfileField,
} from "./types.js";

type Parser = (value: unknown, today: string) => unknown;

interface FieldSpec extends OwnProfileFieldContract {
  readonly parse: Parser;
}

function fieldSpec(sourceField: string, label: string, semantics: string, parse: Parser): FieldSpec {
  return Object.freeze({
    sourceField,
    label,
    semantics,
    unavailable: "not_imported_or_not_recorded",
    parse,
  });
}

function text(maxLength = 500): Parser {
  return (value) => {
    if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
      throw new TypeError("malformed approved profile value");
    }
    return value;
  };
}

function exactEnum<T>(mapping: ReadonlyMap<unknown, T>): Parser {
  return (value) => {
    if (!mapping.has(value)) throw new TypeError("malformed approved profile value");
    return mapping.get(value)!;
  };
}

function dateOnly(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError("malformed approved profile value");
  }
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new TypeError("malformed approved profile value");
  }
  return value;
}

function ageOn(birthDate: string, today: string): number {
  const [birthYear, birthMonth, birthDay] = birthDate.split("-").map(Number) as [number, number, number];
  const [year, month, day] = today.split("-").map(Number) as [number, number, number];
  let age = year - birthYear;
  if (month < birthMonth || (month === birthMonth && day < birthDay)) age -= 1;
  if (age < 0 || age > 150) throw new TypeError("malformed approved profile value");
  return age;
}

function candidateIdentifier(value: unknown): string {
  const digits = typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : typeof value === "string" && /^[1-9]\d*$/.test(value) ? value : undefined;
  if (!digits) throw new TypeError("malformed approved profile value");
  return `C${digits.padStart(5, "0")}`;
}

const PENDING_REQUIREMENTS = new Map<string, PendingProfileRequirement>([
  ["uid", "identity_reference"],
  ["country", "nationality"],
  ["name", "display_name"],
  ["Name Arabic", "arabic_name"],
  ["gender", "gender"],
  ["objective", "objective"],
  ["personal photo", "personal_photo"],
  ["email", "email"],
  ["phone", "phone"],
  ["birth date", "birth_date"],
  ["civil id", "civil_id"],
  ["civil expiry date", "civil_expiry"],
  ["civil photo front", "civil_front"],
  ["civil photo back", "civil_back"],
  ["driving license", "driving_licence"],
  ["location", "location"],
  ["candidate_mom_kuwaiti", "kuwaiti_mother"],
  ["education", "education"],
  ["skill", "skill"],
]);

function pendingFields(value: unknown): readonly PendingProfileRequirement[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string" ? (value === "" ? [] : value.split(",")) : undefined;
  if (!values || values.some((entry) => typeof entry !== "string" || !PENDING_REQUIREMENTS.has(entry))) {
    throw new TypeError("malformed approved profile value");
  }
  return Object.freeze([...new Set(values.map((entry) => PENDING_REQUIREMENTS.get(entry as string)!))]);
}

const PROFILE_FIELD_SPECS = Object.freeze({
  displayName: fieldSpec("candidate_name", "Display name", "Candidate's production display name.", text(255)),
  arabicName: fieldSpec("candidate_name_ar", "Arabic name", "Candidate's Arabic-script name.", text(255)),
  gender: fieldSpec("candidate_gender", "Gender", "Production code 1/2/3 mapped to male/female/other.", exactEnum<Gender>(new Map([[1, "male"], [2, "female"], [3, "other"]]))),
  birthDate: fieldSpec("candidate_birth_date", "Birth date", "Calendar date recorded by the candidate; no eligibility decision is made on read.", dateOnly),
  age: fieldSpec("candidate_birth_date", "Age", "Whole years derived from birth date as of the response date; not an eligibility rule.", (value, today) => ageOn(dateOnly(value), today)),
  nationality: fieldSpec("country_id→country.country_nationality_name_en", "Nationality", "Approved display value resolved from the production nationality foreign key.", text(160)),
  university: fieldSpec("university_id→university.university_name", "University", "Approved display value resolved from the production university foreign key.", text(255)),
  objective: fieldSpec("candidate_objective", "Objective", "Candidate's profile objective.", text(100)),
  intro: fieldSpec("candidate_intro", "Introduction", "Candidate's profile introduction.", text(5_000)),
  preferredTime: fieldSpec("candidate_preferred_time", "Preferred time", "Candidate's stated preferred working time.", text(100)),
  language: fieldSpec("candidate_language_pref", "Language", "Production language preference, en or ar.", exactEnum<LanguagePreference>(new Map([["en", "en"], ["ar", "ar"]]))),
  area: fieldSpec("candidate_area_uuid→area.area_name_en", "Area", "Approved display value resolved from the production area foreign key; coordinates are excluded.", text(255)),
  drivingLicence: fieldSpec("candidate_driving_license", "Driving licence", "Production code 1/2 mapped to yes/no.", exactEnum<boolean>(new Map([[1, true], [2, false]]))),
  jobSearchStatus: fieldSpec("candidate_job_search_status", "Job-search status", "Production code 0/1/2 mapped to not looking/active/open to offers.", exactEnum<JobSearchStatus>(new Map([[0, "not_looking"], [1, "active"], [2, "open_to_offers"]]))),
  committed: fieldSpec("candidate_committed", "Committed", "Production 0/1 commitment marker mapped to a boolean.", exactEnum<boolean>(new Map([[0, false], [1, true]]))),
  isProfileCompleted: fieldSpec("is_incomplete_profile", "Profile complete", "Inverse of the imported production incomplete marker, whose final reviewed meaning includes conditional Kuwaiti-mother, education and skill requirements.", (value) => !exactEnum<boolean>(new Map([[0, false], [1, true]]))(value, "")),
  pendingFields: fieldSpec("candidate_pending_profile", "Pending profile requirements", "Closed safe names for all reviewed production completeness requirements; values and document locations are never included.", pendingFields),
  employeeIdentifier: fieldSpec("candidate_id", "Employee identifier", "Display-only C plus the production candidate id padded to at least five digits.", candidateIdentifier),
  civilExpired: fieldSpec("candidate_civil_expiry_date", "Civil ID expired", "Boolean derived by comparing the recorded expiry date with the response date; the date and civil number are excluded.", (value, today) => dateOnly(value) < today),
} satisfies Record<OwnProfileFieldName, FieldSpec>);

export const OWN_PROFILE_FIELD_NAMES = Object.freeze(Object.keys(PROFILE_FIELD_SPECS) as OwnProfileFieldName[]);

export const OWN_PROFILE_FIELD_CONTRACT: Readonly<Record<OwnProfileFieldName, OwnProfileFieldContract>> =
  Object.freeze(Object.fromEntries(OWN_PROFILE_FIELD_NAMES.map((name) => {
    const { parse: _parse, ...contract } = PROFILE_FIELD_SPECS[name];
    return [name, Object.freeze(contract)];
  })) as unknown as Readonly<Record<OwnProfileFieldName, OwnProfileFieldContract>>);

function provenance(sourceField: string): FieldProvenance {
  return Object.freeze({
    system: "studenthub-production-approved-import",
    revision: PROFILE_PARITY_REVISION,
    sourceField,
  });
}

function freshness(observedAt: string): FieldFreshness {
  return Object.freeze({ kind: "imported_snapshot", observedAt });
}

function unavailable(spec: FieldSpec, observedAt: string, reason: UnavailableProfileField["reason"]): UnavailableProfileField {
  return Object.freeze({
    state: "unavailable",
    reason,
    provenance: provenance(spec.sourceField),
    freshness: freshness(observedAt),
  });
}

function available<T>(spec: FieldSpec, observedAt: string, value: T): AvailableProfileField<T> {
  return Object.freeze({
    state: "available",
    value,
    provenance: provenance(spec.sourceField),
    freshness: freshness(observedAt),
  });
}

function importedAt(row: Readonly<Record<string, unknown>>): string {
  const value = row.imported_at;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    || !Number.isFinite(Date.parse(value))) {
    throw new TypeError("malformed approved profile snapshot");
  }
  if (row.source_revision !== PROFILE_PARITY_REVISION) {
    throw new TypeError("unapproved profile source revision");
  }
  return value;
}

function readField(
  name: OwnProfileFieldName,
  row: Readonly<Record<string, unknown>>,
  observedAt: string,
  today: string,
): ProfileField<unknown> {
  const spec = PROFILE_FIELD_SPECS[name];
  const sourceKey = name === "nationality" ? "nationality_name"
    : name === "university" ? "university_name"
      : name === "area" ? "area_name"
        : spec.sourceField;
  if (!Object.hasOwn(row, sourceKey)) return unavailable(spec, observedAt, "not_imported");
  const raw = row[sourceKey];
  if (raw === null) return unavailable(spec, observedAt, "not_recorded");
  const value = spec.parse(raw, today);
  return available(spec, observedAt, value);
}

export function projectApprovedProfile(row: unknown, today: string): OwnProfileProjection {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new TypeError("malformed approved profile snapshot");
  }
  dateOnly(today);
  const record = row as Readonly<Record<string, unknown>>;
  const observedAt = importedAt(record);
  const fields = Object.fromEntries(
    OWN_PROFILE_FIELD_NAMES.map((name) => [name, readField(name, record, observedAt, today)]),
  ) as unknown as OwnProfileFields;
  const complete = fields.isProfileCompleted;
  const pending = fields.pendingFields;
  if (complete.state === "available" && pending.state === "available"
    && (complete.value === (pending.value.length > 0))) {
    throw new TypeError("inconsistent approved profile completeness");
  }
  return Object.freeze({ version: OWN_PROFILE_VERSION, asOfDate: today, fields: Object.freeze(fields) });
}

export class OwnProfileRepository {
  readonly #principals: Pick<PrincipalStore, "getPrincipal">;
  readonly #source: ApprovedProfileAdapter;
  readonly #today: () => string;

  constructor(options: {
    readonly principals: Pick<PrincipalStore, "getPrincipal">;
    readonly source: ApprovedProfileAdapter;
    readonly today?: () => string;
  }) {
    this.#principals = options.principals;
    this.#source = options.source;
    this.#today = options.today ?? (() => new Date().toISOString().slice(0, 10));
  }

  async readOwn(request: OwnProfileReadRequest): Promise<OwnProfileReadResult> {
    if (request.requesterPrincipalId !== request.targetPersonId) return { kind: "not_found" };
    try {
      const principal = await this.#principals.getPrincipal(request.requesterPrincipalId);
      if (!principal || principal.id !== request.requesterPrincipalId) return { kind: "not_found" };
      const link = await this.#source.resolveLink(request.requesterPrincipalId);
      if (link.kind === "unconfigured") {
        const today = this.#today();
        dateOnly(today);
        // No snapshot exists: expose the field contract without inventing values or an import time.
        const fields = Object.fromEntries(OWN_PROFILE_FIELD_NAMES.map((name) => [name, Object.freeze({
          state: "unavailable",
          reason: "not_imported",
          provenance: provenance(PROFILE_FIELD_SPECS[name].sourceField),
          freshness: Object.freeze({ kind: "not_imported", observedAt: "" }),
        })])) as unknown as OwnProfileFields;
        return { kind: "found", profile: Object.freeze({
          version: OWN_PROFILE_VERSION, asOfDate: today, fields: Object.freeze(fields),
        }) };
      }
      if (link.kind !== "linked") return { kind: "not_found" };
      const row = await this.#source.readCandidate(link.candidateRef);
      if (row === undefined) return { kind: "unavailable" };
      return { kind: "found", profile: projectApprovedProfile(row, this.#today()) };
    } catch {
      return { kind: "unavailable" };
    }
  }
}
