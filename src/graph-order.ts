// Internal identities must keep the same order across browsers, locales and the backend.
export function compareGraphIds(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0 }
