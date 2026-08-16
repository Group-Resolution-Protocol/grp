// Nextra v4 — MDX component map. Re-exports the docs theme's components
// and lets us shadow any of them. Keeping the default for now; we can
// swap in custom variants for callouts, code groups, etc., as the site
// grows.

import { useMDXComponents as getDocsMDXComponents } from "nextra-theme-docs";

export const useMDXComponents = getDocsMDXComponents;
