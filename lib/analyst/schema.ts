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
/** Oct 7 item 1: what a spend action does; the verifier holds it to the server's gate. */
export const SPEND_CHANGES = ['increase', 'decrease', 'shift', 'hold', 'none'] as const;
export const CONFIDENCE = ['low', 'medium', 'high'] as const;
export const DIRECTIONS = ['up', 'down', 'flat'] as const;
export const SEVERITIES = ['info', 'good', 'warning'] as const;

/** JSON Schema — strict-compatible (tests/analyst-wire.test.ts checks it). */
export const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: [...ANSWER_KINDS], description: 'answer = a question; explain = "what does this mean" (3 sections); report = a preset report (8 sections); clarify = ask ONE clarifying question and nothing else.' },
    headline: { type: 'object', properties: { text: { type: 'string', description: 'One sentence, the answer in brief. At most one number, written as a ref token: {r2:data.kpis.enrollments.current}.' } }, required: ['text'], additionalProperties: false },
    sections: {
      type: 'array',
      description: 'In the order the kind requires. answer: any of what_happened, why, so_what, do_this, how_we_will_know in that order (skip what does not apply). explain: exactly what_it_is, what_yours_says, what_to_do. report: the 8 report sections. clarify: none.',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', enum: SECTION_KEYS },
          body_md: { type: 'string', description: 'Markdown. Every metric is a ref token, never a digit: {r2:data.marketing.spendCents}, {r7:data.results[0].value|%}. The server prints the number.' },
        },
        required: ['key', 'body_md'],
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
          campaign: { type: 'string', description: 'For a spend action: the campaign name exactly as a tool result gives it, or "account" for total spend. "" for other kinds.' },
          spend_change: { type: 'string', enum: [...SPEND_CHANGES], description: 'For a spend action: increase / decrease / shift / hold. The server\'s spend gate decides what is allowed — a campaign whose gate says hold can only get "hold". "none" for other kinds.' },
          expected_impact: { type: 'string', description: 'The expected impact in words; any number as a ref token ({r7:data.results[2].value}), or "unknown".' },
          confidence: { type: 'string', enum: [...CONFIDENCE] },
          metric: { type: 'string', description: 'The metric to watch (a glossary key).' },
          check_date: { type: 'string', description: 'YYYY-MM-DD when to check.' },
        },
        required: ['action', 'why', 'owner', 'kind', 'campaign', 'spend_change', 'expected_impact', 'confidence', 'metric', 'check_date'],
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

export const AnswerSchema = z.object({
  kind: z.enum(ANSWER_KINDS),
  headline: z.object({ text: z.string() }),
  sections: z.array(z.object({ key: z.enum(SECTION_KEYS as [SectionKey, ...SectionKey[]]), body_md: z.string() })),
  actions: z.array(
    z.object({
      action: z.string(),
      why: z.string(),
      owner: z.string(),
      kind: z.enum(ACTION_KINDS),
      campaign: z.string(),
      spend_change: z.enum(SPEND_CHANGES),
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

// ---------------------------------------------------------------------------
// Targeted repair (Oct 7 item 2a): the model returns ONLY the failing fields
// ---------------------------------------------------------------------------

/** The ONE strict schema of a repair request (it replaces the answer format for that request). */
export const REPAIR_SCHEMA = {
  type: 'object',
  properties: {
    fields: {
      type: 'array',
      description: 'Exactly the fields the repair message listed, rewritten. Every other field of the answer stays as it was.',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The field as the repair message named it: "headline", a section key such as "what_happened", "actions[0].why", "findings[2]".' },
          text: { type: 'string', description: 'The rewritten text of that field (markdown for a section; a sentence for an action field). Every metric as a ref token.' },
        },
        required: ['path', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['fields'],
  additionalProperties: false,
} as const;

export const RepairSchema = z.object({ fields: z.array(z.object({ path: z.string(), text: z.string() })) });
export type RepairFields = z.infer<typeof RepairSchema>['fields'];

/** The problem kinds a targeted repair can fix: text fields. Structure, stale spend and gate problems regenerate the whole answer. */
export const TARGETED_KINDS: ReadonlySet<string> = new Set(['ref', 'digits', 'direction', 'hint']);

/** Read the text at a verifier section path, or null when the path names nothing. */
export function readField(answer: Answer, path: string): string | null {
  if (path === 'headline') return answer.headline.text;
  const action = /^actions\[(\d+)\]\.(action|why|expected_impact)$/.exec(path);
  if (action) return answer.actions[Number(action[1])]?.[action[2] as 'action' | 'why' | 'expected_impact'] ?? null;
  const finding = /^findings\[(\d+)\]$/.exec(path);
  if (finding) return answer.findings[Number(finding[1])]?.finding ?? null;
  return answer.sections.find((s) => s.key === path)?.body_md ?? null;
}

/**
 * Splice the returned fields into the rejected answer: only paths in `allowed` (the ones the repair asked for)
 * that exist are replaced; everything else is byte-identical. Pure — returns a new answer.
 */
export function spliceFields(answer: Answer, fields: RepairFields, allowed: readonly string[]): { answer: Answer; applied: string[]; ignored: string[] } {
  const out: Answer = JSON.parse(JSON.stringify(answer)) as Answer;
  const applied: string[] = [];
  const ignored: string[] = [];
  for (const f of fields) {
    const path = f.path.trim();
    if (!allowed.includes(path) || readField(out, path) === null) {
      ignored.push(path);
      continue;
    }
    if (path === 'headline') out.headline.text = f.text;
    else if (/^actions\[\d+\]\./.test(path)) {
      const m = /^actions\[(\d+)\]\.(action|why|expected_impact)$/.exec(path)!;
      out.actions[Number(m[1])][m[2] as 'action' | 'why' | 'expected_impact'] = f.text;
    } else if (/^findings\[\d+\]$/.test(path)) out.findings[Number(/\[(\d+)\]/.exec(path)![1])].finding = f.text;
    else out.sections.find((s) => s.key === path)!.body_md = f.text;
    applied.push(path);
  }
  return { answer: out, applied, ignored };
}
