/**
 * arch_loop — a fresh-context design search exposed as one DSH tool.
 *
 * One call creates (or resumes) a problem directory under `<workspace>/.ralphi/`,
 * runs N parent-owned fresh subagents against it, then runs one independent
 * audit. Every round returns a small structured report; the workspace files are
 * the only memory between rounds. The worker owns ARCHITECTURE.md /
 * QUESTIONS.md / LOG.md and commits each round.
 *
 * No harness package imports: only Node builtins and the services handed in by
 * the Loader, so the bundle loads from any profile.
 *
 * @module @local/dsh-plugin-arch-loop
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'tool-arch-loop'
export const inject = ['tools', 'subagents']

const REPORT_SCHEMA = {
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

const AUDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['material', 'finding', 'consequence'],
  properties: {
    material: { type: 'boolean' },
    finding: { type: 'string' },
    consequence: { type: 'string' },
  },
}

const WORKER_PERSONA = 'You are an architecture designer and adversarial simplifier. You search for the smallest set of concepts, states, invariants and representations that satisfies the contract. You do not write production code; a prototype, test or benchmark exists only to answer a question. You treat the current design, including your own previous rounds, as a hypothesis, not as a baseline to defend.'

const AUDITOR_PERSONA = 'You are an independent design auditor. You have not seen the search process. You judge only the contract and the written architecture, and you look for the first place an implementer would have to invent semantics the design did not specify.'

const PROTOCOL = `You are one iteration of an architecture-design loop. You have no memory of previous rounds beyond the files in the problem directory.

Read, in this order: CONTRACT.md, QUESTIONS.md, LOG.md (the tail is enough), ARCHITECTURE.md.

Then do exactly one substantial investigation toward the simplest, clearest design that satisfies the contract.

Question discovery comes first. Write down three candidate questions, rank them by materiality — could the answer change correctness, the data representation, the number of concepts, or violate a requirement? — and pursue the most material one. If no question is material, say so and refine the incumbent instead of inventing work.

Choose your mode:
- continue: improve the incumbent design.
- simplify: remove a concept, state, dependency, special case, or abstraction.
- experiment: resolve a disagreement with a prototype, test, benchmark, or proof.
- rederive: derive the design again from first principles. Read CONTRACT.md
  only; do not open ARCHITECTURE.md, LOG.md, or QUESTIONS.md. Write the
  independent design to experiments/rederive-<round>.md first. Only then read
  the incumbent, reconcile, and record what genuinely changed and why.

For refactor problems, existing code is evidence of current behavior, not a constraint on the target structure, except where CONTRACT.md requires compatibility. Keep these distinct: required behavior, observed legacy behavior, confirmed constraint, assumption, preference.

Update QUESTIONS.md (add, answer, reject). Append one dense section to LOG.md. Change ARCHITECTURE.md only when evidence justifies replacing the incumbent; keep rejected alternatives and the reason. Put anything longer than a few lines in experiments/.

Do not delegate, build tooling, or invent progress. A round that only eliminates a wrong idea is a successful round.

Finish by calling structured_output with: mode, the question, evidence pointers, the decision, and the next uncertainty.`

function resolveConfig(raw) {
  const provider = typeof raw?.provider === 'string' && raw.provider.length > 0 ? raw.provider : 'spawn'
  const maxRounds = Number.isSafeInteger(raw?.maxRounds) && raw.maxRounds > 0 ? raw.maxRounds : 64
  const defaultRounds = Number.isSafeInteger(raw?.defaultRounds) && raw.defaultRounds > 0 ? raw.defaultRounds : 24
  return { provider, maxRounds, defaultRounds }
}

function slugify(text) {
  const slug = String(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug.length > 0 ? slug : 'problem'
}

function readArgs(raw, config) {
  if (typeof raw !== 'object' || raw === null) throw new Error('arch_loop: arguments must be an object')
  const goal = typeof raw.goal === 'string' ? raw.goal.trim() : ''
  if (goal.length === 0) throw new Error('arch_loop: goal must be a non-empty string')
  const constraints = typeof raw.constraints === 'string' && raw.constraints.trim().length > 0
    ? raw.constraints.trim()
    : undefined
  if (raw.paths !== undefined && !Array.isArray(raw.paths)) throw new Error('arch_loop: paths must be an array of strings')
  const paths = (raw.paths ?? []).filter((entry) => typeof entry === 'string' && entry.length > 0)
  const rounds = raw.rounds === undefined ? config.defaultRounds : raw.rounds
  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > config.maxRounds) {
    throw new Error(`arch_loop: rounds must be an integer between 1 and ${config.maxRounds}`)
  }
  const name = typeof raw.name === 'string' && raw.name.trim().length > 0 ? raw.name.trim() : goal
  return { goal, constraints, paths, rounds, slug: slugify(name) }
}

function clip(value, limit) {
  const text = String(value ?? '')
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

function contractText(goal, constraints, paths) {
  const pathList = paths.length === 0 ? 'None specified.' : paths.map((p) => `- \`${p}\``).join('\n')
  const constraintText = constraints === undefined
    ? 'None stated. Treat any missing requirement as an open question in QUESTIONS.md; do not invent behavior.'
    : constraints
  return `# Contract

## Problem
${goal}

## Constraints
${constraintText}

## Existing code
${pathList}

## Rules for this search
- Required behavior, observed legacy behavior, confirmed constraints, assumptions and preferences are distinct. Do not promote one into another.
- Missing requirements are open questions, never inventions.
- Definition of done: every stated requirement is accounted for, no unresolved material question remains, and an implementer can build the design without inventing semantics.
`
}

const ARCHITECTURE_TEMPLATE = `# Architecture

Status: no candidate yet.

A round replaces this file only when evidence justifies it. Keep it short enough
to explain in a few minutes; move detail to \`experiments/\`.

## Essential model
Entities, operations, invariants — the smallest set that explains the behavior.

## Concepts
The independent ideas a reader must hold. Fewer is better. Name each one.

## Data representation
Structures, ownership, lifetimes, and which invalid states cannot be expressed.

## Operations and algorithms
Pseudocode level, with complexity where it matters.

## Interfaces and naming
Public surface, and the guarantee each name implies.

## Rejected alternatives
Candidate, why rejected, what evidence settled it.

## Evidence
Links to \`experiments/\` files. Measured results, not preferences.

## Open questions
See \`QUESTIONS.md\`; do not duplicate them here.
`

const QUESTIONS_TEMPLATE = `# Questions

Materiality: could the answer change correctness, the data representation, the
number of concepts, or violate a requirement? Keep only material questions.

| # | Question | Materiality | Status | Evidence |
|---|----------|-------------|--------|----------|
| 1 |          | high        | open   |          |
`

const LOG_HEADER = `# Log

Append only, newest last. One dense section per round. Point at evidence rather
than copying it.
`

function roundPrompt(problemDir, round, total, previous) {
  const prior = previous === undefined
    ? 'This is the first round: ARCHITECTURE.md has no candidate yet.'
    : `Previous round report: ${JSON.stringify(previous)}`
  return `${PROTOCOL}

Problem directory (relative to the workspace root): ${problemDir}/
Files: ${problemDir}/CONTRACT.md, ${problemDir}/QUESTIONS.md, ${problemDir}/LOG.md, ${problemDir}/ARCHITECTURE.md

Round ${round} of ${total}. ${prior}

Prefix experiment files with the round number. If the workspace is a git repository, commit exactly your problem directory when you finish:
git add ${problemDir} && git commit -m "arch_loop round ${round}"`
}

function auditPrompt(problemDir) {
  return `Independent audit. You have not seen this search. Read only these two files:
${problemDir}/CONTRACT.md and ${problemDir}/ARCHITECTURE.md.

Attempt to implement the essential required behavior from those documents alone. Every time you must invent a semantic decision the design did not specify, note it. Then judge whether one material gap remains: an omission that changes correctness, a representation that forces accidental complexity, or a simpler formulation the design missed.

material=false only if you could implement the contract without inventing anything material and found no simpler representation. finding: the single most consequential gap, or "none". consequence: what breaks, or what an implementer must guess, if it is not fixed.`
}

async function ensureFile(path, text) {
  if (!existsSync(path)) await writeFile(path, text, 'utf8')
}

async function ensureState(dir, args) {
  await mkdir(join(dir, 'experiments'), { recursive: true })
  await ensureFile(join(dir, 'CONTRACT.md'), contractText(args.goal, args.constraints, args.paths))
  await ensureFile(join(dir, 'ARCHITECTURE.md'), ARCHITECTURE_TEMPLATE)
  await ensureFile(join(dir, 'QUESTIONS.md'), QUESTIONS_TEMPLATE)
  await ensureFile(join(dir, 'LOG.md'), LOG_HEADER)
}

function requireProvider(ctx, providerName) {
  const provider = ctx.subagents.getProvider(providerName)
  if (provider === undefined) throw new Error(`arch_loop: subagent provider "${providerName}" is not registered`)
  if (provider.inheritsParentContext) throw new Error(`arch_loop: provider "${providerName}" inherits parent context; a fresh provider is required`)
  if (!provider.capabilities.outputSchema) throw new Error(`arch_loop: provider "${providerName}" does not support structured output`)
  return provider
}

async function runChild(ctx, providerName, parent, signal, request) {
  const run = await ctx.subagents.start(providerName, {
    label: request.label,
    parent,
    signal,
    prompt: [{ type: 'text', text: request.prompt }],
    outputSchema: request.schema,
    persona: request.persona,
    toolFilter: { deny: ['arch_loop'] },
  })
  try {
    const result = await run.result
    if (result.stopReason !== 'completed') {
      return { error: `child ended with ${result.stopReason}${result.diagnostic === undefined ? '' : `: ${result.diagnostic}`}` }
    }
    if (result.structured === undefined || result.structured === null || typeof result.structured !== 'object') {
      return { error: 'child returned no structured report' }
    }
    return { value: result.structured }
  } finally {
    await run.dispose()
  }
}

function renderResult(value) {
  const lines = []
  lines.push(`arch_loop ${value.status} — ${value.problemDir} — ${value.done}/${value.rounds} rounds`)
  if (value.modes !== undefined) lines.push(`modes: ${value.modes}`)
  if (value.lastQuestion !== undefined) lines.push(`last question: ${value.lastQuestion}`)
  if (value.lastDecision !== undefined) lines.push(`last decision: ${value.lastDecision}`)
  if (value.audit !== undefined) {
    lines.push(value.audit.material
      ? `audit: MATERIAL GAP — ${value.audit.finding}`
      : `audit: no material gap — ${value.audit.finding}`)
    if (value.audit.material) lines.push(`consequence: ${value.audit.consequence}`)
  }
  if (value.recent !== undefined && value.recent.length > 0) {
    lines.push('recent rounds:')
    for (const entry of value.recent) lines.push(`  ${entry.round}. ${entry.mode} — ${entry.question} → ${entry.decision}`)
  }
  if (value.failure !== undefined) lines.push(`failure: ${value.failure}`)
  lines.push(`state: ${value.problemDir}/{ARCHITECTURE.md,QUESTIONS.md,LOG.md}`)
  return lines.join('\n')
}

/**
 * Run one arch_loop call. Exported for direct testing; the tool wrapper below is
 * the only production caller.
 */
export async function runArchLoop(ctx, config, rawArgs, exec) {
  const agent = exec.agent
  if (agent === undefined) throw new Error('arch_loop requires a calling agent')
  const args = readArgs(rawArgs, config)
  const workspace = agent.session.header.cwd ?? process.cwd()
  const dir = join(workspace, '.ralphi', args.slug)
  const problemDir = `.ralphi/${args.slug}`

  requireProvider(ctx, config.provider)
  await ensureState(dir, args)

  const startedAt = new Date().toISOString()
  const trajectory = []
  const recent = []
  let status = 'complete'
  let failure
  let audit

  try {
    let previous
    for (let round = 1; round <= args.rounds; round += 1) {
      if (exec.signal.aborted) {
        status = 'cancelled'
        failure = 'cancelled by the caller'
        break
      }
      const { value, error } = await runChild(ctx, config.provider, agent, exec.signal, {
        label: `arch_loop ${args.slug} round ${round}`,
        prompt: roundPrompt(problemDir, round, args.rounds, previous),
        schema: REPORT_SCHEMA,
        persona: WORKER_PERSONA,
      })
      if (error !== undefined) {
        status = 'round-failed'
        failure = `round ${round}: ${error}`
        break
      }
      previous = value
      trajectory.push({ round, ...value })
      recent.push({ round, mode: value.mode, question: clip(value.question, 160), decision: clip(value.decision, 200) })
      if (recent.length > 3) recent.shift()
      await appendFile(join(dir, 'rounds.jsonl'), `${JSON.stringify({
        at: new Date().toISOString(),
        round,
        mode: value.mode,
        question: value.question,
        evidence: value.evidence,
        decision: value.decision,
        next: value.next,
      })}\n`, 'utf8')
    }

    if (status === 'complete' && !exec.signal.aborted) {
      const auditRun = await runChild(ctx, config.provider, agent, exec.signal, {
        label: `arch_loop ${args.slug} audit`,
        prompt: auditPrompt(problemDir),
        schema: AUDIT_SCHEMA,
        persona: AUDITOR_PERSONA,
      })
      if (auditRun.error !== undefined) {
        status = 'audit-failed'
        failure = auditRun.error
      } else {
        audit = auditRun.value
        await writeFile(join(dir, 'AUDIT.json'), `${JSON.stringify({ at: new Date().toISOString(), ...audit }, null, 2)}\n`, 'utf8')
      }
    }
  } catch (error) {
    status = 'error'
    failure = error instanceof Error ? error.message : String(error)
  }

  const counts = { continue: 0, simplify: 0, experiment: 0, rederive: 0 }
  for (const entry of trajectory) counts[entry.mode] = (counts[entry.mode] ?? 0) + 1
  const modes = `${counts.continue} continue · ${counts.simplify} simplify · ${counts.experiment} experiment · ${counts.rederive} rederive`
  const last = trajectory.length > 0 ? trajectory[trajectory.length - 1] : undefined

  await appendFile(join(dir, 'runs.jsonl'), `${JSON.stringify({
    at: startedAt,
    finishedAt: new Date().toISOString(),
    goal: args.goal,
    rounds: args.rounds,
    done: trajectory.length,
    status,
    failure,
    modes: counts,
  })}\n`, 'utf8').catch(() => {})

  return {
    text: renderResult({
      status,
      problemDir,
      rounds: args.rounds,
      done: trajectory.length,
      modes,
      lastQuestion: last === undefined ? undefined : clip(last.question, 300),
      lastDecision: last === undefined ? undefined : clip(last.decision, 400),
      recent,
      audit,
      failure,
    }),
  }
}

const TOOL_DEFINITION = {
  name: 'arch_loop',
  description: 'Run a fresh-context architecture-design search on a problem. Creates or resumes .ralphi/<name>/ in the workspace, runs one substantial design iteration per round with a new child agent each time, then one independent audit. Use for architecture, code-structuring, refactor-target and design questions. Long-running: it blocks the turn until all rounds and the audit finish; cancellation preserves every completed round.',
  parameters: {
    type: 'object',
    properties: {
      goal: {
        type: 'string',
        description: 'The problem to design for. Include required behavior, constraints, and non-goals when known; anything missing becomes an open question instead of an invented requirement.',
      },
      constraints: {
        type: 'string',
        description: 'Hard constraints only: performance bounds, compatibility, language/runtime, invariants. Optional.',
      },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Existing files or directories the design must account for (refactors). Optional.',
      },
      rounds: {
        type: 'number',
        description: 'Number of design rounds. Defaults to the deployment default (24).',
      },
      name: {
        type: 'string',
        description: 'Problem directory name. Defaults to a slug of the goal. Reusing a name resumes that problem.',
      },
    },
    required: ['goal'],
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  },
  presentCall(args) {
    return {
      card: 'generic',
      title: 'arch_loop',
      rawInput: typeof args?.goal === 'string' ? args.goal : '',
    }
  },
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  ctx.tools.register({
    ...TOOL_DEFINITION,
    execute: (args, exec) => runArchLoop(ctx, config, args, exec),
  })
}
