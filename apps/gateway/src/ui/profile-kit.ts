/** Profile-only SSR library. U1 does not serve CSS or wire routes. */
import { directionForProfileLanguage, type ProfileLanguage } from "./profile-copy.js";

export const PROFILE_KIT_CSS = `.profile-ui {
  --p-ink: #172433; --p-muted: #566579;
  --p-canvas: #f7f9fc; --p-surface: #ffffff;
  --p-blue: #2256e8; --p-blue-hover: #1641be;
  --p-line: #dfe5ef; --p-control-line: #64748b;
  --p-focus: #a74400; --p-error: #a31515;
  --p-error-bg: #fff4f4; --p-success: #17643b;
  --p-success-bg: #effaf3;
  --p-space-1: .25rem; --p-space-2: .5rem;
  --p-space-3: .75rem; --p-space-4: 1rem;
  --p-space-6: 1.5rem; --p-space-8: 2rem;
  --p-radius: .65rem; --p-card-radius: 1rem;
  color: var(--p-ink); background: var(--p-canvas);
  font: 1rem/1.5 Inter, ui-sans-serif, system-ui, sans-serif;
  text-align: start;
}
.profile-ui *, .profile-ui *::before, .profile-ui *::after {
  box-sizing: border-box;
}
.profile-ui .p-shell {
  max-inline-size: 76rem; margin-inline: auto;
  padding: 1rem; display: grid; gap: 1.5rem;
  grid-template-columns: minmax(0, 1fr);
}
.profile-ui .p-main { min-inline-size: 0; max-inline-size: 56rem; }
.profile-ui .p-stack { display: grid; gap: 1.5rem; }
.profile-ui .p-header { display: grid; gap: .5rem; }
.profile-ui h1 { font-size: clamp(1.75rem, 4vw, 2.5rem); line-height: 1.2; }
.profile-ui h2 { font-size: 1.25rem; line-height: 1.35; }
.profile-ui h1, .profile-ui h2, .profile-ui p { margin: 0; }
.profile-ui p { color: inherit; }
.profile-ui .p-hint, .profile-ui .p-meta { color: var(--p-muted); }
.profile-ui .p-hint { font-size: .9375rem; }
.profile-ui .p-meta { font-size: .875rem; }
.profile-ui .p-card {
  padding: 1rem; border: 1px solid var(--p-line);
  border-radius: var(--p-card-radius); background: var(--p-surface);
  min-inline-size: 0;
}
.profile-ui .p-fields { margin: 1rem 0 0; }
.profile-ui .p-row {
  display: grid; gap: .25rem; padding-block: 1rem;
  border-block-start: 1px solid var(--p-line); min-inline-size: 0;
}
.profile-ui dt { color: var(--p-muted); font-size: .9375rem; margin: 0; }
.profile-ui dd { margin: 0; font-weight: 400; min-inline-size: 0; }
.profile-ui .p-value { overflow-wrap: anywhere; white-space: pre-wrap; }
.profile-ui .p-row-actions { margin-block-start: .5rem; }
.profile-ui .p-field { display: grid; gap: .5rem; min-inline-size: 0; }
.profile-ui label, .profile-ui legend { font-weight: 650; }
.profile-ui .p-control {
  display: block; inline-size: 100%; max-inline-size: 100%;
  min-inline-size: 0; min-block-size: 2.75rem;
  padding: .625rem .75rem; border: 1px solid var(--p-control-line);
  border-radius: var(--p-radius); background: var(--p-surface);
  color: var(--p-ink); font: inherit;
}
.profile-ui textarea.p-control { min-block-size: 8rem; resize: vertical; }
.profile-ui select.p-control { appearance: auto; }
.profile-ui .p-choice-group { border: 0; margin: 0; padding: 0; }
.profile-ui .p-choice-group legend { padding: 0; margin-block-end: .5rem; }
.profile-ui .p-choice {
  display: flex; align-items: center; gap: .75rem;
  min-block-size: 2.75rem; padding-block: .5rem; font-weight: 400;
}
.profile-ui .p-choice input {
  flex: 0 0 auto; inline-size: 1.25rem; block-size: 1.25rem;
  margin: 0; accent-color: var(--p-blue);
}
.profile-ui .p-actions { display: flex; flex-wrap: wrap; gap: .75rem; }
.profile-ui .p-button, .profile-ui .p-edit {
  display: inline-flex; align-items: center; justify-content: center;
  min-block-size: 2.75rem; padding: .625rem 1rem;
  border: 1px solid var(--p-control-line); border-radius: var(--p-radius);
  background: var(--p-surface); color: var(--p-ink);
  font: inherit; font-weight: 650; text-align: center;
  text-decoration: none; cursor: pointer; overflow-wrap: anywhere;
}
.profile-ui .p-primary { background: var(--p-blue); border-color: var(--p-blue); color: white; }
.profile-ui .p-primary:hover { background: var(--p-blue-hover); }
.profile-ui .p-edit { color: var(--p-blue); text-decoration: underline; }
.profile-ui a { text-underline-offset: .2em; }
.profile-ui :is(a, button, input, select, textarea):focus-visible,
.profile-ui [tabindex="-1"]:focus {
  outline: 3px solid var(--p-focus); outline-offset: 3px;
}
.profile-ui [aria-invalid="true"] { border: 2px solid var(--p-error); }
.profile-ui .p-error { color: var(--p-error); font-weight: 650; }
.profile-ui .p-notice { padding: 1rem; border: 1px solid; border-radius: var(--p-radius); }
.profile-ui .p-notice-error { color: var(--p-error); background: var(--p-error-bg); }
.profile-ui .p-notice-success { color: var(--p-success); background: var(--p-success-bg); }
.profile-ui .p-empty { border: 1px dashed var(--p-control-line); padding: 1rem; border-radius: var(--p-radius); }
@media (min-width: 50rem) {
  .profile-ui .p-shell { grid-template-columns: minmax(0, 1fr); padding: 2rem; }
  .profile-ui .p-card { padding: 1.5rem; }
  .profile-ui .p-row { grid-template-columns: minmax(8rem, 1fr) minmax(0, 2fr); gap: 1rem; }
}
@media (prefers-reduced-motion: reduce) {
  .profile-ui *, .profile-ui *::before, .profile-ui *::after {
    animation: none !important; transition: none !important; scroll-behavior: auto !important;
  }
}
`;

const fragments = new WeakSet<object>();
export interface ProfileHtml { readonly html: string }
function fragment(html: string): ProfileHtml {
  const value = Object.freeze({ html }); fragments.add(value); return value;
}
function join(parts: readonly ProfileHtml[]): string {
  return parts.map(part => {
    if (!fragments.has(part)) throw new TypeError("Expected a kit-generated fragment");
    return part.html;
  }).join("");
}
function escape(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
export const PROFILE_FIELD_KEYS = Object.freeze(["displayName", "arabicName", "objective", "intro", "preferredTime", "gender", "birthDate", "drivingLicence", "jobSearchStatus", "phone", "handle"] as const);
export type ProfileFieldKey = typeof PROFILE_FIELD_KEYS[number];
export const PROFILE_ROW_KEYS = Object.freeze([...PROFILE_FIELD_KEYS, "age", "nationality", "university", "language", "area", "committed", "isProfileCompleted", "pendingFields", "employeeIdentifier", "civilExpired"] as const);
export type ProfileRowKey = typeof PROFILE_ROW_KEYS[number];
function fieldId(key: ProfileFieldKey): string {
  if (!PROFILE_FIELD_KEYS.includes(key)) throw new TypeError("Unsupported profile field");
  return `field-${key}`;
}
function safeHref(href: string): string {
  // Only this journey's static navigation, never arbitrary schemes or query data.
  if (/[\s\\%]/u.test(href)) throw new TypeError("Unsupported profile link");
  const fields = PROFILE_FIELD_KEYS.join("|");
  if (!new RegExp(`^(?:/profile(?:#field-(?:${fields}))?|/profile/edit/(?:${fields})|#field-(?:${fields}))$`).test(href)) {
    throw new TypeError("Unsupported profile link");
  }
  return escape(href);
}
export function profileShell(language: ProfileLanguage, parts: readonly ProfileHtml[]): ProfileHtml {
  return fragment(`<div class="profile-ui" lang="${language}" dir="${directionForProfileLanguage(language)}"><div class="p-shell"><div class="p-main p-stack">${join(parts)}</div></div></div>`);
}
export function profileHeading(title: string, description?: string): ProfileHtml {
  return fragment(`<header class="p-header"><h1 id="profile-heading">${escape(title)}</h1>${description === undefined ? "" : `<p>${escape(description)}</p>`}</header>`);
}
export function profileSection(key: "personal" | "work" | "background" | "details", title: string, rows: readonly ProfileHtml[]): ProfileHtml {
  if (!["personal", "work", "background", "details"].includes(key)) throw new TypeError("Unsupported section");
  return fragment(`<section id="section-${key}" class="p-card" aria-labelledby="${key}-heading"><h2 id="${key}-heading">${escape(title)}</h2><dl class="p-fields">${join(rows)}</dl></section>`);
}
export function profileRow(options: { key: ProfileRowKey; label: string; value: string; metadata?: string; editLabel?: string }): ProfileHtml {
  if (!PROFILE_ROW_KEYS.includes(options.key)) throw new TypeError("Unsupported profile row");
  if (options.editLabel !== undefined) fieldId(options.key as ProfileFieldKey);
  const id = `field-${options.key}`;
  return fragment(`<div id="${id}" class="p-row"><dt>${escape(options.label)}</dt><dd><bdi class="p-value" dir="${options.key === "phone" ? "ltr" : "auto"}">${escape(options.value)}</bdi>${options.metadata === undefined ? "" : `<p class="p-meta">${escape(options.metadata)}</p>`}${options.editLabel === undefined ? "" : `<div class="p-row-actions"><a class="p-edit" href="/profile/edit/${options.key}">${escape(options.editLabel)}</a></div>`}</dd></div>`);
}
export interface ProfileControlOptions {
  readonly key: ProfileFieldKey;
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
  readonly error?: string;
  readonly required?: boolean;
  readonly requiredLabel?: string;
  readonly type?: "text" | "date" | "tel" | "textarea" | "select" | "radio";
  readonly choices?: readonly { value: string; label: string }[];
  /** Error/recovery responses must explicitly set recovery even without an error. */
  readonly recovery?: boolean;
}
export function profileControl(options: ProfileControlOptions): ProfileHtml {
  const id = fieldId(options.key), type = options.type ?? (options.key === "phone" ? "tel" : options.key === "birthDate" ? "date" : options.key === "intro" ? "textarea" : "text");
  if (options.required && !options.requiredLabel?.trim()) throw new TypeError("Localized required label needed");
  const label = escape(options.label) + (options.required ? ` <span class="p-hint">${escape(options.requiredLabel!)}</span>` : "");
  if (!["text", "date", "tel", "textarea", "select", "radio"].includes(type)) throw new TypeError("Unsupported control");
  const described = [options.hint !== undefined ? `${id}-hint` : "", options.error !== undefined ? `${id}-error` : ""].filter(Boolean).join(" ");
  const associations = `${described ? ` aria-describedby="${described}"` : ""}${options.error !== undefined ? ' aria-invalid="true"' : ""}`;
  const required = options.required ? " required" : "";
  const value = options.key === "phone" && (options.recovery || options.error !== undefined) ? "" : options.value;
  const hint = options.hint === undefined ? "" : `<p id="${id}-hint" class="p-hint">${escape(options.hint)}</p>`;
  const error = options.error === undefined ? "" : `<p id="${id}-error" class="p-error">${escape(options.error)}</p>`;
  if (type === "radio") {
    const choices = options.choices ?? [];
    if (!choices.length || new Set(choices.map(choice => choice.value)).size !== choices.length) throw new TypeError("Unique choices required");
    return fragment(`<fieldset class="p-choice-group"${associations}><legend>${label}</legend>${hint}${choices.map((choice, index) => `<label class="p-choice" for="${id}${index ? `-${index}` : ""}"><input id="${id}${index ? `-${index}` : ""}" type="radio" name="value" value="${escape(choice.value)}"${choice.value === value ? " checked" : ""}${required}>${escape(choice.label)}</label>`).join("")}${error}</fieldset>`);
  }
  const common = `class="p-control" id="${id}" name="value"${required}${associations}`;
  let control: string;
  if (type === "textarea") control = `<textarea ${common} dir="auto" rows="6">${escape(value)}</textarea>`;
  else if (type === "select") {
    const choices = options.choices ?? [];
    if (!choices.length || new Set(choices.map(choice => choice.value)).size !== choices.length) throw new TypeError("Unique choices required");
    if (!choices.some(choice => choice.value === value)) throw new TypeError("Select needs an explicit current or empty choice");
    control = `<select ${common}>${choices.map(choice => `<option value="${escape(choice.value)}"${choice.value === value ? " selected" : ""}>${escape(choice.label)}</option>`).join("")}</select>`;
  } else control = `<input ${common} type="${type}" dir="${options.key === "phone" || type === "tel" ? "ltr" : "auto"}" value="${escape(value)}">`;
  return fragment(`<div class="p-field"><label for="${id}">${label}</label>${hint}${control}${error}</div>`);
}
export function profileActions(saveLabel: string, cancelLabel: string, key: ProfileFieldKey): ProfileHtml {
  const id = fieldId(key);
  return fragment(`<div class="p-actions"><button class="p-button p-primary" type="submit">${escape(saveLabel)}</button><a class="p-button" href="/profile#${id}">${escape(cancelLabel)}</a></div>`);
}
export function profileErrorSummary(title: string, errors: readonly { key: ProfileFieldKey; message: string }[]): ProfileHtml {
  return fragment(`<section id="profile-error-summary" class="p-notice p-notice-error" aria-labelledby="profile-error-heading" tabindex="-1"><h2 id="profile-error-heading">${escape(title)}</h2><ul>${errors.map(error => `<li><a href="#${fieldId(error.key)}">${escape(error.message)}</a></li>`).join("")}</ul></section>`);
}
/** Caller supplies only an authorized, confirmed notice; this library performs no writes. */
export function profileNotice(title: string, message: string, kind: "success" | "error" = "success"): ProfileHtml {
  if (kind !== "success" && kind !== "error") throw new TypeError("Unsupported notice");
  return fragment(`<section id="profile-notice" class="p-notice p-notice-${kind}" aria-labelledby="profile-notice-heading" tabindex="-1"><h2 id="profile-notice-heading">${escape(title)}</h2><p><bdi class="p-value" dir="auto">${escape(message)}</bdi></p></section>`);
}
export function profileEmpty(message: string, action?: { href: string; label: string }): ProfileHtml {
  return fragment(`<div class="p-empty"><p>${escape(message)}</p>${action ? `<a class="p-edit" href="${safeHref(action.href)}">${escape(action.label)}</a>` : ""}</div>`);
}
