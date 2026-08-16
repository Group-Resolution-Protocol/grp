// Top-level nav. Each entry is a folder under `content/` plus a label.
// `display: "hidden"` keeps the homepage out of the sidebar (it's the root).
//
// Navbar: two plain links (Docs, Specification) + two menus (Build,
// Community). Sidebar: every section is `type: "doc"`, so the FULL tree
// renders on every page — a type:"page" section only shows its subtree
// while active, which made the sidebar appear truncated on /conformance
// and friends.
//
// Spec 177 — the old validation-corpus and paper placeholders remain out of
// the site navigation. Worked examples are live here; the no-runner evidence
// kits ship in the clean repository. The GitHub link stays withheld until the
// principal creates that repository and the release lands.

export default {
  index: { type: "page", display: "hidden", title: "Home" },
  docsLink: { type: "page", title: "Docs", href: "/docs" },
  specificationLink: { type: "page", title: "Specification", href: "/specification" },
  build: {
    type: "menu",
    title: "Build",
    items: {
      reference: { title: "Reference", href: "/reference" },
      examples: { title: "Examples", href: "/examples" },
      conformance: { title: "Conformance", href: "/conformance" },
      "open-source": { title: "Open source", href: "/open-source" },
      changelog: { title: "Changelog", href: "/changelog" },
    },
  },
  community: {
    type: "menu",
    title: "Community",
    items: {
      community: { title: "Community", href: "/community" },
      blog: { title: "Blog", href: "/blog" },
    },
  },
  docs: { type: "doc", title: "Docs" },
  specification: { type: "doc", title: "Specification" },
  reference: { type: "doc", title: "Reference" },
  conformance: { type: "doc", title: "Conformance" },
  examples: { type: "doc", title: "Examples" },
  "open-source": { type: "doc", title: "Open source" },
  changelog: { type: "doc", title: "Changelog" },
  blog: { type: "doc", title: "Blog" },
};
