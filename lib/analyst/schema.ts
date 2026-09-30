/**
 * The ONE answer schema (plan item 6). Sent as `output_config.format` (or as
 * the strict `submit_answer` tool in fallback mode) on every turn — one schema
 * for every kind of answer, so the prompt cache is never rebuilt. Everything
 * is required (empty arrays / empty strings, no nullables), within the
 * documented strict limits (no min/max/length keywords).
 *
 * The server owns the structure: `expectedSections(kind)` says which section
 * keys an answer of that kind must carry, in order, and the headings are
 * rendered from the keys, so labels can never drift.
 */

import { z } from 'zod';

export const ANSWER_KINDS = ['answer', 'explain', 'report', 'clarify'] as const;
export type AnswerKind = (typeof ANSWER_KINDS)[number];

/** Every section the app knows, with the heading the panel renders. */
export const SECTION_LABELS = {
  // A chat answer, in the contract's order.
  what_happened: 'What happened',
  why: 'Why',
  so_what: 'So what',
  do_this: 'Do this',
  how_we_will_know: "How we'll know",
  // "What does this mean?"
  what_it_is: 'What it is',
  what_yours_says: 'What yours says',
  what_to_do: 'What to do',
  // The full report (Part C).
  executive_summary: 'Executive summary',
  scorecard_vs_normal: 'Scorecard vs normal',
  marketing: 'Marketing',
  funnel_deep_dive: 'Funnel deep-dive',
  sales_conversion: 'Sales conversion',
  revenue_and_cash: 'Revenue & cash',
  data_health: 'Data health',
  actions: 'Actions',
} as const;
export type SectionKey = keyof typeof SECTION_LABELS;
export const SECTION_KEYS = Object.keys(SECTION_LABELS) as SectionKey[];

export const ANSWER_SECTIONS: SectionKey[] = ['what_happened', 'why', 'so_what', 'do_this', 'how_we_will_know'];
export const EXPLAIN_SECTIONS: SectionKey[] = ['what_it_is', 'what_yours_says', 'what_to_do'];
export const REPORT_SECTIONS: SectionKey[] = ['executive_summary', 'scorecard_vs_normal', 'marketing', 'funnel_deep_dive', 'sales_conversion', 'revenue_and_cash', 'data_health', 'actions'];

export const ACTION_KINDS = ['spend', 'creative', 'sales_process', 'follow_up', 'pricing', 'data', 'other'] as const;
export const CONFIDENCE = ['low', 'medium', 'high'] as const;
export const DIRECTIONS = ['up', 'down', 'flat'] as const;
export const SEVERITIES = ['info', 'good', 'warning'] as const;

const numberRef = { type: 'object', properties: { text: { type: 'string', description: 'The number exactly as it appears in the prose, e.g. "$1,605 CAD", "41%", "8".' }, ref: { type: 'string', description: 'Where it came from: "<call ref>:data.<json path>", e.g. "r2:data.kpis.enrollments.current".' } }, required: ['text', 'ref'], additionalProperties: false } as const;

/** JSON Schema — strict-compatible (tests/analyst-wire.test.ts checks it). */
export const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: [...ANSWER_KINDS], description: 'answer = a question; explain = "what does this mean" (3 sections); report = a preset report (8 sections); clarify = ask ONE clarifying question and nothing else.' },
    headline: { type: 'object', properties: { text: { type: 'string', description: 'One sentence, the answer in brief. At most one number.' }, ref: { type: 'string', description: 'The ref of the headline number, or "" when it has none.' } }, required: ['text', 'ref'], additionalProperties: false },
    sections: {
      type: 'array',
      description: 'In the order the kind requires. answer: any of what_happened, why, so_what, do_this, how_we_will_know in that order (skip what does not apply). explain: exactly what_it_is, what_yours_says, what_to_do. report: the 8 report sections. clarify: none.',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', enum: SECTION_KEYS },
          body_md: { type: 'string', description: 'Markdown. Every number in it must also be listed in `numbers` with its ref.' },
          numbers: { type: 'array', items: numberRef, description: 'Every number that appears in body_md, each with the tool-result ref it came from.' },
        },
        required: ['key', 'body_md', 'numbers'],
        additionalProperties: false,
      },
    },
    actions: {
      type: 'array',
      description: 'Concrete actions (empty when none). Never a spend action while any source is stale.',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          why: { type: 'string' },
          owner: { type: 'string', description: 'Who does it (a role or a name from the team).' },
          kind: { type: 'string', enum: [...ACTION_KINDS] },
          expected_impact_ref: { type: 'string', description: 'The ref of the number the impact is based on, or "".' },
          expected_impact: { type: 'string', description: 'The expected $ impact in words, with its currency, or "unknown".' },
          confidence: { type: 'string', enum: [...CONFIDENCE] },
          metric: { type: 'string', description: 'The metric to watch (a glossary key).' },
          check_date: { type: 'string', description: 'YYYY-MM-DD when to check.' },
        },
        required: ['action', 'why', 'owner', 'kind', 'expected_impact_ref', 'expected_impact', 'confidence', 'metric', 'check_date'],
        additionalProperties: false,
      },
    },
    findings: {
      type: 'array',
      description: 'Notable facts (empty when none).',
      items: {
        type: 'object',
        properties: {
          area: { type: 'string', description: 'marketing | funnel | sales | revenue | data' },
          metric: { type: 'string' },
          finding: { type: 'string' },
          direction: { type: 'string', enum: [...DIRECTIONS] },
          severity: { type: 'string', enum: [...SEVERITIES] },
          evidence_refs: { type: 'array', items: { type: 'string' } },
        },
        required: ['area', 'metric', 'finding', 'direction', 'severity', 'evidence_refs'],
        additionalProperties: false,
      },
    },
    note_proposals: { type: 'array', items: { type: 'string' }, description: 'Owner notes you propose adding (saved only if the owner approves). Usually empty.' },
    clarifying_question: { type: 'string', description: 'For kind clarify: the ONE question. "" otherwise.' },
  },
  required: ['kind', 'headline', 'sections', 'actions', 'findings', 'note_proposals', 'clarifying_question'],
  additionalProperties: false,
} as const;

const NumberRef = z.object({ text: z.string(), ref: z.string() });
export const AnswerSchema = z.object({
  kind: z.enum(ANSWER_KINDS),
  headline: z.object({ text: z.string(), ref: z.string() }),
  sections: z.array(z.object({ key: z.enum(SECTION_KEYS as [SectionKey, ...SectionKey[]]), body_md: z.string(), numbers: z.array(NumberRef) })),
  actions: z.array(
    z.object({
      action: z.string(),
      why: z.string(),
      owner: z.string(),
      kind: z.enum(ACTION_KINDS),
      expected_impact_ref: z.string(),
      expected_impact: z.string(),
      confidence: z.enum(CONFIDENCE),
      metric: z.string(),
      check_date: z.string(),
    }),
  ),
  findings: z.array(z.object({ area: z.string(), metric: z.string(), finding: z.string(), direction: z.enum(DIRECTIONS), severity: z.enum(SEVERITIES), evidence_refs: z.array(z.string()) })),
  note_proposals: z.array(z.string()),
  clarifying_question: z.string(),
});
export type Answer = z.infer<typeof AnswerSchema>;

/** The section keys an answer of this kind must carry, in order. `answer` may skip keys but never reorder them. */
export function expectedSections(kind: AnswerKind): { keys: SectionKey[]; subsetAllowed: boolean } {
  switch (kind) {
    case 'explain':
      return { keys: EXPLAIN_SECTIONS, subsetAllowed: false };
    case 'report':
      return { keys: REPORT_SECTIONS, subsetAllowed: false };
    case 'clarify':
      return { keys: [], subsetAllowed: false };
    default:
      return { keys: ANSWER_SECTIONS, subsetAllowed: true };
  }
}

/** Structure check: the right keys in the right order for the kind. Returns the problem, or null. */
export function checkStructure(answer: Answer): string | null {
  const { keys, subsetAllowed } = expectedSections(answer.kind);
  const got = answer.sections.map((s) => s.key);
  if (answer.kind === 'clarify') {
    if (got.length) return 'a clarify answer carries no sections';
    if (!answer.clarifying_question.trim()) return 'a clarify answer needs its clarifying_question';
    return null;
  }
  if (answer.clarifying_question.trim()) return 'clarifying_question is only for kind clarify';
  if (new Set(got).size !== got.length) return `a section key repeats: ${got.join(', ')}`;
  if (!subsetAllowed) {
    if (got.join(',') !== keys.join(',')) return `${answer.kind} needs exactly the sections ${keys.join(' / ')} in that order; got ${got.join(' / ') || 'none'}`;
    return null;
  }
  if (got.length === 0) return 'an answer needs at least one section';
  const positions = got.map((k) => keys.indexOf(k));
  if (positions.some((p) => p < 0)) return `an answer may only use ${keys.join(' / ')}; got ${got.join(' / ')}`;
  if (positions.some((p, i) => i > 0 && p <= positions[i - 1])) return `sections must follow the order ${keys.join(' → ')}; got ${got.join(' → ')}`;
  for (const s of answer.sections) if (!s.body_md.trim()) return `section ${s.key} is empty`;
  return null;
}
