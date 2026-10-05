const ROTATION_STATES = new Set(["rotate-revoke", "operator-check", "db-state-unknown", "none"]);
const DISPOSITIONS = new Set(["keep", "replace", "drop", "pending"]);
const REQUIRED_FIELDS = ["id", "name", "owner", "owner_cards", "credential_names", "rotation_state", "disposition", "notes"];
const ARRAY_FIELDS = new Set(["owner_cards", "credential_names"]);

function isEmpty(value) {
  return value === undefined || value === null || (typeof value === "string" && !value.trim()) || (Array.isArray(value) && value.length === 0);
}

function looksLikeValue(value) {
  return /(?:https?:\/\/|\b[A-Za-z][A-Za-z0-9+.-]*:\/\/)/i.test(value)
    || /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/.test(value)
    || /\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(value)
    || /(?=[A-Za-z0-9]{20,})(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{20,}/.test(value);
}

export function validateRegister(register) {
  const errors = [];
  if (!register || register.schemaVersion !== 1) errors.push("register schemaVersion is missing or invalid");
  if (!Array.isArray(register?.integrations) || register.integrations.length === 0) {
    errors.push("register integrations is missing or empty");
    return { ok: false, errors };
  }
  const ids = new Set();
  for (const [index, entry] of register.integrations.entries()) {
    const id = typeof entry?.id === "string" && entry.id ? entry.id : `entry-${index + 1}`;
    for (const field of REQUIRED_FIELDS) if (isEmpty(entry?.[field]) && !(["credential_names"].includes(field) && Array.isArray(entry?.[field]))) errors.push(`${id} ${field} is missing or empty`);
    if (ids.has(entry?.id)) errors.push(`${id} id is duplicated`);
    ids.add(entry?.id);
    if (!ROTATION_STATES.has(entry?.rotation_state)) errors.push(`${id} rotation_state has an unknown value`);
    if (!DISPOSITIONS.has(entry?.disposition)) errors.push(`${id} disposition has an unknown value`);
    for (const [field, value] of Object.entries(entry ?? {})) {
      if (!REQUIRED_FIELDS.includes(field)) errors.push(`${id} ${field} is not a register field`);
      else if (ARRAY_FIELDS.has(field) ? !Array.isArray(value) || value.some((item) => typeof item !== "string") : typeof value !== "string") errors.push(`${id} ${field} has the wrong type`);
      const values = Array.isArray(value) ? value : [value];
      if (values.some((item) => typeof item === "string" && looksLikeValue(item))) errors.push(`${id} ${field} contains a secret value or location`);
    }
  }
  return { ok: errors.length === 0, errors };
}
