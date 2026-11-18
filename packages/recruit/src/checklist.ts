// Recruit R2b: request checklists and staff notes.
//
// Legacy keeps one admin-managed list of named steps (request_checklist: English
// and Arabic names, a required flag, a sort order; admin RequestChecklistController).
// Staff tick a step on a request by writing a note against it (common/models/Note.php,
// staff NoteController), and also write typed notes on requests and stories.
// Here the same: checklist items are admin-managed, and a step counts as done on a
// request once a note names it. Notes are staff-only, as in legacy.

import type { RecruitGrantRow } from "./requests.js";

export const NOTE_TYPES = ["internal_note", "phone_call", "email", "meeting", "interview", "task"] as const;
export type NoteType = typeof NOTE_TYPES[number];
export const CHECKLIST_NAME_MAX = 100;
export const NOTE_TEXT_MAX = 5000;
export const CHECKLIST_SORT_MAX = 1000;

/** Legacy note types (Note::TYPE_*) used by staff on requests; the generated suggestion and invitation notes are events elsewhere. */
export function legacyNoteType(value: string): { kind: "mapped"; type: NoteType } | { kind: "unmapped"; value: string } {
  const map: Readonly<Record<string, NoteType>> = { "Internal Note": "internal_note", "Phone Call": "phone_call", Email: "email", Meeting: "meeting", Interview: "interview", Task: "task" };
  return Object.hasOwn(map, value) ? { kind: "mapped", type: map[value]! } : { kind: "unmapped", value };
}

const subtree = (rows: readonly RecruitGrantRow[], roles: readonly string[], operators: readonly string[]) =>
  rows.some((row) => roles.includes(row.role) && row.scope === "subtree" && operators.includes(row.org_id));

/** Admins on an operator organization keep the checklist (legacy: admin app). */
export function checklistAdminDecision(rows: readonly RecruitGrantRow[], operators: readonly string[]): boolean {
  return subtree(rows, ["admin"], operators);
}

/** Staff, admin and operator recruiters read the checklist and write and read request notes. */
export function recruitNotesDecision(rows: readonly RecruitGrantRow[], operators: readonly string[]): boolean {
  return subtree(rows, ["staff", "admin", "recruiter"], operators);
}

const CONTROL_LINE = /[\u0000-\u001f\u007f]/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
function text(value: unknown, max: number, multiline = false): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t.length >= 1 && [...t].length <= max && !(multiline ? CONTROL : CONTROL_LINE).test(t) ? t : undefined;
}

export interface ChecklistItemFields { readonly nameEn: string; readonly nameAr: string | null; readonly required: boolean; readonly sortOrder: number }

export function parseChecklistItem(value: unknown): ChecklistItemFields | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  if (Object.keys(r).some((k) => !["nameEn", "nameAr", "required", "sortOrder"].includes(k))) return undefined;
  const nameEn = text(r.nameEn, CHECKLIST_NAME_MAX);
  const nameAr = r.nameAr === undefined || r.nameAr === null || r.nameAr === "" ? null : text(r.nameAr, CHECKLIST_NAME_MAX);
  const required = r.required === undefined || r.required === false || r.required === "" ? false : r.required === true || r.required === "on" ? true : undefined;
  const raw = r.sortOrder === undefined || r.sortOrder === "" ? 0 : typeof r.sortOrder === "string" && /^\d{1,4}$/.test(r.sortOrder) ? Number(r.sortOrder) : r.sortOrder;
  const sortOrder = typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= CHECKLIST_SORT_MAX ? raw : undefined;
  if (nameEn === undefined || nameAr === undefined || required === undefined || sortOrder === undefined) return undefined;
  return { nameEn, nameAr, required, sortOrder };
}

export interface NoteFields { readonly type: NoteType; readonly text: string; readonly checklistItemId: string | null; readonly cardId: string | null }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseNote(value: unknown): NoteFields | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  if (Object.keys(r).some((k) => !["type", "text", "checklistItemId", "cardId"].includes(k))) return undefined;
  const type = typeof r.type === "string" && (NOTE_TYPES as readonly string[]).includes(r.type) ? r.type as NoteType : undefined;
  const body = text(r.text, NOTE_TEXT_MAX, true);
  const ref = (v: unknown) => (v === undefined || v === null || v === "" ? null : typeof v === "string" && UUID.test(v) ? v.toLowerCase() : undefined);
  const checklistItemId = ref(r.checklistItemId), cardId = ref(r.cardId);
  if (type === undefined || body === undefined || checklistItemId === undefined || cardId === undefined) return undefined;
  return { type, text: body, checklistItemId, cardId };
}

export interface ChecklistItemRow { readonly id: string; readonly name_en: string; readonly name_ar: string | null; readonly required: boolean; readonly sort_order: number }
export interface ChecklistProgress { readonly itemId: string; readonly nameEn: string; readonly nameAr: string | null; readonly required: boolean; readonly done: boolean }

/** Items in sort order, each done when at least one note on the request names it; plus how many required steps remain. */
export function checklistProgress(items: readonly ChecklistItemRow[], doneItemIds: ReadonlySet<string>): { readonly steps: readonly ChecklistProgress[]; readonly requiredRemaining: number } {
  const steps = [...items].sort((a, b) => a.sort_order - b.sort_order || a.name_en.localeCompare(b.name_en) || a.id.localeCompare(b.id))
    .map((item) => ({ itemId: item.id, nameEn: item.name_en, nameAr: item.name_ar, required: item.required, done: doneItemIds.has(item.id) }));
  return { steps, requiredRemaining: steps.filter((s) => s.required && !s.done).length };
}
