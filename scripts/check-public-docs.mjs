#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contentRoot = path.join(repoRoot, "apps/docs/content");
const pages = (await walk(contentRoot)).filter((file) => file.endsWith(".mdx")).sort();
const routes = new Map(pages.map((file) => [routeFor(file), file]));
const sources = new Map(
  await Promise.all(pages.map(async (file) => [file, await readFile(file, "utf8")])),
);
const anchors = new Map(pages.map((file) => [file, headingAnchors(sources.get(file))]));
const failures = [];
const openApiRelative = "docs/reference/openapi/grp-v0.1.openapi.json";
const openApi = JSON.parse(await readFile(path.join(repoRoot, openApiRelative), "utf8"));

for (const file of pages) {
  const source = sources.get(file);
  const relative = path.relative(repoRoot, file);
  const pageFailures = [];

  const frontmatter = source.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)?.[1];
  if (!frontmatter) {
    pageFailures.push("missing YAML frontmatter");
  } else {
    if (!/^title:\s*\S/m.test(frontmatter)) pageFailures.push("frontmatter is missing title");
    if (!/^description:\s*\S/m.test(frontmatter)) {
      pageFailures.push("frontmatter is missing description");
    }
  }

  for (const href of internalLinks(source)) {
    const route = normalizeRoute(href);
    const target = routes.get(route);
    if (!target) {
      pageFailures.push(`internal link does not resolve: ${href}`);
      continue;
    }
    const anchor = anchorFor(href);
    if (anchor && !anchors.get(target).has(anchor)) {
      pageFailures.push(`internal link anchor does not resolve: ${href}`);
    }
  }

  if (/\/docs\/conformance(?:[#?)\s"']|$)/.test(source)) {
    pageFailures.push("links to removed duplicate /docs/conformance instead of /conformance");
  }
  if (/\?(?:token|participant_token|password)(?:=|\b)/i.test(source)) {
    pageFailures.push("advertises a credential in a URL query string");
  }
  for (const line of source.split("\n")) {
    if (/--target=/.test(line) && /--profile=core|--profile\s+core/.test(line)) {
      pageFailures.push("uses --target with the offline core conformance profile");
    }
    if (
      /--target=/.test(line) &&
      /--profile=(?:transport|operator)|--profile\s+(?:transport|operator)/.test(line) &&
      !/--allow-write/.test(line)
    ) {
      pageFailures.push("live conformance command omits --allow-write");
    }
  }
  if (/Mandate and Discovery[^\n]*optional upgrades/i.test(source)) {
    pageFailures.push("describes mandatory discovery as an optional upgrade");
  }
  if (/join links?[^\n]*carry[^\n]*token[^\n]*URL/i.test(source)) {
    pageFailures.push("claims that join links carry participant credentials in the URL");
  }

  if (pageFailures.length > 0) {
    for (const failure of new Set(pageFailures)) failures.push(`${relative}: ${failure}`);
    process.stdout.write(`FAIL ${relative}\n`);
  } else {
    process.stdout.write(`PASS ${relative}\n`);
  }
}

const requiredRevisionPages = [
  "apps/docs/content/reference/mcp.mdx",
  "apps/docs/content/specification/discovery.mdx",
  "apps/docs/content/specification/transport.mdx",
];
for (const relative of requiredRevisionPages) {
  const source = await readFile(path.join(repoRoot, relative), "utf8");
  for (const revision of ["2026-07-28", "2025-11-25"]) {
    if (!source.includes(revision))
      failures.push(`${relative}: missing required MCP revision ${revision}`);
  }
}

if (routes.has("/docs/conformance")) {
  failures.push(
    "apps/docs/content/docs/conformance.mdx: duplicate conformance route must not exist",
  );
}

for (const [route, pathItem] of Object.entries(openApi.paths ?? {})) {
  for (const method of ["get", "post", "put", "patch", "delete", "options", "head", "trace"]) {
    const operation = pathItem[method];
    if (!operation) continue;
    const parameters = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])];
    for (const parameter of parameters) {
      const resolved = resolveLocalRef(parameter, openApi);
      if (
        resolved?.in === "query" &&
        /^(?:token|participant_token|creator_token|password)$/i.test(resolved.name ?? "")
      ) {
        failures.push(
          `${openApiRelative}: ${method.toUpperCase()} ${route} advertises credential query parameter ${resolved.name}`,
        );
      }
    }

    const requestSchema = operation.requestBody?.content?.["application/json"]?.schema;
    const credentialFields = schemaPropertyNames(requestSchema, openApi).filter((name) =>
      /^(?:token|participant_token|creator_token)$/i.test(name),
    );
    for (const field of credentialFields) {
      failures.push(
        `${openApiRelative}: ${method.toUpperCase()} ${route} advertises credential request-body field ${field}`,
      );
    }
  }
}

for (const [method, route] of [
  ["post", "/api/rooms/{slug}/invites"],
  ["patch", "/api/rooms/{slug}/members/{participant}"],
  ["patch", "/api/rooms/{slug}/settings"],
]) {
  const security = openApi.paths?.[route]?.[method]?.security;
  if (
    !Array.isArray(security) ||
    security.length !== 1 ||
    Object.keys(security[0] ?? {}).length !== 1 ||
    !("bearerAuth" in (security[0] ?? {}))
  ) {
    failures.push(
      `${openApiRelative}: ${method.toUpperCase()} ${route} must require bearerAuth without an unauthenticated alternative`,
    );
  }
}

if (openApi.components?.securitySchemes?.roomPassword?.name !== "X-Room-Password") {
  failures.push(`${openApiRelative}: roomPassword must use the X-Room-Password header`);
}

const conformanceReadme = await readFile(
  path.join(repoRoot, "packages/conformance/README.md"),
  "utf8",
);
if (/runConformance\(\{\s*baseUrl/s.test(conformanceReadme)) {
  failures.push("packages/conformance/README.md: runConformance uses nonexistent baseUrl option");
}
if (
  conformanceReadme
    .split("\n")
    .some(
      (line) =>
        /--profile=operator/.test(line) && /--target=/.test(line) && !/--allow-write/.test(line),
    )
) {
  failures.push("packages/conformance/README.md: live command omits --allow-write");
}

process.stdout.write(`\nChecked ${pages.length} public documentation pages.\n`);
if (failures.length > 0) {
  process.stderr.write(`\nPublic documentation check failed (${failures.length}):\n`);
  for (const failure of failures) process.stderr.write(`- ${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Public documentation check passed.\n");
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const resolved = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(resolved) : [resolved];
    }),
  );
  return nested.flat();
}

function routeFor(file) {
  const relative = path
    .relative(contentRoot, file)
    .replaceAll(path.sep, "/")
    .replace(/\.mdx$/, "");
  if (relative === "index") return "/";
  return normalizeRoute(`/${relative.replace(/\/index$/, "")}`);
}

function internalLinks(source) {
  const links = [];
  const markdown = /\]\((\/[^)\s]+)(?:\s+"[^"]*")?\)/g;
  const jsx = /\bhref=["'](\/[^"']+)["']/g;
  for (const pattern of [markdown, jsx]) {
    for (const match of source.matchAll(pattern)) links.push(match[1]);
  }
  return links;
}

function normalizeRoute(href) {
  const withoutAnchor = href.split("#", 1)[0].split("?", 1)[0];
  if (withoutAnchor === "/") return "/";
  return withoutAnchor.replace(/\/$/, "");
}

function anchorFor(href) {
  const hash = href.indexOf("#");
  if (hash === -1) return null;
  const value = href.slice(hash + 1).split("?", 1)[0];
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function headingAnchors(source) {
  const result = new Set();
  const duplicates = new Map();
  for (const match of source.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    let heading = match[1]
      .replace(/\s+#+\s*$/, "")
      .replace(/<[^>]+>/g, "")
      .replace(/!?(?:\[([^\]]+)\])\([^)]*\)/g, "$1")
      .replace(/[`*_~]/g, "")
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s+/g, "-");
    if (!heading) continue;
    const count = duplicates.get(heading) ?? 0;
    duplicates.set(heading, count + 1);
    if (count > 0) heading = `${heading}-${count}`;
    result.add(heading);
  }
  return result;
}

function resolveLocalRef(value, document) {
  if (!value?.$ref?.startsWith("#/")) return value;
  return value.$ref
    .slice(2)
    .split("/")
    .reduce(
      (node, segment) => node?.[segment.replaceAll("~1", "/").replaceAll("~0", "~")],
      document,
    );
}

function schemaPropertyNames(schema, document, seen = new Set()) {
  if (!schema) return [];
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return [];
    const nextSeen = new Set(seen).add(schema.$ref);
    return schemaPropertyNames(resolveLocalRef(schema, document), document, nextSeen);
  }
  const names = Object.keys(schema.properties ?? {});
  for (const property of Object.values(schema.properties ?? {})) {
    names.push(...schemaPropertyNames(property, document, seen));
  }
  for (const branch of [
    ...(schema.allOf ?? []),
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
  ]) {
    names.push(...schemaPropertyNames(branch, document, seen));
  }
  if (schema.items) names.push(...schemaPropertyNames(schema.items, document, seen));
  return names;
}
