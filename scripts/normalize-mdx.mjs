#!/usr/bin/env node
/**
 * normalize-mdx.mjs — make generated MDX safe for the static export.
 *
 * The Groq generator emits two shapes that break `next build`:
 *  1. <Answer>…</Answer> inside <Question> — `Answer` is not a defined MDX
 *     component, so prerendering fails ("Expected component `Answer` to be
 *     defined"). The Question component renders its children as the answer,
 *     so the tags are dropped and the text is kept.
 *  2. Block components opened with text on the same line and the closing tag
 *     on a later line, e.g. `<Callout type="warning">text` … `</Callout>` —
 *     MDX rejects this ("Expected a closing tag before the end of
 *     paragraph"). Rewritten to the safe form: opening tag alone on its
 *     line, body on its own line(s), closing tag alone on its line.
 *     Single-line `<Tag>text</Tag>` is already valid and left alone.
 *
 * Usage: node scripts/normalize-mdx.mjs [content-dir]
 * Default content dir: content/ (relative to the repo root / cwd).
 * Prints a per-file summary. Exits 0.
 */
import fs from 'node:fs';
import path from 'node:path';

const BLOCK_TAGS = ['Callout', 'Question', 'FAQ', 'Pros', 'Cons', 'ProsCons', 'GearBox', 'GearPick'];

function* walkMdx(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkMdx(full);
    else if (entry.isFile() && entry.name.endsWith('.mdx')) yield full;
  }
}

function normalizeFile(file) {
  let text = fs.readFileSync(file, 'utf8');
  const original = text;
  let answers = 0;
  let reshaped = 0;

  // 1. Unwrap <Answer>…</Answer> (keep the text).
  const openCount = (text.match(/<Answer\b[^>]*>/g) || []).length;
  const closeCount = (text.match(/<\/Answer>/g) || []).length;
  if (openCount || closeCount) {
    text = text.replace(/<Answer\b[^>]*>/g, '').replace(/<\/Answer>/g, '');
    answers = Math.max(openCount, closeCount);
  }

  // 2. Reshape broken multi-line block components.
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const tag of BLOCK_TAGS) {
      const openRe = new RegExp(`<${tag}\\b[^>]*>`);
      const m = openRe.exec(line);
      if (!m) continue;
      const rest = line.slice(m.index + m[0].length);
      if (!rest.trim() || rest.includes(`</${tag}>`)) continue;
      // Find the closing tag on a later line.
      let j = i + 1;
      while (j < lines.length && !lines[j].includes(`</${tag}>`)) j++;
      if (j >= lines.length) continue; // no closing tag at all; leave for the build to report
      const closeIdx = lines[j].indexOf(`</${tag}>`);
      const after = lines[j].slice(closeIdx + `</${tag}>`.length);
      const indent = line.slice(0, m.index);
      const openTag = line.slice(m.index, m.index + m[0].length);
      const body = [rest, ...lines.slice(i + 1, j), lines[j].slice(0, closeIdx)].filter((b) => b.trim());
      lines.splice(i, j - i + 1, indent + openTag, ...body, indent + `</${tag}>` + after);
      reshaped++;
      break; // re-scan this (now safe) line region on the next iteration
    }
  }
  text = lines.join('\n');

  if (text !== original) {
    fs.writeFileSync(file, text);
    return { answers, reshaped };
  }
  return null;
}

const contentDir = process.argv[2] || path.join(process.cwd(), 'content');
let filesChanged = 0;
let totalAnswers = 0;
let totalReshaped = 0;
for (const file of walkMdx(contentDir)) {
  const result = normalizeFile(file);
  if (result) {
    filesChanged++;
    totalAnswers += result.answers;
    totalReshaped += result.reshaped;
    console.log(`${path.relative(process.cwd(), file)}: unwrapped ${result.answers} <Answer>, reshaped ${result.reshaped} block(s)`);
  }
}
console.log(`normalize-mdx: ${filesChanged} file(s) changed, ${totalAnswers} <Answer> unwrapped, ${totalReshaped} block(s) reshaped`);
