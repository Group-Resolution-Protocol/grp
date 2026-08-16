// Nextra v4 (App Router) — wires the MDX pipeline + the docs theme.
// Per https://nextra.site, the recommended setup at v4 is to wrap the
// Next.js config with the `nextra` plugin from the package's exported
// factory. The MDX content lives under `content/` (or `app/`); page
// metadata comes from `_meta.{ts,js}` files in each directory.

import nextra from "nextra";

const withNextra = nextra({
  // Dark mode + good prose typography come from nextra-theme-docs by
  // default; no extra config needed at this stage.
});

const config = {
  reactStrictMode: true,
  experimental: {
    devtoolSegmentExplorer: false,
  },
  // Static export keeps deployment simple — push to Cloudflare Pages, S3,
  // or GitHub Pages without a Node runtime. Disabled for now while we
  // iterate locally; flip on in CI.
  // output: "export",
  // NodeNext-style `./foo.js` imports of `.ts` files need explicit
  // webpack alias — Next.js's resolver doesn't honor them by default.
  webpack: (cfg) => {
    cfg.resolve = cfg.resolve ?? {};
    cfg.resolve.extensionAlias = {
      ...(cfg.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    };
    return cfg;
  },
};

export default withNextra(config);
