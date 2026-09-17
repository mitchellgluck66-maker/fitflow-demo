import { describe, it, expect } from 'vitest';
import { suggestRole, similarity, AUTO_THRESHOLD } from '@/lib/ghl/roles';

describe('semantic role mapper', () => {
  it('maps exact stage names confidently', () => {
    expect(suggestRole('Applied')).toMatchObject({ role: 'applied', confident: true });
    expect(suggestRole('Consult Booked')).toMatchObject({ role: 'consult_booked', confident: true });
    expect(suggestRole('Consult No Show')).toMatchObject({ role: 'consult_noshow', confident: true });
    expect(suggestRole('Pre-Roadmap Booked')).toMatchObject({ role: 'roadmap_booked', confident: true });
    expect(suggestRole('Roadmap Completed: Objection')).toMatchObject({ role: 'roadmap_showed', confident: true });
    expect(suggestRole('Enrolled')).toMatchObject({ role: 'enrolled', confident: true });
  });

  it('is case and punctuation insensitive', () => {
    expect(suggestRole('consult  booked!')).toMatchObject({ role: 'consult_booked', confident: true });
    expect(suggestRole('ENROLLED')).toMatchObject({ role: 'enrolled', confident: true });
  });

  it('never auto-maps a no-show stage to a booked/showed role', () => {
    const s = suggestRole('Roadmap No Show');
    expect(s.confident).toBe(false);
    expect(s.confidence).toBeLessThan(AUTO_THRESHOLD);
  });

  it('Phase G roles: rescheduled and previous-lead stages map to their own roles', () => {
    expect(suggestRole('Consult Rescheduled')).toMatchObject({ role: 'consult_rescheduled', confident: true });
    expect(suggestRole('Consult Booked (Rescheduled)')).toMatchObject({ role: 'consult_rescheduled', confident: true });
    expect(suggestRole('Roadmap Rescheduled')).toMatchObject({ role: 'roadmap_rescheduled', confident: true });
    expect(suggestRole('Pre-Roadmap Rescheduled')).toMatchObject({ role: 'roadmap_rescheduled', confident: true });
    expect(suggestRole('Previous Leads')).toMatchObject({ role: 'previous_lead', confident: true });
    expect(suggestRole('Old Leads')).toMatchObject({ role: 'previous_lead', confident: true });
  });

  it('a rescheduled stage never auto-maps to a plain booking, and vice versa', () => {
    const r = suggestRole('Consult Booked - Rescheduling');
    expect(r.confident).toBe(false);
    expect(r.role).not.toBe('consult_booked');
    const b = suggestRole('Consult Booked');
    expect(b).toMatchObject({ role: 'consult_booked', confident: true });
    expect(suggestRole('Roadmap Booked').role).toBe('roadmap_booked');
  });

  it('surfaces unknown stages instead of guessing', () => {
    const s = suggestRole('Some Random Parking Lot');
    expect(s.confident).toBe(false);
    const t = suggestRole('Zzz Totally Custom');
    expect(t.confident).toBe(false);
    expect(t.role).toBe('other');
  });

  it('similarity is symmetric and bounded', () => {
    expect(similarity('Applied', 'Applied')).toBe(1);
    expect(similarity('Consult Booked', 'Consult Booked Now')).toBe(0.85);
    // Short substrings are not evidence.
    expect(similarity('Consult Booked', 'Booked')).toBe(0.5);
    expect(similarity('Previous Leads', 'Lead')).toBeLessThan(0.8);
    expect(similarity('a b c', 'a x y')).toBeCloseTo(1 / 3);
    expect(similarity('', 'x')).toBe(0);
  });
});
