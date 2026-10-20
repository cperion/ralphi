/**
 * ralph — one resumable fresh-context loop exposed as a DSH tool, with two
 * protocols behind `kind`:
 *
 *   kind: "design"  search for the simplest, clearest target design/architecture
 *   kind: "build"   do real work in the repository, one substantial verified
 *                   increment per round, resuming from the previous report
 *
 * One call creates (or resumes) `docs/ralph/<slug>/` inside the project
 * repository, runs N parent-owned fresh subagents against it, then one
 * independent audit. STATE.json is written atomically before and after every
 * round, so an interrupted call continues at the next round when called again
 * with the same name and goal.
 *
 * No harness package imports: only Node builtins and the services handed in by
 * the Loader, so the bundle loads from any profile.
 *
 * @module @local/dsh-plugin-arch-loop
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const name = 'tool-arch-loop'
export const inject = ['tools', 'subagents']

const KINDS = ['design', 'build']

// ---------------------------------------------------------------------------
// Report and audit schemas
// ---------------------------------------------------------------------------

const DESIGN_REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['mode', 'question', 'evidence', 'decision', 'next', 'ask'],
  properties: {
    mode: { type: 'string', enum: ['continue', 'simplify', 'experiment', 'rederive'] },
    question: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    decision: { type: 'string' },
    next: { type: 'string' },
    ask: { type: 'string' },
  },
}

const DESIGN_AUDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['material', 'finding', 'consequence'],
  properties: {
    material: { type: 'boolean' },
    finding: { type: 'string' },
    consequence: { type: 'string' },
  },
}

const BUILD_REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'summary', 'evidence', 'next', 'blocked', 'ask', 'done'],
  properties: {
    action: { type: 'string', enum: ['implement', 'fix', 'test', 'refactor', 'investigate', 'docs'] },
    summary: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    next: { type: 'string' },
    blocked: { type: 'string' },
    ask: { type: 'string' },
    done: { type: 'boolean' },
  },
}

const BUILD_AUDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['satisfied', 'evidence', 'gaps'],
  properties: {
    satisfied: { type: 'boolean' },
    evidence: { type: 'array', items: { type: 'string' } },
    gaps: { type: 'array', items: { type: 'string' } },
  },
}

// ---------------------------------------------------------------------------
// Design protocol
// ---------------------------------------------------------------------------

const DESIGN_WORKER_PERSONA = 'You are an architecture designer and adversarial simplifier. You search for the smallest set of concepts, states, invariants and representations that satisfies the contract. You do not write production code; a prototype, test or benchmark exists only to answer a question. You treat the current design, including your own previous rounds, as a hypothesis, not as a baseline to defend. You pursue the most material question until it is answered with evidence, and you measure a round by what the next round can do with it.'

const DESIGN_AUDITOR_PERSONA = 'You are an independent design auditor. You have not seen the search process. You judge only the contract and the written architecture, and you look for the first place an implementer would have to invent semantics the design did not specify.'

const CONTINUATION_RULES = `Continuation and progress:
- The previous round's report is a handoff, not a summary. Start from its next immediately; do not redo discovery that LOG.md, NOTES.md, or the report already record.
- Do not stop at the first small step. Push the work as far as it can honestly go in this round: make the change, run the checks, fix what fails, commit. A round that ends with "next: implement X" when X was cheap and safe to do now is a wasted round.
- Finishing the whole goal in one round is not required. Finishing something real and verified is. Incomplete is acceptable; superficial is not.
- If the previous report carries a userAnswer, it is the user's decision: apply it before anything else in this round.
- next is the continuation contract: a self-contained instruction the following round can execute with no new investigation — which file, which change, which command, which result proves it. Never leave next as a vague direction.`

const USER_INPUT_RULES = `User input:
- You have no direct line to the user. This loop relays questions for you: put the question in the report's \`ask\` field and the round ends there; the next round receives the user's answer as userAnswer. Commit your work first and set next to the step you will take once answered.
- Use \`ask\` only for decisions that are the user's to make and that change the work materially: requirements, destructive choices, credentials or access, priorities, acceptance criteria. Resolve everything discoverable by reading the repository yourself.
- Do not route a user-owned decision through blocked, and do not invent a material requirement to avoid asking. blocked is for an external failure that stops all progress; ask is for a choice only the user can settle.
- Ask one concrete question at a time, with the options and recommendation when the choice is enumerable. Never ask for permission to do the work the goal already asks for.`

const DESIGN_PROTOCOL = `You are one iteration of an architecture-design loop. You have no memory of previous rounds beyond the files in the problem directory.

Read, in this order: CONTRACT.md, QUESTIONS.md, LOG.md (the tail is enough), ARCHITECTURE.md.

Then do one substantial investigation toward the simplest, clearest design that satisfies the contract.

Question discovery comes first. Write down three candidate questions, rank them by materiality — could the answer change correctness, the data representation, the number of concepts, or violate a requirement? — and pursue the most material one until it is answered with evidence. If the first question turns out immaterial, immediately take the next most material one; only then report.

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

An investigation is not progress unless it changes the design or the next round's plan; "no material question remains" is a finding that must be evidenced by an implementable architecture, not a shortcut to end the round. Do not end a round by restating the incumbent, listing questions without pursuing one, or polishing prose — attack the largest remaining implementability risk with simplify, experiment, or rederive and record why nothing material is left open.

Do not delegate, build tooling, or invent progress.

${CONTINUATION_RULES}

${USER_INPUT_RULES}

Report mode, the question, evidence pointers, the decision, ask (a question for the user, empty when none), and the next uncertainty.`

const DESIGN_AUDIT_PROTOCOL = `Independent audit. You have not seen this search. Read only these two files:
<contract> and <architecture>.

Attempt to implement the essential required behavior from those documents alone. Every time you must invent a semantic decision the design did not specify, note it. Then judge whether one material gap remains: an omission that changes correctness, a representation that forces accidental complexity, or a simpler formulation the design missed.

material=false only if you could implement the contract without inventing anything material and found no simpler representation. finding: the single most consequential gap, or "none". consequence: what breaks, or what an implementer must guess, if it is not fixed.`

// ---------------------------------------------------------------------------
// Build protocol
// ---------------------------------------------------------------------------

const BUILD_WORKER_PERSONA = 'You are a careful software engineer who works in substantial, verified increments. You inspect before changing, keep changes focused, run the project checks, and never claim a result you did not observe. You treat the goal as fixed and record ambiguity instead of inventing requirements. You finish what you start: you do not trade real progress for a plan, a stub, or a summary, and when a round cannot finish the goal you leave precise continuation instead of a vague direction.'

const BUILD_VERIFIER_PERSONA = 'You are an independent verifier. You have not seen the work process. You judge only the goal and the actual repository state, and you trust observed commands over written claims.'

const BUILD_PROTOCOL = `You are one iteration of a work loop on a real repository. You have no memory of previous rounds beyond the files in the problem directory.

Read, in this order: GOAL.md, PLAN.md, NOTES.md, LOG.md, then inspect the repository and its git status. Trust the repository over the documents when they disagree, and correct the documents.

Do one substantial, verified increment of work that advances the goal. Not a plan, not a setup task, not a note about what should change.
- With a previous report, begin at its next; do not repeat completed work or re-inspect what NOTES.md already records.
- Choose the highest-value step from PLAN.md. Use a narrow investigation only when a genuinely blocking unknown prevents implementation, and then implement the step it unblocks in the same round.
- Keep working while safe progress is available: make the change, run the project's checks (tests, build, linter), fix what you broke, commit. Do not stop at the first small edit or at a clear next step that you could execute now.
- If the goal is ambiguous: take the cheapest defensible interpretation and record it in NOTES.md; if a materially different reading would change the work and only the user can settle it, use ask instead of guessing.
- If you cannot finish the goal this round, leave the repository working and committed, and make next the precise continuation.
- Blocked means external and concrete: a missing credential, an unavailable service. It never means "this is more than one round of work" and it never means a user-owned decision — use ask for those. A blocked round must record the exact command, error, and what would unblock it.
- Do not spend the round re-reading files that LOG.md or NOTES.md already summarise, building scaffolding, or writing TODOs, comments, or stubs instead of behavior.
- Do not delegate, do not build tooling beyond what the task needs, and do not claim progress you cannot evidence.
- Set done=true only when the goal's acceptance criteria are met AND you ran the checks yourself this round. The loop then runs an independent verifier; if it agrees, the run stops. If the goal is already complete, report done immediately, do not invent polish work, do not re-verify an already recorded close, and do not continue just because rounds remain.
- Marginal work to "use up" the round budget is a failure, not progress.

Update PLAN.md (done / next), append one dense section to LOG.md, and record durable findings or commands in NOTES.md. Keep scratch work in work/.

${CONTINUATION_RULES}

${USER_INPUT_RULES}

Actions: implement | fix | test | refactor | investigate | docs.

Report action, summary, evidence pointers, the next step, ask (a question for the user, empty when none), a blocker string (empty unless blocked), and done (true only when the goal is complete and verified).`

const BUILD_AUDIT_PROTOCOL = `Independent verification. You have not seen the work process. Read GOAL.md and inspect the repository. Do not trust PLAN.md or LOG.md.

Check whether the goal is satisfied:
- run the project's checks (tests, build, linter) yourself;
- inspect the actual code and the uncommitted diff, not just committed history;
- list concrete gaps, each with why the criterion fails.

satisfied=true only if the goal's criteria are met and you observed the evidence. evidence: commands run and their results. gaps: concrete unmet criteria, empty when satisfied.`

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const DESIGN_CONTRACT_RULES = `## Rules for this search
- Required behavior, observed legacy behavior, confirmed constraints, assumptions and preferences are distinct. Do not promote one into another.
- Missing requirements are open questions, never inventions.
- Definition of done: every stated requirement is accounted for, no unresolved material question remains, and an implementer can build the design without inventing semantics.`

const BUILD_GOAL_RULES = `## Rules for this work
- The goal is fixed. Missing requirements are recorded in NOTES.md and gaps in the final verification, never invented silently.
- Definition of done: the goal's criteria are met and verified by running the project's own checks.`

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

const PLAN_TEMPLATE = `# Plan

Status: not started.

Keep this current: what the approach is, what is done, what is next. Do not use
it as a diary; the round-by-round record belongs in \`LOG.md\`.

## Approach

## Steps
- [ ] 

## Next
`

const NOTES_TEMPLATE = `# Notes

Durable findings only: decisions, constraints discovered in the repository,
commands that matter, and ambiguities with the interpretation chosen. Append;
do not rewrite history.
`

const LOG_HEADER = `# Log

Append only, newest last. One dense section per round. Point at evidence rather
than copying it.
`

const ANSWERS_HEADER = `# User answers

Controller-owned record of questions that a round asked the user and the answers
it received. Round reports stay in \`rounds.jsonl\`; this file is the readable
trail of user decisions.
`

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

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
    .replace(/-+$/, '')
  return slug.length > 0 ? slug : 'problem'
}

function clip(value, limit) {
  const text = String(value ?? '')
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

// Build the resume anchor shown to the next round: the previous report is only
// useful if its `next` is read as the work order for this round.
function continueFrom(previous, fallback) {
  const next = typeof previous?.next === 'string' && previous.next.trim().length > 0
    ? previous.next.trim()
    : `not recorded — recover the continuation from ${fallback}`
  const blocked = typeof previous?.blocked === 'string' && previous.blocked.trim().length > 0
    ? `\nIt was blocked: ${previous.blocked.trim()}\nClear that blocker first, or work around it when it is not essential to the goal.`
    : ''
  return `${next}${blocked}`
}

// Surface a relayed user decision to the next round. The report may carry
// `ask` (unanswered) or `userAnswer` (answered); both are worth more than the
// JSON blob alone.
function answerNote(previous) {
  if (typeof previous?.userAnswer === 'string' && previous.userAnswer.trim().length > 0) {
    return `\nThe user answered the previous round's question: ${previous.userAnswer.trim()}\nThat answer is binding: apply it now, ahead of any earlier guess.`
  }
  if (typeof previous?.ask === 'string' && previous.ask.trim().length > 0) {
    return `\nThe previous round asked the user: ${previous.ask.trim()}\nNo answer is recorded yet. Repeat it in ask if it still blocks you.`
  }
  return ''
}

// Relay one round question to the user through the host's question service.
// The service admits only the exact live runtime root, which is the agent that
// called the ralph tool; a ralph started inside a child cannot ask.
async function askUser(ctx, exec, question, round) {
  const service = ctx.get('userQuestions')
  if (service === undefined) return { error: 'no user-questions channel is available to relay the question' }
  if (exec.agent === undefined) return { error: 'ralph needs a calling agent to relay a user question' }
  try {
    const result = await service.ask({
      questions: [{ id: `ralph-round-${round}`, header: `ralph round ${round}`, question }],
      agent: exec.agent,
      signal: exec.signal,
    })
    const answers = Array.isArray(result?.answers) ? result.answers : []
    const parts = []
    for (const item of answers) {
      const selected = Array.isArray(item?.selected) ? item.selected : []
      const text = [...selected, item?.custom]
        .filter((part) => typeof part === 'string' && part.trim().length > 0)
        .join('; ')
      if (text.length > 0) parts.push(text)
    }
    return { answer: parts.length > 0 ? parts.join('\n') : '(the user submitted no text or selection)' }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

// Append one question/answer pair to the readable trail in ANSWERS.md.
async function recordAnswer(dir, round, question, answer, source) {
  const heading = `## Round ${round}${source === undefined ? '' : ` (${source})`}`
  const lines = ['', heading, question ? `Q: ${question}` : '', `A: ${answer}`]
  await appendFile(join(dir, 'ANSWERS.md'), `${lines.join('\n')}\n`, 'utf8').catch(() => {})
}

function readArgs(raw, config) {
  if (typeof raw !== 'object' || raw === null) throw new Error('ralph: arguments must be an object')
  const goal = typeof raw.goal === 'string' ? raw.goal.trim() : ''
  if (goal.length === 0) throw new Error('ralph: goal must be a non-empty string')
  const kind = raw.kind === undefined ? 'build' : raw.kind
  if (!KINDS.includes(kind)) throw new Error(`ralph: kind must be one of ${KINDS.join(', ')}`)
  const constraints = typeof raw.constraints === 'string' && raw.constraints.trim().length > 0
    ? raw.constraints.trim()
    : undefined
  if (raw.paths !== undefined && !Array.isArray(raw.paths)) throw new Error('ralph: paths must be an array of strings')
  const paths = (raw.paths ?? []).filter((entry) => typeof entry === 'string' && entry.length > 0)
  const rounds = raw.rounds === undefined ? config.defaultRounds : raw.rounds
  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > config.maxRounds) {
    throw new Error(`ralph: rounds must be an integer between 1 and ${config.maxRounds}`)
  }
  const project = typeof raw.project === 'string' && raw.project.trim().length > 0 ? raw.project.trim() : undefined
  const name = typeof raw.name === 'string' && raw.name.trim().length > 0 ? raw.name.trim() : goal
  const answer = typeof raw.answer === 'string' && raw.answer.trim().length > 0 ? raw.answer.trim() : undefined
  return { goal, kind, constraints, paths, rounds, project, slug: slugify(name), answer }
}

function pathList(paths) {
  return paths.length === 0 ? 'None specified.' : paths.map((entry) => `- \`${entry}\``).join('\n')
}

function constraintText(constraints) {
  return constraints === undefined
    ? 'None stated. Treat any missing requirement as an open question in the notes; do not invent behavior.'
    : constraints
}

function designContractText(args) {
  return `# Contract

## Problem
${args.goal}

## Constraints
${constraintText(args.constraints)}

## Existing code
${pathList(args.paths)}

${DESIGN_CONTRACT_RULES}
`
}

function buildGoalText(args) {
  return `# Goal
${args.goal}

## Constraints
${constraintText(args.constraints)}

## Paths
${pathList(args.paths)}

${BUILD_GOAL_RULES}
`
}

async function ensureFile(filePath, text) {
  if (!existsSync(filePath)) await writeFile(filePath, text, 'utf8')
}

const STATE_FILE = 'STATE.json'

function atomicWrite(filePath, text) {
  const tmp = `${filePath}.${process.pid}.tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, filePath)
}

function findProjectRoot(start) {
  let current = resolve(start)
  for (;;) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

function resolveProjectRoot(rawProject, workspace) {
  if (typeof rawProject === 'string' && rawProject.length > 0) {
    const candidate = resolve(workspace, rawProject)
    if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
      throw new Error(`ralph: project path is not a directory: ${candidate}`)
    }
    return candidate
  }
  return findProjectRoot(workspace) ?? workspace
}

function readState(dir) {
  const file = join(dir, STATE_FILE)
  if (!existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    if (!Number.isSafeInteger(parsed.nextRound) || !Number.isSafeInteger(parsed.completedRounds)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

function writeState(dir, state) {
  atomicWrite(join(dir, STATE_FILE), `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`)
}

function readLastReport(dir) {
  const file = join(dir, 'rounds.jsonl')
  if (!existsSync(file)) return undefined
  const lines = readFileSync(file, 'utf8').trim().split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const entry = JSON.parse(lines[index])
      if (entry !== null && typeof entry === 'object') return entry
    } catch {
      /* skip malformed line */
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

function designRoundPrompt(problemAbs, projectRoot, problemRel, round, previous, extra = '') {
  const prior = previous === undefined
    ? 'No previous round report exists: ARCHITECTURE.md may still have no candidate. Start real investigation immediately; do not spend the round only on setup.'
    : `Previous round report (handoff): ${JSON.stringify(previous)}
Resume from its next: ${continueFrom(previous, 'ARCHITECTURE.md and LOG.md')}${answerNote(previous)}`
  return `${DESIGN_PROTOCOL}

Problem directory: ${problemAbs}
Files: ${problemAbs}/CONTRACT.md, ${problemAbs}/QUESTIONS.md, ${problemAbs}/LOG.md, ${problemAbs}/ARCHITECTURE.md

Round ${round}. ${prior}

Prefix experiment files with the round number. Keep everything inside the problem directory. If the project is a git repository, commit only this directory when you finish:
git -C "${projectRoot}" add "${problemRel}" && git -C "${projectRoot}" commit -m "ralph design round ${round}"${extra}`
}

function designAuditPrompt(problemAbs, projectRoot, problemRel) {
  return DESIGN_AUDIT_PROTOCOL
    .replace('<contract>', `${problemAbs}/CONTRACT.md`)
    .replace('<architecture>', `${problemAbs}/ARCHITECTURE.md`)
}

function buildRoundPrompt(problemAbs, projectRoot, problemRel, round, previous, extra = '') {
  const prior = previous === undefined
    ? 'No previous round report exists: this is the first round. Do real work immediately; do not spend the round only on setup.'
    : `Previous round report (handoff): ${JSON.stringify(previous)}
Resume from its next: ${continueFrom(previous, 'PLAN.md and LOG.md')}${answerNote(previous)}`
  return `${BUILD_PROTOCOL}

Problem directory: ${problemAbs}
Files: ${problemAbs}/GOAL.md, ${problemAbs}/PLAN.md, ${problemAbs}/NOTES.md, ${problemAbs}/LOG.md
Workspace: the project repository at ${projectRoot}

Round ${round}. ${prior}

Keep scratch files in ${problemAbs}/work/. Commit your work in the project repository; this directory is in the repository and should be committed with it.${extra}`
}

function buildAuditPrompt(problemAbs) {
  return BUILD_AUDIT_PROTOCOL.replace('<goal>', `${problemAbs}/GOAL.md`) +
    `\n\nGoal file: ${problemAbs}/GOAL.md`
}

function designEnsureState(dir, args) {
  return (async () => {
    await mkdir(join(dir, 'experiments'), { recursive: true })
    await ensureFile(join(dir, 'CONTRACT.md'), designContractText(args))
    await ensureFile(join(dir, 'ARCHITECTURE.md'), ARCHITECTURE_TEMPLATE)
    await ensureFile(join(dir, 'QUESTIONS.md'), QUESTIONS_TEMPLATE)
    await ensureFile(join(dir, 'LOG.md'), LOG_HEADER)
    await ensureFile(join(dir, 'ANSWERS.md'), ANSWERS_HEADER)
  })()
}

function buildEnsureState(dir, args) {
  return (async () => {
    await mkdir(join(dir, 'work'), { recursive: true })
    await ensureFile(join(dir, 'GOAL.md'), buildGoalText(args))
    await ensureFile(join(dir, 'PLAN.md'), PLAN_TEMPLATE)
    await ensureFile(join(dir, 'NOTES.md'), NOTES_TEMPLATE)
    await ensureFile(join(dir, 'LOG.md'), LOG_HEADER)
    await ensureFile(join(dir, 'ANSWERS.md'), ANSWERS_HEADER)
  })()
}

const DESIGN_PROFILE = {
  kind: 'design',
  reportSchema: DESIGN_REPORT_SCHEMA,
  auditSchema: DESIGN_AUDIT_SCHEMA,
  workerPersona: DESIGN_WORKER_PERSONA,
  auditorPersona: DESIGN_AUDITOR_PERSONA,
  roundPrompt: designRoundPrompt,
  auditPrompt: designAuditPrompt,
  ensureState: designEnsureState,
  describePlan(entries) {
    const counts = { continue: 0, simplify: 0, experiment: 0, rederive: 0 }
    for (const entry of entries) counts[entry.mode] = (counts[entry.mode] ?? 0) + 1
    return `${counts.continue} continue · ${counts.simplify} simplify · ${counts.experiment} experiment · ${counts.rederive} rederive`
  },
  auditLines(audit) {
    const lines = [audit.material
      ? `audit: MATERIAL GAP — ${audit.finding}`
      : `audit: no material gap — ${audit.finding}`]
    if (audit.material) lines.push(`consequence: ${audit.consequence}`)
    return lines
  },
  roundLine(entry) {
    return `${entry.mode} — ${entry.question} → ${entry.decision}`
  },
}

const BUILD_PROFILE = {
  kind: 'build',
  reportSchema: BUILD_REPORT_SCHEMA,
  auditSchema: BUILD_AUDIT_SCHEMA,
  workerPersona: BUILD_WORKER_PERSONA,
  auditorPersona: BUILD_VERIFIER_PERSONA,
  roundPrompt: buildRoundPrompt,
  auditPrompt: buildAuditPrompt,
  ensureState: buildEnsureState,
  describePlan(entries) {
    const actions = ['implement', 'fix', 'test', 'refactor', 'investigate', 'docs']
    const counts = { implement: 0, fix: 0, test: 0, refactor: 0, investigate: 0, docs: 0 }
    for (const entry of entries) counts[entry.action] = (counts[entry.action] ?? 0) + 1
    return actions.map((action) => `${counts[action]} ${action}`).join(' · ')
  },
  auditLines(audit) {
    if (audit.satisfied) {
      const evidence = audit.evidence.length === 0 ? 'no evidence recorded' : clip(audit.evidence.join('; '), 300)
      return [`audit: GOAL MET — ${evidence}`]
    }
    const gaps = audit.gaps.length === 0 ? 'no gaps listed' : clip(audit.gaps.join('; '), 400)
    return [`audit: NOT MET — ${gaps}`]
  },
  roundLine(entry) {
    return `${entry.action} — ${entry.summary}${entry.blocked ? ` (blocked: ${entry.blocked})` : ''}`
  },
}

const PROFILES = { design: DESIGN_PROFILE, build: BUILD_PROFILE }

// ---------------------------------------------------------------------------
// Child execution
// ---------------------------------------------------------------------------

function requireProvider(ctx, providerName) {
  const provider = ctx.subagents.getProvider(providerName)
  if (provider === undefined) throw new Error(`ralph: subagent provider "${providerName}" is not registered`)
  if (provider.inheritsParentContext) throw new Error(`ralph: provider "${providerName}" inherits parent context; a fresh provider is required`)
  if (!provider.capabilities.outputSchema) throw new Error(`ralph: provider "${providerName}" does not support structured output`)
  return provider
}

async function runChild(ctx, providerName, parent, signal, request) {
  // DSH 0.2.1 seam: one-shot children are started through startActivation.
  // persona and toolFilter are no longer request capabilities, so the persona is
  // composed into the prompt and the "do not delegate" rule stays in the protocol.
  const activation = await ctx.subagents.startActivation({
    provider: providerName,
    label: request.label,
    request: {
      parent,
      prompt: [{ type: 'text', text: `${request.persona}\n\n${request.prompt}\n\nDo not call the ralph tool; you are one iteration inside it.` }],
      outputSchema: request.schema,
      cwd: request.cwd,
    },
    signal,
    delivery: 'caller',
  })
  try {
    const result = await activation.result
    if (result.stopReason !== 'completed') {
      return { error: `child ended with ${result.stopReason}${result.diagnostic === undefined ? '' : `: ${result.diagnostic}`}` }
    }
    if (result.structured === undefined || result.structured === null || typeof result.structured !== 'object') {
      return { error: 'child returned no structured report' }
    }
    return { value: result.structured }
  } finally {
    await activation.dispose()
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderResult(value, profile) {
  const lines = []
  const progress = value.completedRounds === undefined
    ? `${value.done}/${value.rounds} rounds`
    : `${value.done}/${value.rounds} rounds this call · ${value.completedRounds} total`
  lines.push(`ralph ${value.kind} ${value.status} — ${value.problemDir} — ${progress}`)
  if (value.resumedFrom !== undefined) lines.push(`resumed from round ${value.resumedFrom}`)
  if (value.earlyStopRound !== undefined) lines.push(`stopped early: goal verified at round ${value.earlyStopRound} of ${value.rounds}`)
  if (value.modes !== undefined) lines.push(`${value.kind === 'design' ? 'modes' : 'actions'}: ${value.modes}`)
  if (value.lastQuestion !== undefined) lines.push(`last question: ${value.lastQuestion}`)
  if (value.lastDecision !== undefined) lines.push(`last decision: ${value.lastDecision}`)
  if (value.lastSummary !== undefined) lines.push(`last summary: ${value.lastSummary}`)
  if (value.lastNext !== undefined) lines.push(`next step: ${value.lastNext}`)
  if (value.audit !== undefined) for (const line of profile.auditLines(value.audit)) lines.push(line)
  if (value.recent !== undefined && value.recent.length > 0) {
    lines.push('recent rounds:')
    for (const entry of value.recent) lines.push(`  ${entry.round}. ${profile.roundLine(entry)}`)
  }
  if (value.question !== undefined) lines.push(`question for the user: ${value.question}`)
  if (value.lastAnswer !== undefined) lines.push(`last user answer: ${clip(value.lastAnswer, 300)}`)
  if (value.failure !== undefined) lines.push(`failure: ${value.failure}`)
  if (value.nextRound !== undefined) {
    if (value.status === 'needs-input') {
      lines.push(`the run is paused at round ${value.nextRound}: ask the user the question above, then call ralph again with the same name and goal and pass the answer as "answer"`)
    } else {
      lines.push(value.status === 'complete'
        ? `next call starts at round ${value.nextRound}`
        : `next call continues at round ${value.nextRound}`)
    }
  }
  lines.push(`state: ${value.problemDir}/{STATE.json,LOG.md,ANSWERS.md}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/**
 * Run one ralph call. Exported for direct testing; the tool wrapper below is the
 * only production caller.
 */
export async function runRalph(ctx, config, rawArgs, exec) {
  const agent = exec.agent
  if (agent === undefined) throw new Error('ralph requires a calling agent')
  const args = readArgs(rawArgs, config)
  const profile = PROFILES[args.kind]
  const workspace = agent.session.header.cwd ?? process.cwd()
  const projectRoot = resolveProjectRoot(args.project, workspace)
  const problemRel = `docs/ralph/${args.slug}`
  const problemAbs = join(projectRoot, 'docs', 'ralph', args.slug)

  requireProvider(ctx, config.provider)

  const existing = readState(problemAbs)
  if (existing !== undefined && typeof existing.goal === 'string' && existing.goal.trim() !== args.goal) {
    throw new Error(`ralph: "${args.slug}" already exists in ${problemRel} with a different goal. Use a different name, or delete that directory to start over.`)
  }
  if (existing !== undefined && typeof existing.kind === 'string' && existing.kind !== args.kind) {
    throw new Error(`ralph: "${args.slug}" already exists as kind "${existing.kind}". Use a different name, or delete ${problemRel}/ to switch kind.`)
  }
  await profile.ensureState(problemAbs, args)

  const resumed = existing !== undefined
  let state = existing ?? {
    version: 1,
    kind: args.kind,
    slug: args.slug,
    goal: args.goal,
    nextRound: 1,
    completedRounds: 0,
    status: 'running',
    inProgress: null,
  }
  if (!Number.isSafeInteger(state.inProgress)) state.inProgress = null

  let round = state.inProgress ?? state.nextRound
  const resumedFrom = resumed ? round : undefined
  const startedAt = new Date().toISOString()
  const trajectory = []
  const recent = []
  let status = 'complete'
  let failure
  let audit
  let question
  let lastReport = readLastReport(problemAbs)
  let verified = false
  let earlyStopRound
  let feedback
  let lastRejectedGaps

  // A previous call may have stopped after a round asked the user a question.
  // Prefer the answer already stored in STATE.json (it survives interruption),
  // then a caller-supplied answer, and only then relay the question again.
  if (lastReport !== undefined && typeof lastReport.ask === 'string' && lastReport.ask.trim().length > 0) {
    const askedRound = Number.isSafeInteger(lastReport.round) ? lastReport.round : state.completedRounds
    if (typeof lastReport.userAnswer === 'string') {
      // already answered in this call's records
    } else if (state.answerForRound === askedRound && typeof state.lastAnswer === 'string') {
      lastReport = { ...lastReport, userAnswer: state.lastAnswer }
    } else if (args.answer !== undefined) {
      await recordAnswer(problemAbs, askedRound, lastReport.ask.trim(), args.answer, 'from caller')
      lastReport = { ...lastReport, userAnswer: args.answer }
      state = { ...state, lastAnswer: args.answer, answerForRound: askedRound }
    } else {
      const asked = await askUser(ctx, exec, lastReport.ask.trim(), askedRound)
      if (asked.error !== undefined) {
        if (exec.signal.aborted) {
          status = 'cancelled'
          failure = 'cancelled by the caller while waiting for the user'
        } else {
          status = 'needs-input'
          failure = `question from round ${askedRound}: ${asked.error}`
          question = lastReport.ask.trim()
        }
      } else {
        await recordAnswer(problemAbs, askedRound, lastReport.ask.trim(), asked.answer, 'resumed')
        lastReport = { ...lastReport, userAnswer: asked.answer }
        state = { ...state, lastAnswer: asked.answer, answerForRound: askedRound }
      }
    }
  } else if (args.answer !== undefined) {
    throw new Error('ralph: an "answer" was supplied but the last round did not ask a question')
  }

  state = { ...state, status: 'running', kind: args.kind }
  writeState(problemAbs, state)

  const verifyGoal = async () => {
    const auditRun = await runChild(ctx, config.provider, agent, exec.signal, {
      label: `ralph ${args.kind} ${args.slug} audit`,
      prompt: profile.auditPrompt(problemAbs, projectRoot, problemRel),
      schema: profile.auditSchema,
      persona: profile.auditorPersona,
      cwd: projectRoot,
    })
    if (auditRun.error !== undefined) return { error: auditRun.error }
    await writeFile(join(problemAbs, 'AUDIT.json'), `${JSON.stringify({ at: new Date().toISOString(), kind: args.kind, ...auditRun.value }, null, 2)}\n`, 'utf8')
    return { value: auditRun.value }
  }

  try {
    while (status === 'complete' && trajectory.length < args.rounds) {
      if (exec.signal.aborted) {
        status = 'cancelled'
        failure = 'cancelled by the caller'
        break
      }
      state = { ...state, status: 'running', inProgress: round, nextRound: round }
      writeState(problemAbs, state)

      const budgetHint = args.kind === 'build'
        ? `\n\nBudget: at most ${args.rounds} round(s) in this call. That is a ceiling, not a quota. If the goal's acceptance criteria are met and verified, set done=true; an independent verifier decides whether the loop stops. Do not create marginal work to consume the budget.`
        : ''
      const promptExtra = `${budgetHint}${feedback === undefined ? '' : `\n\n${feedback}`}`
      feedback = undefined
      const { value, error } = await runChild(ctx, config.provider, agent, exec.signal, {
        label: `ralph ${args.kind} ${args.slug} round ${round}`,
        prompt: profile.roundPrompt(problemAbs, projectRoot, problemRel, round, lastReport, promptExtra),
        schema: profile.reportSchema,
        persona: profile.workerPersona,
        cwd: projectRoot,
      })
      if (error !== undefined) {
        status = 'round-failed'
        failure = `round ${round}: ${error}`
        writeState(problemAbs, { ...state, status, inProgress: round, nextRound: round })
        break
      }

      let report = { at: new Date().toISOString(), round, ...value }
      await appendFile(join(problemAbs, 'rounds.jsonl'), `${JSON.stringify(report)}\n`, 'utf8')

      state = { ...state, completedRounds: round, inProgress: null, nextRound: round + 1 }
      writeState(problemAbs, state)
      trajectory.push(report)
      recent.push(report)
      if (recent.length > 3) recent.shift()
      lastReport = report

      // A round may hand a user-owned decision to the loop instead of guessing.
      // Relay it now; the answer reaches the next round as userAnswer.
      if (typeof report.ask === 'string' && report.ask.trim().length > 0) {
        const asked = await askUser(ctx, exec, report.ask.trim(), round)
        if (asked.error !== undefined) {
          if (exec.signal.aborted) {
            status = 'cancelled'
            failure = 'cancelled by the caller while waiting for the user'
          } else {
            status = 'needs-input'
            failure = `round ${round}: ${asked.error}`
            question = report.ask.trim()
          }
          break
        }
        await recordAnswer(problemAbs, round, report.ask.trim(), asked.answer)
        state = { ...state, lastAnswer: asked.answer, answerForRound: round }
        writeState(problemAbs, state)
        report = { ...report, userAnswer: asked.answer }
        trajectory[trajectory.length - 1] = report
        recent[recent.length - 1] = report
        lastReport = report
      }

      // Build mode stops as soon as an independent verifier agrees the goal is met.
      // The round budget is a ceiling; it must never turn into a quota of busywork.
      if (args.kind === 'build' && report.done === true && !(typeof report.ask === 'string' && report.ask.trim().length > 0)) {
        const verification = await verifyGoal()
        if (verification.error !== undefined) {
          status = 'audit-failed'
          failure = verification.error
          break
        }
        audit = verification.value
        if (audit.satisfied !== true) {
          const gaps = Array.isArray(audit.gaps) ? audit.gaps : []
          const key = JSON.stringify(gaps)
          if (lastRejectedGaps !== undefined && key === lastRejectedGaps) {
            status = 'blocked'
            failure = `independent verification rejected the goal twice with the same gaps: ${gaps.join('; ') || '(none listed)'}`
            break
          }
          lastRejectedGaps = key
          feedback = `Independent verification did not accept the goal yet. Gaps:\n- ${gaps.length > 0 ? gaps.join('\n- ') : '(none listed; re-read GOAL.md and inspect the workspace)'}\nClose these gaps before reporting done again.`
        } else {
          verified = true
          earlyStopRound = round
          break
        }
      }
      round += 1
    }

    if (status === 'complete' && !exec.signal.aborted && !verified) {
      const verification = await verifyGoal()
      if (verification.error !== undefined) {
        status = 'audit-failed'
        failure = verification.error
      } else {
        audit = verification.value
        verified = audit.satisfied === true
      }
    }
  } catch (error) {
    status = 'error'
    failure = error instanceof Error ? error.message : String(error)
  }

  state = { ...state, status }
  writeState(problemAbs, state)

  const modes = profile.describePlan(trajectory)
  const last = trajectory.length > 0 ? trajectory[trajectory.length - 1] : undefined
  const isDesign = args.kind === 'design'

  await appendFile(join(problemAbs, 'runs.jsonl'), `${JSON.stringify({
    at: startedAt,
    finishedAt: new Date().toISOString(),
    kind: args.kind,
    goal: args.goal,
    projectRoot,
    rounds: args.rounds,
    done: trajectory.length,
    earlyStopRound,
    verified,
    firstRound: resumedFrom ?? 1,
    completedRounds: state.completedRounds,
    nextRound: state.nextRound,
    status,
    failure,
    question,
  })}\n`, 'utf8').catch(() => {})

  return {
    text: renderResult({
      kind: args.kind,
      status,
      problemDir: problemRel,
      rounds: args.rounds,
      done: trajectory.length,
      earlyStopRound,
      completedRounds: state.completedRounds,
      nextRound: state.nextRound,
      resumedFrom,
      modes,
      lastQuestion: isDesign && last !== undefined ? clip(last.question, 300) : undefined,
      lastDecision: isDesign && last !== undefined ? clip(last.decision, 400) : undefined,
      lastSummary: !isDesign && last !== undefined ? clip(last.summary, 400) : undefined,
      lastNext: !isDesign && last !== undefined ? clip(last.next, 300) : undefined,
      recent,
      audit,
      failure,
      question,
      lastAnswer: lastReport !== undefined && typeof lastReport.userAnswer === 'string' ? lastReport.userAnswer : undefined,
    }, profile),
  }
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const TOOL_DEFINITION = {
  name: 'ralph',
  description: 'Run a resumable fresh-context loop over a repository. kind="build" does a substantial, verified increment of real work per round (implement, fix, test, refactor) and ends with an independent verification of the goal. kind="design" searches for the simplest target architecture, one substantial investigation per round, ending with an implementability audit. Every round resumes from the previous report\'s next and must leave the repository measurably closer to the goal; incomplete rounds are fine, superficial ones are not. A round that needs a user-owned decision asks through the loop: the question is relayed to the user in this session and the answer reaches the next round. State lives in docs/ralph/<name>/ inside the project repository and is committed with the code; STATE.json is updated after every round, so an interrupted call continues from the next round when called again with the same name and goal. Use design for architecture/code-structuring targets; build for changes and implementation. Long-running: blocks the turn. Build mode stops as soon as an independent verifier accepts the goal, so the remaining rounds are a ceiling, not a quota; a round that reports done triggers verification immediately and attaches any remaining gaps as feedback to the next round.',
  parameters: {
    type: 'object',
    properties: {
      goal: {
        type: 'string',
        description: 'The objective. For build: what must be true when done, with acceptance criteria in the text when known. For design: the problem, required behavior, constraints and non-goals.',
      },
      kind: {
        type: 'string',
        enum: ['build', 'design'],
        description: 'Protocol to run. Defaults to "build"; use "design" for target-architecture search.',
      },
      constraints: {
        type: 'string',
        description: 'Hard constraints only: performance bounds, compatibility, language/runtime, invariants. Optional.',
      },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Existing files or directories the work/design must account for. Optional.',
      },
      rounds: {
        type: 'number',
        description: 'Rounds to run in this call. Defaults to the deployment default (24); later calls add more. Build mode stops early once the goal is verified, so this is a ceiling.',
      },
      name: {
        type: 'string',
        description: 'Problem directory name. Defaults to a slug of the goal. Reusing a name resumes that run.',
      },
      project: {
        type: 'string',
        description: 'Project repository root that owns docs/ralph/. Relative paths resolve against the workspace. Defaults to the git root containing the workspace, or the workspace itself.',
      },
      answer: {
        type: 'string',
        description: 'The user answer to a question from a previous needs-input run. Pass it when restarting a paused run; omit otherwise.',
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
      title: typeof args?.kind === 'string' ? `ralph ${args.kind}` : 'ralph',
      rawInput: typeof args?.goal === 'string' ? args.goal : '',
    }
  },
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  ctx.tools.register({
    ...TOOL_DEFINITION,
    execute: (args, exec) => runRalph(ctx, config, args, exec),
  })
}
