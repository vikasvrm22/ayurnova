export function assert(cond, message) {
  if (!cond) throw new Error(`Assertion failed: ${message}`);
}

export function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`Assertion failed: ${message}\n  actual:   ${a}\n  expected: ${e}`);
}
