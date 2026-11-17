#!/usr/bin/env node
/**
 * normalize-mdx.mjs — make generated MDX safe for the static export.
 *
 * The Groq generator emits shapes that break `next build`. This script
 * rewrites them into valid MDX. It is idempotent and safe to run on every
 * generated post (run-publish.sh and generate.yml call it after generation).
 *
 * Fixes applied:
 *  1. <Answer>…</Answer> — `Answer` is not a defined MDX component.
 *     Unwrapped (text kept); Question renders its children as the answer.
 *  2. Block components opened with text on the same line and the closing
 *     tag on a later line (`<Callout type="warning">text` … `</Callout>`) —
 *     MDX rejects this. Rewritten to: tag alone, body alone, close alone.
 *     Single-line `<Tag>text</Tag>` is already valid and left alone.
 *  3. Backslash-escaped quotes inside JSX tags (`type=\"takeaway\"`) —
 *     the generator double-encodes quotes through a JSON layer. The `\`
 *     before each `"` inside a tag is removed.
 *  4. Raw `<` in prose (`(<$15M)`, `(<1 day)`, `<3I/ATLAS`) — MDX reads
 *     `<` + `$`/digit as a JSX tag start. Escaped to `&lt;` (outside tags
 *     only; real tags are untouched).
 *  5. Flow-style frontmatter hero (`hero: { url: "...", ... }`) — the MDX
 *     frontmatter parser chokes on it ("Could not parse expression with
 *     acorn"). Rewritten to block YAML.
 *
 * Usage: node scripts/normalize-mdx.mjs [content-dir]
 * Default content dir: content/ (relative to the repo root / cwd).
 * Prints a per-file summary. Exits 0.
 */
import fs from 'node:fs';
import path from 'node:path';

const BLOCK_TAGS = ['Callout', 'Question', 'FAQ', 'Pros', 'Cons', 'ProsCons', 'GearBox', 'GearPick'];
const TAG_NAMES = new Set([...BLOCK_TAGS, 'AffiliateDisclosure', 'li', 'a', 'strong', 'em', 'code', 'br', 'span', 'div', 'p', 'ul', 'ol', 'b', 'i', 'sub', 'sup']);

// Split a line into [isTag, text] segments so prose fixes never touch tags.
function splitTags(line) {
  const segs = [];
  const re = /<\/?[A-Za-z][^>]*>/g;
  let last = 0;
  let m;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) segs.push([false, line.slice(last, m.index)]);
    segs.push([true, m[0]]);
    last = m.index + m[0].length;
  }
  if (last < line.length) segs.push([false, line.slice(last)]);
  return segs;
}

function normalizeFile(file) {
  let text = fs.readFileSync(file, 'utf8');
  const original = text;
  const counts = { answers: 0, reshaped: 0, backslashes: 0, rawLt: 0, heroFlow: 0 };

  // Split frontmatter (YAML — leave alone except the hero fix) from body (MDX).
  let front = '';
  let body = text;
  const fm = text.match(/^---\n[\s\S]*?\n---\n/);
  if (fm) {
    front = fm[0];
    body = text.slice(fm[0].length);
  }

  // 5. Flow-style hero in frontmatter -> block YAML.
  front = front.replace(/^hero: \{ (.*) \}$/m, (whole, inner) => {
    const pairs = [...inner.matchAll(/(\w+): "((?:[^"\\]|\\.)*)"/g)];
    if (pairs.length < 2) return whole;
    counts.heroFlow++;
    const lines = ['hero:'];
    for (const [, k, v] of pairs) lines.push(`  ${k}: "${v}"`);
    return lines.join('\n');
  });

  // 1. Unwrap <Answer>…</Answer> (keep the text).
  const openCount = (body.match(/<Answer\b[^>]*>/g) || []).length;
  if (openCount) {
    body = body.replace(/<Answer\b[^>]*>/g, '').replace(/<\/Answer>/g, '');
    counts.answers = openCount;
  }

  // 3. Backslash-escaped quotes inside JSX tags: \" -> " (repeat for double encoding).
  // 4. Raw `<` in prose: `<` + $/digit outside tags -> &lt;
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const segs = splitTags(lines[i]);
    lines[i] = segs.map(([isTag, s]) => {
      if (isTag) {
        let t = s;
        let guard = 0;
        while (t.includes('\\"') && guard++ < 3) {
          t = t.replace(/\\"/g, '"');
          counts.backslashes++;
        }
        return t;
      }
      // prose: escape < when followed by $ or a digit (would parse as a tag)
      const replaced = s.replace(/<(?=[$0-9])/g, '&lt;');
      if (replaced !== s) counts.rawLt += (s.match(/<(?=[$0-9])/g) || []).length;
      return replaced;
    }).join('');
  }
  body = lines.join('\n');

  // 2. Reshape broken multi-line block components.
  const out = body.split('\n');
  for (let i = 0; i < out.length; i++) {
    const line = out[i];
    for (const tag of BLOCK_TAGS) {
      const openRe = new RegExp(`<${tag}\\b[^>]*>`);
      const m = openRe.exec(line);
      if (!m) continue;
      const rest = line.slice(m.index + m[0].length);
      if (!rest.trim() || rest.includes(`</${tag}>`)) continue;
      let j = i + 1;
      while (j < out.length && !out[j].includes(`</${tag}>`)) j++;
      if (j >= out.length) continue;
      const closeIdx = out[j].indexOf(`</${tag}>`);
      const after = out[j].slice(closeIdx + `</${tag}>`.length);
      const indent = line.slice(0, m.index);
      const openTag = line.slice(m.index, m.index + m[0].length);
      const bodyLines = [rest, ...out.slice(i + 1, j), out[j].slice(0, closeIdx)].filter((b) => b.trim());
      out.splice(i, j - i + 1, indent + openTag, ...bodyLines, indent + `</${tag}>` + after);
      counts.reshaped++;
      break;
    }
  }
  body = out.join('\n');

  text = front + body;
  if (text !== original) {
    fs.writeFileSync(file, text);
    return counts;
  }
  return null;
}

function* walkMdx(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkMdx(full);
    else if (entry.isFile() && entry.name.endsWith('.mdx')) yield full;
  }
}

const contentDir = process.argv[2] || path.join(process.cwd(), 'content');
let filesChanged = 0;
const totals = { answers: 0, reshaped: 0, backslashes: 0, rawLt: 0, heroFlow: 0 };
for (const file of walkMdx(contentDir)) {
  const result = normalizeFile(file);
  if (result) {
    filesChanged++;
    for (const k of Object.keys(totals)) totals[k] += result[k];
    console.log(`${path.relative(process.cwd(), file)}: ${JSON.stringify(result)}`);
  }
}
console.log(`normalize-mdx: ${filesChanged} file(s) changed, ${JSON.stringify(totals)}`);
