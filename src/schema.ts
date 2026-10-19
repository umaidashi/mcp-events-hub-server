import { canonicalJson, type JsonSchema } from "./protocol.ts";

// ponytail: only type/properties/required/additionalProperties:false/enum/items are enforced;
// format, patterns, numeric bounds, oneOf/anyOf/$ref are ignored. Swap in a full validator if
// services start relying on them.
export function validate(schema: JsonSchema, value: unknown, path = "$"): string[] {
  const errors: string[] = [];
  if (schema.type && !hasType(schema.type, value)) return [`${path}: expected ${schema.type}`];
  if (schema.enum && !schema.enum.some((e) => canonicalJson(e) === canonicalJson(value))) {
    errors.push(`${path}: must be one of ${canonicalJson(schema.enum)}`);
  }
  if (isObject(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}.${key}: required`);
    }
    for (const [key, v] of Object.entries(value)) {
      const sub = schema.properties?.[key];
      if (sub) errors.push(...validate(sub, v, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: not allowed`);
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((v, i) => errors.push(...validate(schema.items!, v, `${path}[${i}]`)));
  }
  return errors;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasType(type: string, value: unknown): boolean {
  switch (type) {
    case "object": return isObject(value);
    case "array": return Array.isArray(value);
    case "null": return value === null;
    case "integer": return Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "string": case "boolean": return typeof value === type;
    default: return true;
  }
}
