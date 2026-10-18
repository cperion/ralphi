// ralphi — one fresh design iteration per round.
// Run through the workflow tool with args: { problem, rounds }.
// The workspace is the only memory between rounds.

const PROBLEM = typeof args.problem === 'string' ? args.problem.trim() : ''
if (PROBLEM.length === 0) throw new Error('args.problem is required, e.g. "problems/rate-limiter"')
if (PROBLEM.startsWith('/') || PROBLEM.includes('..') || PROBLEM.includes('\\')) {
  throw new Error('args.problem must be a relative path inside the workspace, without ".."')
}
const ROUNDS = args.rounds === undefined ? 24 : args.rounds
if (!Number.isInteger(ROUNDS) || ROUNDS < 1 || ROUNDS > 200) {
  throw new Error('args.rounds must be an integer between 1 and 200')
}

const reportSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['mode', 'question', 'evidence', 'decision', 'next'],
  properties: {
    mode: { type: 'string', enum: ['continue', 'simplify', 'experiment', 'rederive'] },
    question: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    decision: { type: 'string' },
    next: { type: 'string' },
  },
}

const auditSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['material', 'finding', 'consequence'],
  properties: {
    material: { type: 'boolean' },
    finding: { type: 'string' },
    consequence: { type: 'string' },
  },
}

const RULES = `You are one iteration of an architecture-design loop. You have no memory of
previous rounds beyond the files in the problem directory.

Read, in this order: CONTRACT.md, QUESTIONS.md, LOG.md (the tail is enough),
ARCHITECTURE.md.

Then do exactly one substantial investigation toward the simplest, clearest
design that satisfies the contract. Production code is not the goal; prototypes,
tests and benchmarks are instruments for answering questions.

Question discovery comes first. Write down three candidate questions, rank them
by materiality — could the answer change correctness, the data representation,
the number of concepts, or violate a requirement? — and pursue the most material
one. If no question is material, say so and refine the incumbent instead of
inventing work.

Choose your mode:
- continue: improve the incumbent design.
- simplify: remove a concept, state, dependency, special case, or abstraction.
- experiment: resolve a disagreement with a prototype, test, benchmark, or proof.
- rederive: derive the design again from first principles. Read CONTRACT.md
  only; do not open ARCHITECTURE.md, LOG.md, or QUESTIONS.md. Write the
  independent design to experiments/rederive-<round>.md first. Only then read
  the incumbent, reconcile, and record what genuinely changed and why.

For refactor problems, existing code is evidence of current behavior, not a
constraint on the target structure, except where CONTRACT.md requires
compatibility. Keep these distinct: required behavior, observed legacy behavior,
confirmed constraint, assumption, preference.

Update QUESTIONS.md (add, answer, reject). Append one dense section to LOG.md.
Change ARCHITECTURE.md only when evidence justifies replacing the incumbent;
keep rejected alternatives and the reason. Put anything longer than a few lines
in experiments/.

Commit: git add -A && git commit -m "round-N: <one line>"

Do not delegate, build tooling, or invent progress. A round that only eliminates
a wrong idea is a successful round.

Report: mode, the question, evidence pointers, the decision, and the next
uncertainty. No other fields.`

function roundPrompt(n, previous) {
  return `${RULES}

Problem directory: ${PROBLEM}/
Round ${n} of ${ROUNDS}.
${previous === undefined
    ? 'This is the first round: ARCHITECTURE.md has no candidate yet.'
    : `Previous round report: ${JSON.stringify(previous)}`}

Prefix experiment files with the round number. Return the report now.`
}

function auditPrompt() {
  return `Independent audit. You have not seen this search. Read only these two files:
${PROBLEM}/CONTRACT.md and ${PROBLEM}/ARCHITECTURE.md.

Attempt to implement the essential required behavior from those documents alone.
Every time you must invent a semantic decision the design did not specify, note it.
Then judge whether one material gap remains: an omission that changes
correctness, a representation that forces accidental complexity, or a simpler
formulation the design missed.

material=false only if you could implement the contract without inventing
anything material and found no simpler representation. finding: the single most
consequential gap, or "none". consequence: what breaks, or what an implementer
must guess, if it is not fixed.`
}

phase('Design rounds')
const rounds = []
for (let n = 1; n <= ROUNDS; n += 1) {
  const previous = rounds.length === 0 ? undefined : rounds[rounds.length - 1]
  const report = await agent(roundPrompt(n, previous), {
    label: `round ${n}`,
    schema: reportSchema,
  })
  if (report === null) {
    return { status: 'round-failed', problem: PROBLEM, round: n, rounds }
  }
  rounds.push(report)
  log(`round ${n}: ${report.mode} — ${report.question}`)
}

phase('Independent audit')
const audit = await agent(auditPrompt(), { label: 'independent audit', schema: auditSchema })

return {
  status: 'complete',
  problem: PROBLEM,
  trajectory: rounds.map((r) => ({ mode: r.mode, question: r.question, decision: r.decision })),
  audit,
}
