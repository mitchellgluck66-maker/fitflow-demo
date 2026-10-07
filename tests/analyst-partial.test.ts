/** Oct 7 item 6: the first section read from partial answer JSON — string-aware, escapes honoured, never a throw. */
import { describe, it, expect } from 'vitest';
import { firstSection } from '@/lib/analyst/partial';

const full = JSON.stringify({ kind: 'answer', headline: { text: 'A "normal" week.' }, sections: [{ key: 'what_happened', body_md: 'Enrollments **{r1:data.kpis.enrollments.current}**; a brace { in text } and an escaped \\" quote.' }, { key: 'why', body_md: 'later' }], actions: [] });

describe('firstSection', () => {
  it('returns null until the first section object closes, then that section exactly; later sections are ignored', () => {
    const close = full.indexOf('}', full.indexOf('"body_md"'));
    // Find the real end of the first section object: scan prefixes until a section appears.
    let firstAt = -1;
    for (let i = 1; i <= full.length; i++) {
      const s = firstSection(full.slice(0, i));
      if (s) {
        firstAt = i;
        expect(s).toEqual({ key: 'what_happened', body_md: 'Enrollments **{r1:data.kpis.enrollments.current}**; a brace { in text } and an escaped \\" quote.' });
        break;
      }
    }
    expect(firstAt).toBeGreaterThan(close); // the "}" inside the body text did not end it
    expect(firstAt).toBeLessThan(full.indexOf('"why"'));
    expect(firstSection(full)).toEqual({ key: 'what_happened', body_md: 'Enrollments **{r1:data.kpis.enrollments.current}**; a brace { in text } and an escaped \\" quote.' });
  });
  it('null for no sections, an empty array, a non-section object, or broken JSON', () => {
    expect(firstSection('{"kind":"answer","headline":{"text":"x"}')).toBeNull();
    expect(firstSection('{"sections":[]}')).toBeNull();
    expect(firstSection('{"sections":[{"foo":1}]}')).toBeNull();
    expect(firstSection('{"sections":[{"key":"x","body_md":')).toBeNull();
    expect(firstSection('')).toBeNull();
  });
});
