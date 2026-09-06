/**
 * Test stub for the `server-only` package.
 *
 * The real package throws when imported outside a React Server Component, which
 * is what stops server modules leaking into a client bundle. Under vitest there
 * is no such boundary and the throw only prevents the module being tested at
 * all, so it is aliased to this empty module in vitest.config.ts.
 *
 * The production build still resolves the real package, so the guarantee is
 * unchanged where it matters.
 */
export {};
