/**
 * Wave 2 item 6: every glossary key is wired to a "What does this mean?" button somewhere — the literal keys found in
 * the components and pages (explainKey="…", metricKey="…", a section header's explainKey: '…') plus the dynamic surfaces
 * (lib/analyst/explainSurfaces.ts: tiles by trend metric, funnel stages and chips, time in stage, campaign columns).
 * A literal that is not a glossary key is a typo and fails too. (The Playwright audit, `npm run screenshots --
 * --explain-audit`, checks the same on the rendered demo-seeded pages.)
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { GLOSSARY_KEYS } from '@/lib/metrics/glossary';
import { dynamicExplainKeys } from '@/lib/analyst/explainSurfaces';

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(e.name)) out.push(p);
  }
  return out;
}

export function literalExplainKeys(files: string[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    // explainKey="x" · explainKey={'x'} · explainKey: 'x' (a section header's list) · metricKey="x"
    for (const m of text.matchAll(/(?:explainKey|metricKey)(?:=|: )(?:"([a-z_]+)"|'([a-z_]+)'|\{'([a-z_]+)'\})/g)) {
      const k = m[1] ?? m[2] ?? m[3];
      found.set(k, [...(found.get(k) ?? []), path.relative(process.cwd(), f)]);
    }
  }
  return found;
}

describe('"What does this mean?" coverage', () => {
  const files = [...walk(path.join(process.cwd(), 'components')), ...walk(path.join(process.cwd(), 'app'))];
  const literals = literalExplainKeys(files);
  const dynamic = new Set(dynamicExplainKeys());

  it('every glossary key has a button: a literal in the source or a dynamic surface', () => {
    const wired = new Set([...literals.keys(), ...dynamic]);
    const missing = GLOSSARY_KEYS.filter((k) => !wired.has(k));
    expect(missing, `glossary keys with no "What does this mean?" button: ${missing.join(', ')}`).toEqual([]);
  });

  it('every literal key in the source is a glossary key (no typos), and the dynamic surfaces are all glossary keys', () => {
    const glossary = new Set<string>(GLOSSARY_KEYS);
    const typos = [...literals.entries()].filter(([k]) => !glossary.has(k)).map(([k, where]) => `${k} (${where.join(', ')})`);
    expect(typos).toEqual([]);
    expect([...dynamic].filter((k) => !glossary.has(k))).toEqual([]);
    expect(dynamic.size).toBeGreaterThan(30);
  });
});
