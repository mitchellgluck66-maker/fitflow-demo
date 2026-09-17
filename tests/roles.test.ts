import { describe, it, expect } from 'vitest';
import { suggestRole, similarity, AUTO_THRESHOLD, SEMANTIC_ROLES, ROLE_LABELS, NOSHOW_ROLES } from '@/lib/ghl/roles';

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

  it('maps no-show stages to their own roles, never to booked/showed', () => {
    expect(suggestRole('Roadmap No Show')).toMatchObject({ role: 'roadmap_noshow', confident: true });
    expect(suggestRole('Pre-Roadmap No-Show')).toMatchObject({ role: 'roadmap_noshow', confident: true });
    expect(suggestRole('Strategy Session No Show')).toMatchObject({ role: 'roadmap_noshow', confident: true });
    expect(suggestRole('Consult No Show')).toMatchObject({ role: 'consult_noshow', confident: true });
    const odd = suggestRole('Webinar No Show');
    expect(odd.confident).toBe(false);
    expect(odd.confidence).toBeLessThan(AUTO_THRESHOLD);
    expect(['consult_booked', 'roadmap_booked', 'roadmap_showed']).not.toContain(odd.role);
    // A no-show role never wins a plain booking.
    expect(suggestRole('Roadmap Booked').role).toBe('roadmap_booked');
  });

  it('roadmap_noshow is enumerated after roadmap_booked everywhere roles are listed', () => {
    const i = SEMANTIC_ROLES.indexOf('roadmap_noshow');
    expect(i).toBe(SEMANTIC_ROLES.indexOf('roadmap_booked') + 1);
    expect(ROLE_LABELS.roadmap_noshow).toBe('Roadmap no-show');
    expect(NOSHOW_ROLES).toEqual(['consult_noshow', 'roadmap_noshow']);
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
