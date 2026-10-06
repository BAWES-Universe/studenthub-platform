export const PROFILE_RECORD_KINDS = ["education", "experience", "skill", "link"] as const;
export type ProfileRecordKind = typeof PROFILE_RECORD_KINDS[number];

export const EDUCATION_TYPES = ["standard", "custom_university", "studying_abroad", "not_studying"] as const;
export type EducationType = typeof EDUCATION_TYPES[number];

export interface EducationFields {
  readonly educationType: EducationType;
  readonly universityId?: string;
  readonly institutionName?: string;
  readonly degreeId?: string;
  readonly majorId?: string;
  readonly customMajor?: string;
  readonly graduationYear?: number;
  readonly currentlyStudying: boolean;
}

export interface ExperienceFields {
  readonly title: string;
  readonly employer: string;
  readonly startYear: number;
  readonly endYear?: number;
}

export interface SkillFields {
  readonly name: string;
}

export interface LinkFields {
  readonly title: string;
  readonly url: string;
}

export interface ProfileRecordFieldsByKind {
  readonly education: EducationFields;
  readonly experience: ExperienceFields;
  readonly skill: SkillFields;
  readonly link: LinkFields;
}

export type ProfileRecordFields = ProfileRecordFieldsByKind[ProfileRecordKind];

export interface ProfileRecord<K extends ProfileRecordKind = ProfileRecordKind> {
  readonly id: string;
  readonly kind: K;
  readonly status: "active" | "deleted";
  readonly fields: ProfileRecordFieldsByKind[K];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt?: string;
}

/** Stored row. The owner never leaves the store in a response. */
export interface StoredProfileRecord extends ProfileRecord {
  readonly ownerId: string;
}

export interface ProfileBackground {
  readonly education: readonly ProfileRecord<"education">[];
  readonly experience: readonly ProfileRecord<"experience">[];
  readonly skill: readonly ProfileRecord<"skill">[];
  readonly link: readonly ProfileRecord<"link">[];
  /** Soft-deleted rows, newest first, so the owner can restore them. */
  readonly removed: readonly ProfileRecord[];
}

export const PROFILE_RECORD_AUDIT_OPERATIONS = [
  "profile_record.create",
  "profile_record.update",
  "profile_record.remove",
  "profile_record.restore",
  "profile_record.replace",
] as const;
export type ProfileRecordAuditOperation = typeof PROFILE_RECORD_AUDIT_OPERATIONS[number];

/**
 * Closed audit shape: the kind and the owner's active-row count before and after.
 * Never a record body, an email, a phone number or a raw principal id.
 */
export interface ProfileRecordAudit {
  readonly operation: ProfileRecordAuditOperation;
  readonly ownerId: string;
  readonly kind: ProfileRecordKind;
  readonly activeBefore: number;
  readonly activeAfter: number;
}

/** Owner scoping lives in every call: no method can reach another owner's rows. */
export interface ProfileRecordTransaction {
  listOwned(ownerId: string, kind: ProfileRecordKind): Promise<readonly StoredProfileRecord[]>;
  findOwned(ownerId: string, kind: ProfileRecordKind, id: string): Promise<StoredProfileRecord | undefined>;
  insert(record: StoredProfileRecord): Promise<void>;
  replace(record: StoredProfileRecord): Promise<void>;
  audit(entry: ProfileRecordAudit): Promise<void>;
}

export interface ProfileRecordStore {
  listAll(ownerId: string): Promise<readonly StoredProfileRecord[]>;
  /** Mutation and audit commit or fail together. */
  transaction<T>(work: (tx: ProfileRecordTransaction) => Promise<T>): Promise<T>;
}

export type ReferenceType = "university" | "degree" | "major";

/** Read port onto the SHU-166 reference catalogue. */
export interface ReferenceResolver {
  resolve(type: ReferenceType, id: string): Promise<{ readonly status: "active" | "deleted" } | undefined>;
}
