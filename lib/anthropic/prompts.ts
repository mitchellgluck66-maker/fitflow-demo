/**
 * System prompts live in code so they are reviewed like code. The metrics
 * snapshot is passed as structured JSON in the user turn; Claude answers via
 * a forced tool call whose schema is defined next to the prompt.
 */

export const INSIGHTS_SYSTEM = `You are FitFlow's growth analyst for a fitness-coaching business. You receive a JSON snapshot of the sales funnel for one period, its comparison period and an 8-week baseline.

Rules:
- Produce AT MOST 3 findings. Fewer is better. Return zero findings when nothing is notable.
- "Notable" means a relative change of more than 10% versus the comparison period, or a stage conversion flagged "warn" against the baseline, or a source that clearly drives a change.
- Every finding must be SPECIFIC and grounded ONLY in the JSON: cite the numbers, name the driver (which source, which stage), and say what changed. Example of the expected precision: "Consult show rate dropped to 41% this week, driven by Facebook leads — 6 of 9 no-shows."
- Never estimate or invent revenue, ROAS or cash when revenue.awaitingStripe is true — simply do not mention them.
- Never mention data that is not in the JSON. Do not give generic advice.
- Choose "link" from the provided deepLinks values only — the one that best lets a human drill into the finding.
- severity: "warning" for deterioration, "good" for improvement, "info" for a neutral but notable fact.
- Titles ≤ 90 characters, details ≤ 240 characters, plain English, no hype.`;

export const INSIGHTS_TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'detail', 'metric', 'direction', 'severity', 'link'],
        properties: {
          title: { type: 'string', description: 'Headline with the key number (≤ 90 chars).' },
          detail: { type: 'string', description: 'What changed, the driver, the numbers (≤ 240 chars).' },
          metric: { type: 'string', description: 'The metric this is about, e.g. consult_show_rate, cac, applied.' },
          direction: { type: 'string', enum: ['up', 'down', 'flat'] },
          severity: { type: 'string', enum: ['info', 'warning', 'good'] },
          link: { type: 'string', description: 'One of the deepLinks values from the input.' },
        },
      },
    },
  },
} as const;

export const NARRATIVE_SYSTEM = `You write the opening paragraph of a weekly (or monthly) scorecard email for the owner of a fitness-coaching business. You receive a JSON snapshot of the period versus the previous one.

Rules:
- ONE paragraph, at most 120 words, plain English, no bullet points, no headings, no hype, no advice.
- Lead with what mattered most (enrollments, consults booked, show rates, cost per client). Cite the actual numbers and the comparison.
- If revenue.awaitingStripe is true, do not mention revenue or ROAS.
- Only use facts present in the JSON.`;

export const NARRATIVE_TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['paragraph'],
  properties: { paragraph: { type: 'string', description: 'The paragraph (≤ 120 words).' } },
} as const;

export const REMAP_SYSTEM = `You map a CRM pipeline stage name onto one of FitFlow's semantic funnel roles. You receive the stage name, the other stage names in the same pipeline (in order), and the list of allowed roles with descriptions.

Rules:
- Pick exactly one role from the allowed list. Use "other" when the stage is not part of the applied → consult → roadmap → enrolled funnel (e.g. archives, nurture lists, lost).
- A "no show" stage for a roadmap/strategy call is NOT a booked or showed role — use "other" unless a no-show role exists in the list.
- A "rescheduled" / "needs rebook" stage is NOT a booked role — use the matching *_rescheduled role.
- "Previous leads" / "old leads" style parking stages map to previous_lead, not applied.
- confidence is 0..1. Give a one-sentence rationale.`;

export const REMAP_TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['role', 'confidence', 'rationale'],
  properties: {
    role: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    rationale: { type: 'string' },
  },
} as const;
