export function assert(cond, message) {
  if (!cond) throw new Error(`Assertion failed: ${message}`);
}

export function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`Assertion failed: ${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}
