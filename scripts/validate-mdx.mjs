#!/usr/bin/env node
/**
 * validate-mdx.mjs — compile every post with the real MDX compiler and
 * report every file that would break `next build`.
 *
 * Catches what the normalizer cannot fix by pattern alone:
 *   - raw `<` in prose (e.g. `(<$15M)`) parsed as a JSX tag start
 *   - malformed attributes, unclosed tags, other MDX syntax errors
 *   - JSX components that are not defined by the site (allowlist check)
 *
 * Usage (from a repo root): node scripts/validate-mdx.mjs [content-dir]
 * Prints one line per broken file: <file>: <first error line>.
 * Exits 0 when clean, 1 when any file fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { compileMDX } from 'next-mdx-remote/rsc';

const DEFINED_COMPONENTS = new Set([
  'Callout', 'ProsCons', 'Pros', 'Cons', 'FAQ', 'Question',
  'GearBox', 'GearPick', 'AffiliateDisclosure',
]);
// Lowercase HTML elements the posts legitimately use.
const HTML_TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'code', 'div', 'em', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 'section', 'span',
  'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'u', 'ul',
]);

function* walkMdx(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkMdx(full);
    else if (entry.isFile() && entry.name.endsWith('.mdx')) yield full;
  }
}

function undefinedComponents(source) {
  const bad = new Set();
  for (const m of source.matchAll(/<([A-Z][A-Za-z0-9]*)\b/g)) {
    if (!DEFINED_COMPONENTS.has(m[1])) bad.add(m[1]);
  }
  return [...bad];
}

const contentDir = process.argv[2] || path.join(process.cwd(), 'content');
const files = [...walkMdx(contentDir)];
let failures = 0;
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const rel = path.relative(process.cwd(), file);
  const bad = undefinedComponents(source);
  if (bad.length) {
    console.log(`${rel}: UNDEFINED COMPONENT(S): ${bad.join(', ')}`);
    failures++;
    continue;
  }
  try {
    await compileMDX({ source });
  } catch (err) {
    const lines = String(err?.message || err).split('\n').map((l) => l.trim()).filter(Boolean);
    const detail = lines.find((l) => /Unexpected|Expected a closing|Expected component|Could not parse/.test(l)) || lines[1] || lines[0] || 'unknown error';
    console.log(`${rel}: ${detail}`);
    failures++;
  }
}
console.log(`validate-mdx: ${files.length} files, ${failures} broken`);
process.exit(failures ? 1 : 0);
