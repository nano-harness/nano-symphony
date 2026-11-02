/**
 * Minimal JSON Schema validator for emit_result output schema validation.
 * Supports type, required, properties, items, enum, minimum, maximum, minLength, maxLength.
 * Intentionally lightweight — no external dependencies.
 */

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

export function validateSchema(schema: unknown, data: unknown): ValidationResult {
  const errors: string[] = [];
  validateNode(schema, data, "$", errors);
  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

function validateNode(schema: unknown, data: unknown, path: string, errors: string[]): void {
  if (!schema || typeof schema !== "object") return;
  const s = schema as Record<string, unknown>;

  // type check
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some(t => matchesType(t as string, data))) {
      errors.push(`${path}: expected type ${types.join("|")}, got ${typeof data}`);
      return; // no point validating further if type is wrong
    }
  }

  // enum
  if (Array.isArray(s.enum)) {
    if (!s.enum.some(v => deepEqual(v, data))) {
      errors.push(`${path}: value not in enum [${s.enum.map(v => JSON.stringify(v)).join(", ")}]`);
    }
    return;
  }

  if (typeof data === "string") {
    if (typeof s.minLength === "number" && data.length < s.minLength) {
      errors.push(`${path}: string length ${data.length} < minLength ${s.minLength}`);
    }
    if (typeof s.maxLength === "number" && data.length > s.maxLength) {
      errors.push(`${path}: string length ${data.length} > maxLength ${s.maxLength}`);
    }
  }

  if (typeof data === "number") {
    if (typeof s.minimum === "number" && data < s.minimum) {
      errors.push(`${path}: ${data} < minimum ${s.minimum}`);
    }
    if (typeof s.maximum === "number" && data > s.maximum) {
      errors.push(`${path}: ${data} > maximum ${s.maximum}`);
    }
  }

  if (Array.isArray(data) && s.items) {
    if (typeof s.minItems === "number" && data.length < s.minItems) {
      errors.push(`${path}: array length ${data.length} < minItems ${s.minItems}`);
    }
    if (typeof s.maxItems === "number" && data.length > s.maxItems) {
      errors.push(`${path}: array length ${data.length} > maxItems ${s.maxItems}`);
    }
    for (let i = 0; i < data.length; i++) {
      validateNode(s.items, data[i], `${path}[${i}]`, errors);
    }
  }

  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;

    // required
    if (Array.isArray(s.required)) {
      for (const key of s.required) {
        if (!(key in obj)) {
          errors.push(`${path}: missing required property '${key}'`);
        }
      }
    }

    // properties
    if (s.properties && typeof s.properties === "object") {
      const props = s.properties as Record<string, unknown>;
      for (const [key, propSchema] of Object.entries(props)) {
        if (key in obj) {
          validateNode(propSchema, obj[key], `${path}.${key}`, errors);
        }
      }
    }

    // additionalProperties: false
    if (s.additionalProperties === false && s.properties && typeof s.properties === "object") {
      const allowedKeys = new Set(Object.keys(s.properties as object));
      for (const key of Object.keys(obj)) {
        if (!allowedKeys.has(key)) {
          errors.push(`${path}: additional property '${key}' not allowed`);
        }
      }
    }
  }
}

function matchesType(type: string, data: unknown): boolean {
  switch (type) {
    case "string": return typeof data === "string";
    case "number": return typeof data === "number";
    case "integer": return typeof data === "number" && Number.isInteger(data);
    case "boolean": return typeof data === "boolean";
    case "array": return Array.isArray(data);
    case "object": return data !== null && typeof data === "object" && !Array.isArray(data);
    case "null": return data === null;
    default: return true;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.join(",") !== kb.join(",")) return false;
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    return ka.every(k => deepEqual(ao[k], bo[k]));
  }
  return false;
}
