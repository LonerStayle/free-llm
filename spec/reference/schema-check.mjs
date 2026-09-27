// models.schema.json 이 쓰는 JSON Schema 부분집합만 지원하는 작은 검사기 (의존성 없음).
// 지원: type, properties, required, additionalProperties, propertyNames, items, minItems,
//       minProperties, enum, minimum, maximum, exclusiveMinimum, minLength, pattern, not, $ref(#/$defs/..)

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(want, v) {
  const t = typeOf(v);
  return want === t || (want === 'number' && t === 'integer');
}

export function validate(schema, value, root = schema, path = '$') {
  const errors = [];
  const s = schema.$ref ? resolve(root, schema.$ref) : schema;
  if (s.type) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => typeMatches(t, value))) {
      errors.push(`${path}: expected ${types.join('|')}, got ${typeOf(value)}`);
      return errors;
    }
  }
  if (s.enum && !s.enum.some((e) => e === value)) errors.push(`${path}: not in enum`);
  if (s.not && validate(s.not, value, root, path).length === 0) errors.push(`${path}: matches forbidden schema`);
  if (typeof value === 'string') {
    if (s.minLength != null && value.length < s.minLength) errors.push(`${path}: shorter than ${s.minLength}`);
    if (s.pattern && !new RegExp(s.pattern, 'u').test(value)) errors.push(`${path}: does not match ${s.pattern}`);
  }
  if (typeof value === 'number') {
    if (s.minimum != null && value < s.minimum) errors.push(`${path}: < ${s.minimum}`);
    if (s.maximum != null && value > s.maximum) errors.push(`${path}: > ${s.maximum}`);
    if (s.exclusiveMinimum != null && value <= s.exclusiveMinimum) errors.push(`${path}: <= ${s.exclusiveMinimum}`);
  }
  if (Array.isArray(value)) {
    if (s.minItems != null && value.length < s.minItems) errors.push(`${path}: fewer than ${s.minItems} items`);
    if (s.items) value.forEach((v, i) => errors.push(...validate(s.items, v, root, `${path}[${i}]`)));
  }
  if (typeOf(value) === 'object') {
    const keys = Object.keys(value);
    if (s.minProperties != null && keys.length < s.minProperties) errors.push(`${path}: fewer than ${s.minProperties} properties`);
    for (const r of s.required ?? []) if (!(r in value)) errors.push(`${path}: missing ${r}`);
    for (const k of keys) {
      const p = `${path}.${k}`;
      if (s.propertyNames) errors.push(...validate(s.propertyNames, k, root, `${p}(name)`));
      if (s.properties && k in s.properties) errors.push(...validate(s.properties[k], value[k], root, p));
      else if (s.additionalProperties === false) errors.push(`${p}: not allowed`);
      else if (s.additionalProperties && typeof s.additionalProperties === 'object') {
        errors.push(...validate(s.additionalProperties, value[k], root, p));
      }
    }
  }
  return errors;
}

function resolve(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`unsupported $ref ${ref}`);
  return ref
    .slice(2)
    .split('/')
    .reduce((o, k) => o[k], root);
}
