// Per spec 104 — RFC 8785 / JCS canonical JSON serialization.
// The single allowed serializer for hash-chain inputs.
//
// Properties enforced:
// - Object keys sorted lexicographically (UTF-16 code-unit order per RFC 8785)
// - Numbers normalized: no leading zeros, no trailing zeros, lowercase 'e'
// - Strings preserved exactly (RFC 8785 forbids Unicode normalization)
// - Invalid Unicode lone surrogates rejected
// - No whitespace
// - Booleans: literal `true`/`false`
// - null: literal `null`
// - Arrays preserve order
// - undefined / functions / symbols: rejected

export class CanonicalizationError extends Error {
  constructor(
    message: string,
    public readonly path: string,
  ) {
    super(`${message} at ${path}`);
    this.name = "CanonicalizationError";
  }
}

export function canonicalize(value: unknown, path = "$"): string {
  if (value === null) return "null";
  if (value === undefined) {
    throw new CanonicalizationError("undefined is not JSON-serializable", path);
  }

  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") return canonicalizeNumber(value as number, path);
  if (t === "string") {
    const stringValue = value as string;
    assertValidUnicode(stringValue, path);
    return JSON.stringify(stringValue);
  }
  if (t === "bigint") {
    throw new CanonicalizationError("bigint is not JSON-serializable; encode as string", path);
  }
  if (t === "function" || t === "symbol") {
    throw new CanonicalizationError(`${t} is not JSON-serializable`, path);
  }

  if (Array.isArray(value)) {
    const items = value.map((v, i) => canonicalize(v, `${path}[${i}]`));
    return `[${items.join(",")}]`;
  }

  if (t === "object") {
    const entries = Object.entries(value as object);
    // RFC 8785 §3.2.3 — sort by UTF-16 code units. JS string compare is
    // already that order, but be explicit so a future locale-aware sort
    // doesn't accidentally creep in.
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const pieces = entries.map(([k, v]) => {
      assertValidUnicode(k, `${path}.[key:${k}]`);
      const ck = JSON.stringify(k);
      return `${ck}:${canonicalize(v, `${path}.${k}`)}`;
    });
    return `{${pieces.join(",")}}`;
  }

  throw new CanonicalizationError(`unsupported value type: ${t}`, path);
}

function canonicalizeNumber(n: number, path: string): string {
  if (!Number.isFinite(n)) {
    throw new CanonicalizationError("non-finite numbers are not JSON-serializable", path);
  }
  // JSON.stringify delegates to ECMAScript's required shortest round-tripping
  // representation, including -0 → 0 and the RFC's exponent thresholds.
  const serialized = JSON.stringify(n);
  if (serialized === undefined) {
    throw new CanonicalizationError("number could not be serialized", path);
  }
  return serialized;
}

/** RFC 8785 §3.2.2.2: lone UTF-16 surrogates are invalid input. */
function assertValidUnicode(value: string, path: string): void {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new CanonicalizationError("lone high surrogate is not valid Unicode", path);
      }
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new CanonicalizationError("lone low surrogate is not valid Unicode", path);
    }
  }
}
