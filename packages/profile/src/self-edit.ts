export const SELF_EDIT_FIELDS = ["display_name", "arabic_name", "objective", "intro", "preferred_time"] as const;
export type SelfEditField = typeof SELF_EDIT_FIELDS[number];

export const SELF_EDIT_LIMITS: Readonly<Record<SelfEditField, number>> = Object.freeze({
  display_name: 255, arabic_name: 255, objective: 100, intro: 5_000, preferred_time: 100,
});

/** Internal wire value used to make an optional profile field absent. */
export const SELF_EDIT_CLEAR = "\u0000studenthub:clear-profile-field";
const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u;

/** The write rule intentionally matches the read parsers, with the legacy full-name rule added. */
export function parseSelfEditValue(field: SelfEditField, value: unknown): string {
  const limit = SELF_EDIT_LIMITS[field];
  if (typeof value !== "string" || value.length === 0 || Array.from(value).length > limit || value !== value.trim() || FORBIDDEN.test(value)) throw new TypeError("invalid profile value");
  if ((field === "display_name" || field === "arabic_name") && value.split(/\s+/u).length < 2) throw new TypeError("full name required");
  if (field === "arabic_name" && !/[\u0620-\u064A\u066E-\u06D3\u06FA-\u06FC\u0750-\u077F\u08A0-\u08C9\uFB50-\uFBC2\uFBD3-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE70-\uFEFC]/u.test(value)) throw new TypeError("Arabic name required");
  return value;
}

export function parseSelfEditInput(field: SelfEditField, value: unknown): string {
  if (value === "" && field !== "display_name" && field !== "arabic_name") return SELF_EDIT_CLEAR;
  if (value === SELF_EDIT_CLEAR) throw new TypeError("reserved profile value");
  return parseSelfEditValue(field, value);
}

export function isSelfEditField(value: unknown): value is SelfEditField {
  return typeof value === "string" && (SELF_EDIT_FIELDS as readonly string[]).includes(value);
}
