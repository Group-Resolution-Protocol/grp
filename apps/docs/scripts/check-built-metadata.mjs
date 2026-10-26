// Check the generated HTML, not just source strings: nested route metadata can
// silently override the site's search description or inherit the wrong social card.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../.next/server/app/", import.meta.url);
const decode = (value) =>
  value.replaceAll("&amp;", "&").replaceAll("&#x27;", "'").replaceAll("&quot;", '"');
const readMeta = (html, key) => {
  const tags = [...html.matchAll(/<meta\s[^>]*>/g)].map(([tag]) => tag);
  const matching = tags.filter(
    (tag) => tag.includes(`name="${key}"`) || tag.includes(`property="${key}"`),
  );
  assert.equal(matching.length, 1, `Exactly one ${key} tag`);
  const content = matching[0].match(/content="([^"]*)"/);
  assert(content, `${key} has content`);
  return decode(content[1]);
};

for (const [path, title] of [
  ["index.html", "GRP — Multi-agent collaboration and coordination"],
  ["docs.html", "Introduction"],
  ["blog/agents-that-come-back.html", "Multi-agent collaboration without always-running agents"],
]) {
  const html = readFileSync(new URL(path, root), "utf8");
  const description = readMeta(html, "description");
  const route = path === "index.html" ? "" : path.replace(/\.html$/, "");
  // Next normalizes the root URL without a trailing slash.
  const canonical = `https://grp.dev${route ? `/${route}` : ""}`;
  assert(html.includes(`<link rel="canonical" href="${canonical}"`), path);
  assert.equal(readMeta(html, "og:url"), canonical, path);
  assert.match(description, /multi-agent collaboration/i, path);
  assert.equal(readMeta(html, "og:title"), title, path);
  assert.equal(readMeta(html, "twitter:title"), title, path);
  assert.equal(readMeta(html, "og:description"), description, path);
  assert.equal(readMeta(html, "twitter:description"), description, path);
  assert(html.includes(`<title>${title}`), path);
  if (path === "index.html") assert(!html.includes("GRP v0.2 is in beta"));
  console.log(`PASS generated search/social metadata: ${path}`);
}
