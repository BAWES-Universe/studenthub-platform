export const SELF_EDIT_FIELDS = ["display_name", "arabic_name", "objective", "intro", "preferred_time"] as const;
export type SelfEditField = typeof SELF_EDIT_FIELDS[number];

export const SELF_EDIT_LIMITS: Readonly<Record<SelfEditField, number>> = Object.freeze({
  display_name: 255, arabic_name: 255, objective: 100, intro: 5_000, preferred_time: 100,
});

/** The write rule intentionally matches the read parsers, with the legacy full-name rule added. */
export function parseSelfEditValue(field: SelfEditField, value: unknown): string {
  const limit = SELF_EDIT_LIMITS[field];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > limit) throw new TypeError("invalid profile value");
  if ((field === "display_name" || field === "arabic_name") && value.trim().split(/\s+/u).length < 2) throw new TypeError("full name required");
  return value;
}

export function isSelfEditField(value: unknown): value is SelfEditField {
  return typeof value === "string" && (SELF_EDIT_FIELDS as readonly string[]).includes(value);
}
