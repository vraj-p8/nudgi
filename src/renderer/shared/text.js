// Replaces {placeholders} in user-authored reminder text. Unknown keys are left as-is.
export function fill(str, vars = {}) {
  return String(str ?? '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? vars[k] === 0 ? String(vars[k]) : m));
}
