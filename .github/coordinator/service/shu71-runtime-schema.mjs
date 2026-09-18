import fs from 'node:fs';

// Deliberately bounded JSON Schema evaluator: unknown assertion keywords refuse.
// The committed schema is read by both report emitters, not copied into code.
export function runtimeRowSchema() {
  return JSON.parse(fs.readFileSync(new URL('./shu71-runtime-row.schema.json', import.meta.url), 'utf8'));
}
export function matchesSchema(value, schema) {
  const known = ['$schema', 'title', 'type', 'oneOf', 'allOf', 'if', 'then', 'else', 'properties', 'required', 'additionalProperties', 'const', 'enum', 'minimum', 'pattern'];
  if (!schema || typeof schema !== 'object' || Object.keys(schema).some(k => !known.includes(k))) throw new Error('ACT_RUNTIME_SCHEMA_INVALID');
  if (schema.type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) return false;
  if (schema.type === 'integer' && !Number.isInteger(value)) return false;
  if (schema.type === 'string' && typeof value !== 'string') return false;
  if (schema.type && !['object', 'integer', 'string'].includes(schema.type)) throw new Error('ACT_RUNTIME_SCHEMA_INVALID');
  if ('const' in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if ('minimum' in schema && value < schema.minimum) return false;
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
  if (schema.required && !schema.required.every(k => Object.hasOwn(value, k))) return false;
  if (schema.properties && !Object.entries(schema.properties).every(([k, s]) => !Object.hasOwn(value, k) || matchesSchema(value[k], s))) return false;
  if (schema.additionalProperties === false && Object.keys(value).some(k => !Object.hasOwn(schema.properties ?? {}, k))) return false;
  if (schema.oneOf && schema.oneOf.filter(s => matchesSchema(value, s)).length !== 1) return false;
  if (schema.allOf && !schema.allOf.every(s => matchesSchema(value, s))) return false;
  if (schema.if && !matchesSchema(value, matchesSchema(value, schema.if) ? schema.then ?? {} : schema.else ?? {})) return false;
  return true;
}
export function validateRuntimeRow(row, schema = runtimeRowSchema()) {
  if (!matchesSchema(row, schema)) throw Object.assign(new Error('ACT_RUNTIME_ROW_SCHEMA'), { code: 'ACT_RUNTIME_ROW_SCHEMA' });
  return row;
}
