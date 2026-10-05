import { randomUUID } from "node:crypto";
import {
  EDUCATION_TYPES, PROFILE_RECORD_KINDS,
  type EducationFields, type ExperienceFields, type LinkFields, type ProfileBackground,
  type ProfileRecord, type ProfileRecordFieldsByKind, type ProfileRecordKind, type ProfileRecordStore,
  type ProfileRecordTransaction, type ReferenceResolver, type ReferenceType, type SkillFields,
  type StoredProfileRecord,
} from "./types.js";

const MAX_ACTIVE_PER_KIND = 50;
const MIN_YEAR = 1950;
const MAX_YEAR = 2100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ProfileRecordError extends Error {
  constructor(readonly code: string, readonly status: 400 | 401 | 404 | 409 | 503) {
    super(code);
  }
}

export function isProfileRecordKind(value: unknown): value is ProfileRecordKind {
  return typeof value === "string" && (PROFILE_RECORD_KINDS as readonly string[]).includes(value);
}

function invalid(code = "invalid_profile_record"): never {
  throw new ProfileRecordError(code, 400);
}

function closedObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !allowed.includes(key))) invalid();
  return raw;
}

function text(value: unknown, max: number, code: string): string {
  if (typeof value !== "string") invalid(code);
  const cleaned = value.trim().replace(/\s+/gu, " ").normalize("NFKC");
  if (cleaned.length < 1 || cleaned.length > max || /[\p{Cc}\p{Cf}]/u.test(cleaned)) invalid(code);
  return cleaned;
}

function optionalText(value: unknown, max: number, code: string): string | undefined {
  return value === undefined || value === null || value === "" ? undefined : text(value, max, code);
}

function year(value: unknown, code: string): number {
  const parsed = typeof value === "string" && /^\d{4}$/.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < MIN_YEAR || parsed > MAX_YEAR) invalid(code);
  return parsed;
}

function optionalYear(value: unknown, code: string): number | undefined {
  return value === undefined || value === null || value === "" ? undefined : year(value, code);
}

function referenceId(value: unknown, code: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) invalid(code);
  return value.toLowerCase();
}

function bool(value: unknown, code: string): boolean {
  if (value === true || value === "true" || value === "on") return true;
  if (value === undefined || value === false || value === "false") return false;
  invalid(code);
}

function strip<T extends object>(value: T): T {
  return Object.freeze(Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined))) as T;
}

export function normalizeEducation(value: unknown): EducationFields {
  const raw = closedObject(value, ["educationType", "universityId", "institutionName", "degreeId", "majorId", "customMajor", "graduationYear", "currentlyStudying"]);
  const educationType = raw.educationType;
  if (typeof educationType !== "string" || !(EDUCATION_TYPES as readonly string[]).includes(educationType)) invalid("invalid_education_type");
  const fields = {
    educationType: educationType as EducationFields["educationType"],
    universityId: referenceId(raw.universityId, "invalid_university"),
    institutionName: optionalText(raw.institutionName, 160, "invalid_institution_name"),
    degreeId: referenceId(raw.degreeId, "invalid_degree"),
    majorId: referenceId(raw.majorId, "invalid_major"),
    customMajor: optionalText(raw.customMajor, 128, "invalid_custom_major"),
    graduationYear: optionalYear(raw.graduationYear, "invalid_graduation_year"),
    currentlyStudying: bool(raw.currentlyStudying, "invalid_currently_studying"),
  };
  // Legacy education_type rules: a listed university, a named custom institution, or neither.
  if (fields.educationType === "standard" && (!fields.universityId || fields.institutionName)) invalid("invalid_institution");
  if ((fields.educationType === "custom_university" || fields.educationType === "studying_abroad")
    && (!fields.institutionName || fields.universityId)) invalid("invalid_institution");
  if (fields.educationType === "not_studying" && (fields.universityId || fields.institutionName || fields.currentlyStudying)) invalid("invalid_institution");
  if (fields.majorId && fields.customMajor) invalid("invalid_major");
  return strip(fields);
}

export function normalizeExperience(value: unknown): ExperienceFields {
  const raw = closedObject(value, ["title", "employer", "startYear", "endYear"]);
  const fields = {
    title: text(raw.title, 128, "invalid_experience_title"),
    employer: text(raw.employer, 128, "invalid_employer"),
    startYear: year(raw.startYear, "invalid_start_year"),
    endYear: optionalYear(raw.endYear, "invalid_end_year"),
  };
  if (fields.endYear !== undefined && fields.endYear < fields.startYear) invalid("invalid_end_year");
  return strip(fields);
}

export function normalizeSkill(value: unknown): SkillFields {
  const raw = closedObject(value, ["name"]);
  return Object.freeze({ name: text(raw.name, 128, "invalid_skill") });
}

export function normalizeLink(value: unknown): LinkFields {
  const raw = closedObject(value, ["title", "url"]);
  const title = text(raw.title, 128, "invalid_link_title");
  if (typeof raw.url !== "string" || raw.url.length > 2048) invalid("invalid_link_url");
  let url: URL;
  try { url = new URL(raw.url.trim()); } catch { invalid("invalid_link_url"); }
  // Only web links: no javascript:, data: or credentials embedded in the URL.
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) invalid("invalid_link_url");
  return Object.freeze({ title, url: url.href });
}

const normalizers: { readonly [K in ProfileRecordKind]: (value: unknown) => ProfileRecordFieldsByKind[K] } = {
  education: normalizeEducation,
  experience: normalizeExperience,
  skill: normalizeSkill,
  link: normalizeLink,
};

function publicRecord(record: StoredProfileRecord): ProfileRecord {
  const { ownerId: _owner, ...rest } = record;
  return Object.freeze(rest);
}

function requireOwner(ownerId: string): void {
  if (typeof ownerId !== "string" || ownerId.length === 0) throw new ProfileRecordError("unauthorized", 401);
}

function requireKind(kind: unknown): ProfileRecordKind {
  if (!isProfileRecordKind(kind)) throw new ProfileRecordError("not_found", 404);
  return kind;
}

function requireId(id: unknown): string {
  // A malformed id is indistinguishable from someone else's row.
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) throw new ProfileRecordError("not_found", 404);
  return id.toLowerCase();
}

function skillKey(name: string): string {
  return name.toLocaleLowerCase("en-US");
}

/**
 * S3 (SHU-144): owner-scoped education, experience, skills and links.
 * The owner is always the authenticated principal; nothing in the input can name another.
 */
export class ProfileRecords {
  constructor(
    private readonly store: ProfileRecordStore,
    private readonly references: ReferenceResolver,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async background(ownerId: string): Promise<ProfileBackground> {
    requireOwner(ownerId);
    const rows = await this.store.listAll(ownerId);
    const active = (kind: ProfileRecordKind) => rows
      .filter((row) => row.ownerId === ownerId && row.kind === kind && row.status === "active")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(publicRecord);
    const removed = rows
      .filter((row) => row.ownerId === ownerId && row.status === "deleted")
      .sort((a, b) => (b.deletedAt ?? "").localeCompare(a.deletedAt ?? "") || a.id.localeCompare(b.id))
      .map(publicRecord);
    return Object.freeze({
      education: active("education") as ProfileRecord<"education">[],
      experience: active("experience") as ProfileRecord<"experience">[],
      skill: active("skill") as ProfileRecord<"skill">[],
      link: active("link") as ProfileRecord<"link">[],
      removed,
    });
  }

  async create(ownerId: string, kindInput: unknown, input: unknown): Promise<ProfileRecord> {
    requireOwner(ownerId);
    const kind = requireKind(kindInput);
    const fields = normalizers[kind](input);
    assertReferences(kind, fields, undefined, await this.resolveReferences(kind, fields));
    const now = this.now().toISOString();
    return this.store.transaction(async (tx) => {
      const active = (await tx.listOwned(ownerId, kind)).filter((row) => row.status === "active");
      if (active.length >= MAX_ACTIVE_PER_KIND) throw new ProfileRecordError("profile_record_limit", 409);
      if (kind === "skill") assertUniqueSkills([...active.map((row) => (row.fields as SkillFields).name), (fields as SkillFields).name]);
      const record: StoredProfileRecord = Object.freeze({ id: randomUUID(), ownerId, kind, status: "active", fields, createdAt: now, updatedAt: now });
      await tx.insert(record);
      await tx.audit({ operation: "profile_record.create", ownerId, kind, activeBefore: active.length, activeAfter: active.length + 1 });
      return publicRecord(record);
    });
  }

  async update(ownerId: string, kindInput: unknown, idInput: unknown, input: unknown): Promise<ProfileRecord> {
    requireOwner(ownerId);
    const kind = requireKind(kindInput);
    const id = requireId(idInput);
    const fields = normalizers[kind](input);
    // Resolve before the transaction: a resolver call inside it would need a second pool connection.
    const resolved = await this.resolveReferences(kind, fields);
    return this.store.transaction(async (tx) => {
      const current = await tx.findOwned(ownerId, kind, id);
      if (!current || current.status !== "active") throw new ProfileRecordError("not_found", 404);
      assertReferences(kind, fields, current.fields, resolved);
      const active = (await tx.listOwned(ownerId, kind)).filter((row) => row.status === "active");
      if (kind === "skill") {
        assertUniqueSkills([...active.filter((row) => row.id !== id).map((row) => (row.fields as SkillFields).name), (fields as SkillFields).name]);
      }
      const next: StoredProfileRecord = Object.freeze({ ...current, fields, updatedAt: this.now().toISOString() });
      await tx.replace(next);
      await tx.audit({ operation: "profile_record.update", ownerId, kind, activeBefore: active.length, activeAfter: active.length });
      return publicRecord(next);
    });
  }

  /** Soft delete: the row and its values stay, so restore brings back exactly what was there. */
  async remove(ownerId: string, kindInput: unknown, idInput: unknown): Promise<ProfileRecord> {
    requireOwner(ownerId);
    const kind = requireKind(kindInput);
    const id = requireId(idInput);
    return this.store.transaction(async (tx) => {
      const current = await tx.findOwned(ownerId, kind, id);
      if (!current || current.status !== "active") throw new ProfileRecordError("not_found", 404);
      const activeBefore = (await tx.listOwned(ownerId, kind)).filter((row) => row.status === "active").length;
      const now = this.now().toISOString();
      const next: StoredProfileRecord = Object.freeze({ ...current, status: "deleted", deletedAt: now, updatedAt: now });
      await tx.replace(next);
      await tx.audit({ operation: "profile_record.remove", ownerId, kind, activeBefore, activeAfter: activeBefore - 1 });
      return publicRecord(next);
    });
  }

  async restore(ownerId: string, kindInput: unknown, idInput: unknown): Promise<ProfileRecord> {
    requireOwner(ownerId);
    const kind = requireKind(kindInput);
    const id = requireId(idInput);
    return this.store.transaction(async (tx) => {
      const current = await tx.findOwned(ownerId, kind, id);
      if (!current || current.status !== "deleted") throw new ProfileRecordError("not_found", 404);
      const active = (await tx.listOwned(ownerId, kind)).filter((row) => row.status === "active");
      if (active.length >= MAX_ACTIVE_PER_KIND) throw new ProfileRecordError("profile_record_limit", 409);
      if (kind === "skill") assertUniqueSkills([...active.map((row) => (row.fields as SkillFields).name), (current.fields as SkillFields).name]);
      const { deletedAt: _deleted, ...kept } = current;
      const next: StoredProfileRecord = Object.freeze({ ...kept, status: "active", updatedAt: this.now().toISOString() });
      await tx.replace(next);
      await tx.audit({ operation: "profile_record.restore", ownerId, kind, activeBefore: active.length, activeAfter: active.length + 1 });
      return publicRecord(next);
    });
  }

  /**
   * PD-17 bulk replace. Legacy deleted every skill row and then inserted the new list with no
   * transaction; here the old rows are soft-deleted and the new ones inserted in one transaction.
   */
  async replaceSkills(ownerId: string, input: unknown): Promise<readonly ProfileRecord[]> {
    requireOwner(ownerId);
    if (!Array.isArray(input) || input.length === 0) invalid("empty_skill_list");
    if (input.length > MAX_ACTIVE_PER_KIND) throw new ProfileRecordError("profile_record_limit", 409);
    const skills = input.map((item) => normalizeSkill(typeof item === "string" ? { name: item } : item));
    assertUniqueSkills(skills.map((skill) => skill.name));
    const now = this.now().toISOString();
    return this.store.transaction(async (tx) => {
      const active = (await tx.listOwned(ownerId, "skill")).filter((row) => row.status === "active");
      for (const row of active) {
        await tx.replace(Object.freeze({ ...row, status: "deleted", deletedAt: now, updatedAt: now }));
      }
      const created: ProfileRecord[] = [];
      const base = Date.parse(now);
      for (const [index, fields] of skills.entries()) {
        // One millisecond apart, so listing order is the order the person gave.
        const at = new Date(base + index).toISOString();
        const record: StoredProfileRecord = Object.freeze({ id: randomUUID(), ownerId, kind: "skill", status: "active", fields, createdAt: at, updatedAt: at });
        await tx.insert(record);
        created.push(publicRecord(record));
      }
      await tx.audit({ operation: "profile_record.replace", ownerId, kind: "skill", activeBefore: active.length, activeAfter: created.length });
      return Object.freeze(created);
    });
  }

  /** Looks up every catalogue reference in the fields; unknown ids map to undefined. */
  private async resolveReferences(kind: ProfileRecordKind, fields: unknown): Promise<ResolvedReferences> {
    const resolved: ResolvedReferences = new Map();
    for (const [type, id] of educationReferences(kind, fields)) {
      if (id === undefined) continue;
      try { resolved.set(`${type}:${id}`, (await this.references.resolve(type, id))?.status); }
      catch { throw new ProfileRecordError("reference_unavailable", 503); }
    }
    return resolved;
  }
}

type ResolvedReferences = Map<string, "active" | "deleted" | undefined>;

function educationReferences(kind: ProfileRecordKind, fields: unknown): [ReferenceType, string | undefined][] {
  if (kind !== "education") return [];
  const education = fields as EducationFields;
  return [["university", education.universityId], ["degree", education.degreeId], ["major", education.majorId]];
}

/** New or changed references must be active; an unchanged historical one may stay. */
function assertReferences(kind: ProfileRecordKind, fields: unknown, previous: unknown, resolved: ResolvedReferences): void {
  const before = new Map(educationReferences(kind, previous ?? {}));
  for (const [type, id] of educationReferences(kind, fields)) {
    if (id === undefined || (previous !== undefined && id === before.get(type))) continue;
    if (resolved.get(`${type}:${id}`) !== "active") invalid(`invalid_${type}`);
  }
}

function assertUniqueSkills(names: readonly string[]): void {
  const keys = names.map(skillKey);
  if (new Set(keys).size !== keys.length) throw new ProfileRecordError("duplicate_skill", 409);
}

export type { ProfileRecordTransaction };
