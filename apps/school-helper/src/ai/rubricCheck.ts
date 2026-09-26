import type { Rubric } from '../common/types';
import { complete } from './provider';
import { RUBRIC_RULE } from './guardrails';

export interface RubricCheckRequest {
  /** The student's own answer — always supplied by them, never generated. */
  myAnswer: string;
  rubric: Rubric;
  taskTitle: string;
  courseCode: string;
  /** Contents of 04_style_guide.md, so suggestions sound like the student. */
  styleGuide?: string;
  disclosureAccepted?: boolean;
}

export interface RubricFinding {
  criterion: string;
  verdict: 'meets-level-4' | 'close' | 'missing';
  missing: string[];
  factualErrors: { claim: string; correction: string }[];
  edits: { before: string; after: string; why: string }[];
}

export interface RubricCheckResult {
  overall: string;
  findings: RubricFinding[];
  raw: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    estimatedCostUsd: number;
    model: string;
  };
}

/**
 * Compare the student's own answer against the level-4 rubric descriptors.
 * Suggests targeted edits in their voice; never produces a replacement answer.
 */
export async function runRubricCheck(req: RubricCheckRequest): Promise<RubricCheckResult> {
  if (!req.myAnswer.trim()) {
    throw new Error(
      'Paste or select your own answer first — the rubric check reviews your writing, it does not write it.',
    );
  }
  if (!req.rubric.criteria.length) {
    throw new Error(
      `No rubric criteria stored for "${req.taskTitle}". Sync the course, or add the criteria by hand.`,
    );
  }

  const criteriaBlock = req.rubric.criteria
    .map((c, i) => `${i + 1}. ${c.name}\n   LEVEL 4 REQUIRES: ${c.level4}`)
    .join('\n');

  const system = [
    RUBRIC_RULE,
    req.styleGuide
      ? `THE STUDENT'S STYLE GUIDE — match this voice in every suggested edit:\n${req.styleGuide.slice(0, 4000)}`
      : "No style guide supplied; preserve the student's existing voice exactly as written.",
    `Reply as JSON only, no prose outside the JSON, matching this schema:
{
  "overall": "one or two sentences on where this sits against level 4",
  "findings": [
    {
      "criterion": "<criterion name>",
      "verdict": "meets-level-4" | "close" | "missing",
      "missing": ["what the level-4 descriptor asks for that is absent"],
      "factualErrors": [{"claim": "<their words>", "correction": "<the correct fact>"}],
      "edits": [{"before": "<short span of their text, verbatim>", "after": "<their span, minimally edited>", "why": "<which criterion this serves>"}]
    }
  ]
}
Every "before" must be an exact substring of the student's text. Keep "after" close to
"before" — change words, do not replace sentences.`,
  ].join('\n\n');

  const user = `COURSE: ${req.courseCode}\nTASK: ${req.taskTitle}\n\nRUBRIC (level 4 descriptors):\n${criteriaBlock}\n\nTHE STUDENT'S OWN ANSWER:\n"""\n${req.myAnswer.slice(0, 30_000)}\n"""`;

  const result = await complete({
    role: 'strong',
    feature: 'rubric-check',
    temperature: 0.1,
    disclosureAccepted: req.disclosureAccepted,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });

  const findings = parseFindings(result.text, req.myAnswer);
  return {
    overall: findings.overall,
    findings: findings.findings,
    raw: result.text,
    usage: {
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      estimatedCostUsd: result.estimatedCostUsd,
      model: result.model,
    },
  };
}

/**
 * Parse the JSON reply defensively, and drop any edit whose "before" is not
 * actually in the student's text — that would be the model inventing content.
 */
export function parseFindings(
  raw: string,
  myAnswer: string,
): { overall: string; findings: RubricFinding[] } {
  const json = extractJson(raw);
  if (!json) {
    return { overall: raw.slice(0, 400), findings: [] };
  }
  const findings: RubricFinding[] = [];
  for (const f of (json.findings as RubricFinding[]) ?? []) {
    const edits = (f.edits ?? []).filter((e) => e?.before && myAnswer.includes(e.before.trim()));
    findings.push({
      criterion: String(f.criterion ?? 'Criterion'),
      verdict: (['meets-level-4', 'close', 'missing'] as const).includes(f.verdict)
        ? f.verdict
        : 'close',
      missing: Array.isArray(f.missing) ? f.missing.map(String) : [],
      factualErrors: Array.isArray(f.factualErrors) ? f.factualErrors : [],
      edits,
    });
  }
  return { overall: String(json.overall ?? ''), findings };
}

function extractJson(raw: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Level-4 coverage as a simple fraction, for the progress bar. */
export function coverage(findings: RubricFinding[]): { met: number; total: number; pct: number } {
  const total = findings.length || 1;
  const met = findings.filter((f) => f.verdict === 'meets-level-4').length;
  return { met, total: findings.length, pct: Math.round((met / total) * 100) };
}
