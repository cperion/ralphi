/**
 * ralph for pi — one resumable fresh-context loop exposed as one tool, with two
 * protocols behind `kind`:
 *
 *   kind: "design"  search for the simplest, clearest target design/architecture
 *   kind: "build"   do real work in the repository, one verified unit per round
 *
 * One call creates (or resumes) `docs/ralph/<slug>/` inside the project
 * repository, runs N rounds each in a fresh `pi` child process, then one
 * independent audit. STATE.json is written atomically before and after every
 * round, so an interrupted call continues at the next round when called again
 * with the same name and goal.
 *
 * Report protocol is file-based (`rounds/rNNN.json`, `rounds/audit.json`) so the
 * parent never parses assistant prose.
 *
 * @module @local/pi-arch-loop
 */

import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import { Type } from "typebox"

const MAX_ROUNDS = 64
const DEFAULT_ROUNDS = 24
const MAX_CAPTURED_STDERR = 8192

const KINDS = ["design", "build"] as const
type Kind = (typeof KINDS)[number]

const DESIGN_MODES = ["continue", "simplify", "experiment", "rederive"] as const
type DesignMode = (typeof DESIGN_MODES)[number]

const BUILD_ACTIONS = ["implement", "fix", "test", "refactor", "investigate", "docs"] as const
type BuildAction = (typeof BUILD_ACTIONS)[number]

interface DesignReport {
	mode: DesignMode
	question: string
	evidence: string[]
	decision: string
	next: string
}

interface BuildReport {
	action: BuildAction
	summary: string
	evidence: string[]
	next: string
	blocked: string
}

type RoundReport = DesignReport | BuildReport

interface DesignAudit {
	material: boolean
	finding: string
	consequence: string
}

interface BuildAudit {
	satisfied: boolean
	evidence: string[]
	gaps: string[]
}

type AuditReport = DesignAudit | BuildAudit

interface Usage {
	input: number
	output: number
	cacheRead: number
	cacheWrite: number
	cost: number
	turns: number
}

/** Details shape carried to the TUI renderer. */
interface RalphDetails {
	kind?: Kind
	phase?: "round" | "audit"
	round?: number
	rounds?: number
	status?: string
	problemDir?: string
	done?: number
	completedRounds?: number
	nextRound?: number
	resumedFrom?: number
	plan?: string
	audit?: AuditReport
	failure?: string
	usage?: Usage
}

interface RalphArgs {
	goal: string
	kind: Kind
	constraints?: string
	paths: string[]
	rounds: number
	project?: string
	slug: string
}

/** Controller-owned resume marker, rewritten atomically after every round. */
interface RunState {
	version: number
	kind: Kind
	slug: string
	goal: string
	nextRound: number
	completedRounds: number
	status: string
	inProgress: number | null
	updatedAt?: string
}

interface Profile {
	kind: Kind
	workerPrompt: string
	auditorPrompt: string
	ensureState(dir: string, args: RalphArgs): void
	roundPrompt(problemAbs: string, projectRoot: string, problemRel: string, round: number, previous: RoundReport | undefined, reportAbs: string): string
	auditPrompt(problemAbs: string, reportAbs: string): string
	readReport(filePath: string): { value?: RoundReport; error?: string }
	readAudit(filePath: string): { value?: AuditReport; error?: string }
	describePlan(entries: RoundReport[]): string
	auditLines(audit: AuditReport): string[]
	roundLine(entry: RoundReport): string
}

// ---------------------------------------------------------------------------
// Personas and protocols
// ---------------------------------------------------------------------------

const DESIGN_WORKER_PERSONA =
	"You are an architecture designer and adversarial simplifier. You search for the smallest set of concepts, states, invariants and representations that satisfies the contract. You do not write production code; a prototype, test or benchmark exists only to answer a question. You treat the current design, including your own previous rounds, as a hypothesis, not as a baseline to defend."

const DESIGN_AUDITOR_PERSONA =
	"You are an independent design auditor. You have not seen the search process. You judge only the contract and the written architecture, and you look for the first place an implementer would have to invent semantics the design did not specify."

const BUILD_WORKER_PERSONA =
	"You are a careful software engineer working one verified unit at a time. You inspect before changing, keep changes focused, run the project checks, and never claim a result you did not observe. You treat the goal as fixed and record ambiguity instead of inventing requirements."

const BUILD_VERIFIER_PERSONA =
	"You are an independent verifier. You have not seen the work process. You judge only the goal and the actual repository state, and you trust observed commands over written claims."

const DESIGN_PROTOCOL = `You are one iteration of an architecture-design loop. You have no memory of previous rounds beyond the files in the problem directory.

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

Your final action must be writing the round report JSON file named in the user message, with exactly these fields and nothing else:
{"mode": "continue|simplify|experiment|rederive", "question": "string", "evidence": ["path or result"], "decision": "string", "next": "string"}`

const DESIGN_AUDIT_PROTOCOL = `Independent audit. You have not seen this search. Read only CONTRACT.md and ARCHITECTURE.md in the problem directory.

Attempt to implement the essential required behavior from those documents alone. Every time you must invent a semantic decision the design did not specify, note it. Then judge whether one material gap remains: an omission that changes correctness, a representation that forces accidental complexity, or a simpler formulation the design missed.

material=false only if you could implement the contract without inventing anything material and found no simpler representation. finding: the single most consequential gap, or "none". consequence: what breaks, or what an implementer must guess, if it is not fixed; use "" when material is false.

Your final action must be writing the audit JSON file named in the user message, with exactly these fields and nothing else:
{"material": true|false, "finding": "string", "consequence": "string"}`

const BUILD_PROTOCOL = `You are one iteration of a work loop on a real repository. You have no memory of previous rounds beyond the files in the problem directory.

Read, in this order: GOAL.md, PLAN.md, NOTES.md, LOG.md, then inspect the repository and its git status.

Do exactly one unit of work that advances the goal:
- pick the highest-value step from PLAN.md, or the smallest step that resolves the biggest unknown;
- if the goal is ambiguous, take the cheapest defensible interpretation and record it in NOTES.md instead of inventing silently;
- keep changes focused; do not rewrite unrelated code;
- run the project's checks (tests, build, linter) and fix what you broke; never report success you did not observe;
- commit the work with a focused message.

Update PLAN.md (done / next), append one dense section to LOG.md, and record durable findings or commands in NOTES.md. Keep scratch work in work/.

Do not delegate, do not build tooling beyond what the task needs, and do not claim progress you cannot evidence.

Actions: implement | fix | test | refactor | investigate | docs.

Your final action must be writing the round report JSON file named in the user message, with exactly these fields and nothing else:
{"action": "implement|fix|test|refactor|investigate|docs", "summary": "string", "evidence": ["command or file"], "next": "string", "blocked": ""}`

const BUILD_AUDIT_PROTOCOL = `Independent verification. You have not seen the work process. Read GOAL.md and inspect the repository. Do not trust PLAN.md or LOG.md.

Check whether the goal is satisfied:
- run the project's checks (tests, build, linter) yourself;
- inspect the actual code and the uncommitted diff, not just committed history;
- list concrete gaps, each with why the criterion fails.

satisfied=true only if the goal's criteria are met and you observed the evidence. evidence: commands run and their results. gaps: concrete unmet criteria, empty when satisfied.

Your final action must be writing the audit JSON file named in the user message, with exactly these fields and nothing else:
{"satisfied": true|false, "evidence": ["command and result"], "gaps": ["string"]}`

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }
}

function slugify(text: string): string {
	const slug = String(text)
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48)
		.replace(/-+$/, "")
	return slug.length > 0 ? slug : "problem"
}

function clip(value: unknown, limit: number): string {
	const text = String(value ?? "")
	return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

function formatTokens(count: number): string {
	if (count < 1000) return String(count)
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`
	if (count < 1000000) return `${Math.round(count / 1000)}k`
	return `${(count / 1000000).toFixed(1)}M`
}

function textOf(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("\n")
}

function readArgs(raw: Record<string, unknown>, maxRounds: number, defaultRounds: number): RalphArgs {
	const goal = typeof raw.goal === "string" ? raw.goal.trim() : ""
	if (goal.length === 0) throw new Error("ralph: goal must be a non-empty string")
	const kind = raw.kind === undefined ? "build" : raw.kind
	if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) {
		throw new Error(`ralph: kind must be one of ${KINDS.join(", ")}`)
	}
	const constraints = typeof raw.constraints === "string" && raw.constraints.trim().length > 0 ? raw.constraints.trim() : undefined
	if (raw.paths !== undefined && !Array.isArray(raw.paths)) throw new Error("ralph: paths must be an array of strings")
	const paths = (raw.paths as unknown[] | undefined ?? []).filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
	const rounds = raw.rounds === undefined ? defaultRounds : raw.rounds
	if (typeof rounds !== "number" || !Number.isSafeInteger(rounds) || rounds < 1 || rounds > maxRounds) {
		throw new Error(`ralph: rounds must be an integer between 1 and ${maxRounds}`)
	}
	const project = typeof raw.project === "string" && raw.project.trim().length > 0 ? raw.project.trim() : undefined
	const name = typeof raw.name === "string" && raw.name.trim().length > 0 ? raw.name.trim() : goal
	return { goal, kind: kind as Kind, constraints, paths, rounds, project, slug: slugify(name) }
}

function pathList(paths: string[]): string {
	return paths.length === 0 ? "None specified." : paths.map((entry) => `- \`${entry}\``).join("\n")
}

function constraintText(constraints: string | undefined): string {
	return constraints === undefined
		? "None stated. Treat any missing requirement as an open question in the notes; do not invent behavior."
		: constraints
}

function designContractText(args: RalphArgs): string {
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

function buildGoalText(args: RalphArgs): string {
	return `# Goal
${args.goal}

## Constraints
${constraintText(args.constraints)}

## Paths
${pathList(args.paths)}

${BUILD_GOAL_RULES}
`
}

function ensureFile(filePath: string, text: string): void {
	if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, text, "utf8")
}

const STATE_FILE = "STATE.json"

function atomicWrite(filePath: string, text: string): void {
	const tmp = `${filePath}.${process.pid}.tmp`
	fs.writeFileSync(tmp, text, "utf8")
	fs.renameSync(tmp, filePath)
}

function findProjectRoot(start: string): string | undefined {
	let current = path.resolve(start)
	for (;;) {
		if (fs.existsSync(path.join(current, ".git"))) return current
		const parent = path.dirname(current)
		if (parent === current) return undefined
		current = parent
	}
}

function resolveProjectRoot(rawProject: string | undefined, workspace: string): string {
	if (rawProject !== undefined) {
		const candidate = path.resolve(workspace, rawProject)
		if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
			throw new Error(`ralph: project path is not a directory: ${candidate}`)
		}
		return candidate
	}
	return findProjectRoot(workspace) ?? workspace
}

function readState(dir: string): RunState | undefined {
	const file = path.join(dir, STATE_FILE)
	if (!fs.existsSync(file)) return undefined
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as RunState
		if (typeof parsed !== "object" || parsed === null) return undefined
		if (!Number.isSafeInteger(parsed.nextRound) || !Number.isSafeInteger(parsed.completedRounds)) return undefined
		return parsed
	} catch {
		return undefined
	}
}

function writeState(dir: string, state: RunState): void {
	atomicWrite(path.join(dir, STATE_FILE), `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`)
}

function readLastReport(dir: string): RoundReport | undefined {
	const file = path.join(dir, "rounds.jsonl")
	if (!fs.existsSync(file)) return undefined
	const lines = fs.readFileSync(file, "utf8").trim().split("\n")
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		try {
			const entry = JSON.parse(lines[index]) as RoundReport
			if (entry !== null && typeof entry === "object") return entry
		} catch {
			/* skip malformed line */
		}
	}
	return undefined
}

function isRoundIngested(dir: string, round: number): boolean {
	const file = path.join(dir, "rounds.jsonl")
	if (!fs.existsSync(file)) return false
	for (const line of fs.readFileSync(file, "utf8").trim().split("\n")) {
		try {
			const entry = JSON.parse(line) as { round?: number }
			if (entry.round === round) return true
		} catch {
			/* skip malformed line */
		}
	}
	return false
}

function ingestRound(dir: string, round: number, report: RoundReport): void {
	if (isRoundIngested(dir, round)) return
	fs.appendFileSync(path.join(dir, "rounds.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), round, ...report })}\n`, "utf8")
}

function padRound(round: number): string {
	return String(round).padStart(3, "0")
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string")
}

function readJsonObject(filePath: string, label: string): { value?: Record<string, unknown>; error?: string } {
	let parsed: unknown
	try {
		parsed = JSON.parse(fs.readFileSync(filePath, "utf8"))
	} catch (error) {
		return { error: `${label} file missing or unreadable: ${error instanceof Error ? error.message : String(error)}` }
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { error: `${label} is not an object` }
	return { value: parsed as Record<string, unknown> }
}

function validateDesignReport(record: Record<string, unknown>): { value?: RoundReport; error?: string } {
	if (!(DESIGN_MODES as readonly string[]).includes(record.mode as string)) {
		return { error: `report.mode is not one of ${DESIGN_MODES.join(", ")}` }
	}
	for (const field of ["question", "decision", "next"] as const) {
		if (typeof record[field] !== "string") return { error: `report.${field} must be a string` }
	}
	if (!isStringArray(record.evidence)) return { error: "report.evidence must be an array of strings" }
	return { value: record as unknown as DesignReport }
}

function validateBuildReport(record: Record<string, unknown>): { value?: RoundReport; error?: string } {
	if (!(BUILD_ACTIONS as readonly string[]).includes(record.action as string)) {
		return { error: `report.action is not one of ${BUILD_ACTIONS.join(", ")}` }
	}
	for (const field of ["summary", "next", "blocked"] as const) {
		if (typeof record[field] !== "string") return { error: `report.${field} must be a string` }
	}
	if (!isStringArray(record.evidence)) return { error: "report.evidence must be an array of strings" }
	return { value: record as unknown as BuildReport }
}

function validateDesignAudit(record: Record<string, unknown>): { value?: AuditReport; error?: string } {
	if (typeof record.material !== "boolean") return { error: "audit.material must be a boolean" }
	if (typeof record.finding !== "string") return { error: "audit.finding must be a string" }
	let consequence = ""
	if (typeof record.consequence === "string") consequence = record.consequence
	else if (record.material) return { error: "audit.consequence must be a string when material is true" }
	return { value: { material: record.material, finding: record.finding, consequence } }
}

function validateBuildAudit(record: Record<string, unknown>): { value?: AuditReport; error?: string } {
	if (typeof record.satisfied !== "boolean") return { error: "audit.satisfied must be a boolean" }
	if (!isStringArray(record.evidence)) return { error: "audit.evidence must be an array of strings" }
	if (!isStringArray(record.gaps)) return { error: "audit.gaps must be an array of strings" }
	return { value: { satisfied: record.satisfied, evidence: record.evidence, gaps: record.gaps } }
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

const DESIGN_PROFILE: Profile = {
	kind: "design",
	workerPrompt: `${DESIGN_WORKER_PERSONA}\n\n${DESIGN_PROTOCOL}\n`,
	auditorPrompt: `${DESIGN_AUDITOR_PERSONA}\n\n${DESIGN_AUDIT_PROTOCOL}\n`,
	ensureState(dir, args) {
		fs.mkdirSync(path.join(dir, "experiments"), { recursive: true })
		fs.mkdirSync(path.join(dir, "rounds"), { recursive: true })
		ensureFile(path.join(dir, "CONTRACT.md"), designContractText(args))
		ensureFile(path.join(dir, "ARCHITECTURE.md"), ARCHITECTURE_TEMPLATE)
		ensureFile(path.join(dir, "QUESTIONS.md"), QUESTIONS_TEMPLATE)
		ensureFile(path.join(dir, "LOG.md"), LOG_HEADER)
	},
	roundPrompt(problemAbs, projectRoot, problemRel, round, previous, reportAbs) {
		const prior = previous === undefined
			? "No previous round report exists: ARCHITECTURE.md may still have no candidate."
			: `Previous round report: ${JSON.stringify(previous)}`
		return `Problem directory: ${problemAbs}
Files: ${problemAbs}/CONTRACT.md, ${problemAbs}/QUESTIONS.md, ${problemAbs}/LOG.md, ${problemAbs}/ARCHITECTURE.md

Round ${round}. ${prior}

Prefix experiment files with the round number. Keep everything inside the problem directory.

Write your round report to: ${reportAbs}
Overwrite that file if it exists. Then, if the project is a git repository, commit only this directory:
git -C "${projectRoot}" add "${problemRel}" && git -C "${projectRoot}" commit -m "ralph design round ${round}"`
	},
	auditPrompt(problemAbs, reportAbs) {
		return `Problem directory: ${problemAbs}
Read only: ${problemAbs}/CONTRACT.md and ${problemAbs}/ARCHITECTURE.md

Write your audit report to: ${reportAbs}
Overwrite that file if it exists.`
	},
	readReport(filePath) {
		const parsed = readJsonObject(filePath, "report")
		if (parsed.error !== undefined) return { error: parsed.error }
		return validateDesignReport(parsed.value as Record<string, unknown>)
	},
	readAudit(filePath) {
		const parsed = readJsonObject(filePath, "audit")
		if (parsed.error !== undefined) return { error: parsed.error }
		return validateDesignAudit(parsed.value as Record<string, unknown>)
	},
	describePlan(entries) {
		const counts: Record<DesignMode, number> = { continue: 0, simplify: 0, experiment: 0, rederive: 0 }
		for (const entry of entries as DesignReport[]) counts[entry.mode] += 1
		return `${counts.continue} continue · ${counts.simplify} simplify · ${counts.experiment} experiment · ${counts.rederive} rederive`
	},
	auditLines(audit) {
		const value = audit as DesignAudit
		const lines = [value.material ? `audit  MATERIAL GAP — ${value.finding}` : `audit  no material gap — ${value.finding}`]
		if (value.material) lines.push(`consequence  ${value.consequence}`)
		return lines
	},
	roundLine(entry) {
		const value = entry as DesignReport
		return `${value.mode} — ${value.question} → ${value.decision}`
	},
}

const BUILD_PROFILE: Profile = {
	kind: "build",
	workerPrompt: `${BUILD_WORKER_PERSONA}\n\n${BUILD_PROTOCOL}\n`,
	auditorPrompt: `${BUILD_VERIFIER_PERSONA}\n\n${BUILD_AUDIT_PROTOCOL}\n`,
	ensureState(dir, args) {
		fs.mkdirSync(path.join(dir, "work"), { recursive: true })
		fs.mkdirSync(path.join(dir, "rounds"), { recursive: true })
		ensureFile(path.join(dir, "GOAL.md"), buildGoalText(args))
		ensureFile(path.join(dir, "PLAN.md"), PLAN_TEMPLATE)
		ensureFile(path.join(dir, "NOTES.md"), NOTES_TEMPLATE)
		ensureFile(path.join(dir, "LOG.md"), LOG_HEADER)
	},
	roundPrompt(problemAbs, projectRoot, problemRel, round, previous, reportAbs) {
		const prior = previous === undefined
			? "No previous round report exists: this is the first round."
			: `Previous round report: ${JSON.stringify(previous)}`
		return `Problem directory: ${problemAbs}
Files: ${problemAbs}/GOAL.md, ${problemAbs}/PLAN.md, ${problemAbs}/NOTES.md, ${problemAbs}/LOG.md
Workspace: the project repository at ${projectRoot}

Round ${round}. ${prior}

Keep scratch files in ${problemAbs}/work/. Commit your work in the project repository; this directory is in the repository and should be committed with it.

Write your round report to: ${reportAbs}
Overwrite that file if it exists. Then commit:
git -C "${projectRoot}" add -A && git -C "${projectRoot}" commit -m "ralph build round ${round}"`
	},
	auditPrompt(problemAbs, reportAbs) {
		return `Goal file: ${problemAbs}/GOAL.md
Workspace: the project repository containing ${problemAbs}

Write your audit report to: ${reportAbs}
Overwrite that file if it exists.`
	},
	readReport(filePath) {
		const parsed = readJsonObject(filePath, "report")
		if (parsed.error !== undefined) return { error: parsed.error }
		return validateBuildReport(parsed.value as Record<string, unknown>)
	},
	readAudit(filePath) {
		const parsed = readJsonObject(filePath, "audit")
		if (parsed.error !== undefined) return { error: parsed.error }
		return validateBuildAudit(parsed.value as Record<string, unknown>)
	},
	describePlan(entries) {
		const counts: Record<BuildAction, number> = { implement: 0, fix: 0, test: 0, refactor: 0, investigate: 0, docs: 0 }
		for (const entry of entries as BuildReport[]) counts[entry.action] += 1
		return BUILD_ACTIONS.map((action) => `${counts[action]} ${action}`).join(" · ")
	},
	auditLines(audit) {
		const value = audit as BuildAudit
		if (value.satisfied) {
			const evidence = value.evidence.length === 0 ? "no evidence recorded" : clip(value.evidence.join("; "), 300)
			return [`audit  GOAL MET — ${evidence}`]
		}
		const gaps = value.gaps.length === 0 ? "no gaps listed" : clip(value.gaps.join("; "), 400)
		return [`audit  NOT MET — ${gaps}`]
	},
	roundLine(entry) {
		const value = entry as BuildReport
		return `${value.action} — ${value.summary}${value.blocked ? ` (blocked: ${value.blocked})` : ""}`
	},
}

const PROFILES: Record<Kind, Profile> = { design: DESIGN_PROFILE, build: BUILD_PROFILE }

// ---------------------------------------------------------------------------
// Child process
// ---------------------------------------------------------------------------

/** Invoke the running pi binary rather than assuming `pi` is on PATH. */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1]
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/")
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] }
	}
	const execName = path.basename(process.execPath).toLowerCase()
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName)
	if (!isGenericRuntime) return { command: process.execPath, args }
	return { command: "pi", args }
}

interface ChildResult {
	ok: boolean
	code: number
	stderr: string
	usage: Usage
	stopReason?: string
	errorMessage?: string
}

function runChild(options: {
	args: string[]
	prompt: string
	cwd: string
	signal?: AbortSignal
}): Promise<ChildResult> {
	return new Promise((resolve) => {
		const invocation = getPiInvocation([...options.args, options.prompt])
		const proc = spawn(invocation.command, invocation.args, {
			cwd: options.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		})
		const usage = emptyUsage()
		let stderr = ""
		let buffer = ""
		let stopReason: string | undefined
		let errorMessage: string | undefined
		let settled = false

		const finish = (code: number) => {
			if (settled) return
			settled = true
			resolve({
				ok: code === 0 && errorMessage === undefined,
				code,
				stderr,
				usage,
				stopReason,
				errorMessage,
			})
		}

		const processLine = (line: string) => {
			const trimmed = line.trim()
			if (trimmed.length === 0) return
			let event: any
			try {
				event = JSON.parse(trimmed)
			} catch {
				return
			}
			if (event?.type !== "message_end" || !event.message) return
			const message = event.message
			if (message.role !== "assistant") return
			usage.turns += 1
			if (message.usage) {
				usage.input += message.usage.input || 0
				usage.output += message.usage.output || 0
				usage.cacheRead += message.usage.cacheRead || 0
				usage.cacheWrite += message.usage.cacheWrite || 0
				usage.cost += message.usage.cost?.total || 0
			}
			if (message.stopReason) stopReason = message.stopReason
			if (message.errorMessage) errorMessage = message.errorMessage
		}

		proc.stdout.on("data", (data: Buffer) => {
			buffer += data.toString()
			const lines = buffer.split("\n")
			buffer = lines.pop() ?? ""
			for (const line of lines) processLine(line)
		})

		proc.stderr.on("data", (data: Buffer) => {
			if (stderr.length < MAX_CAPTURED_STDERR) stderr += data.toString()
		})

		proc.on("error", (error: Error) => {
			stderr += `\nspawn error: ${error.message}`
			finish(1)
		})

		proc.on("close", (code: number | null) => {
			if (buffer.trim()) processLine(buffer)
			finish(code ?? 1)
		})

		if (options.signal) {
			const kill = () => {
				proc.kill("SIGTERM")
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL")
				}, 5000)
			}
			if (options.signal.aborted) kill()
			else options.signal.addEventListener("abort", kill, { once: true })
		}
	})
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderCall(args: Record<string, unknown>, theme: Theme) {
	const kind = typeof args?.kind === "string" ? args.kind : "build"
	const goal = clip(args?.goal, 68)
	const rounds = typeof args?.rounds === "number" ? args.rounds : DEFAULT_ROUNDS
	return new Text(
		`${theme.fg("toolTitle", theme.bold("ralph"))} ${theme.fg("muted", kind)} ${theme.fg("accent", goal)} ${theme.fg("muted", `· ${rounds} rounds`)}`,
		0,
		0,
	)
}

function renderResult(
	result: { content: Array<{ type: string; text?: string }>; details?: RalphDetails },
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
) {
	const details = result.details
	if (options.isPartial || details?.status === undefined) {
		const progress = textOf(result.content)
		return new Text(theme.fg("muted", progress.length > 0 ? progress : "running…"), 0, 0)
	}

	const kind = details.kind ?? "build"
	const profile = PROFILES[kind]
	const auditNegative =
		details.audit !== undefined &&
		((details.audit as DesignAudit).material === true || (details.audit as BuildAudit).satisfied === false)
	const ok = details.status === "complete"
	const icon = details.status !== "complete" ? theme.fg("error", "✗") : auditNegative ? theme.fg("warning", "!") : theme.fg("success", "✓")
	const progress = details.completedRounds === undefined
		? `${details.done ?? 0}/${details.rounds ?? 0}`
		: `${details.done ?? 0}/${details.rounds ?? 0} this call · ${details.completedRounds} total`
	const lines: string[] = [
		`${icon} ${theme.fg("toolTitle", theme.bold("ralph"))} ${theme.fg("muted", kind)} ${theme.fg("muted", details.status)} ${theme.fg("accent", progress)} ${theme.fg("muted", "rounds")}`,
	]

	if (details.plan) lines.push(theme.fg("muted", `${kind === "design" ? "modes  " : "actions"}  ${details.plan}`))

	if (details.audit) {
		const auditLines = profile.auditLines(details.audit)
		const warning =
			(details.audit as DesignAudit).material === true || (details.audit as BuildAudit).satisfied === false
		lines.push(theme.fg(warning ? "warning" : "success", auditLines[0]))
		if (options.expanded) for (const line of auditLines.slice(1)) lines.push(theme.fg("muted", line))
	}

	if (details.failure) lines.push(theme.fg("error", `failure  ${clip(details.failure, options.expanded ? 4000 : 140)}`))

	if (options.expanded) {
		lines.push("")
		if (details.resumedFrom !== undefined) lines.push(theme.fg("muted", `resumed    from round ${details.resumedFrom}`))
		if (details.problemDir) {
			lines.push(theme.fg("muted", "state      ") + theme.fg("accent", `${details.problemDir}/{STATE.json,LOG.md}`))
		}
		if (details.nextRound !== undefined) {
			lines.push(
				theme.fg(
					"muted",
					`next       ${details.status === "complete" ? "starts" : "continues"} at round ${details.nextRound}`,
				),
			)
		}
		if (details.usage) {
			const usage = details.usage
			lines.push(
				theme.fg(
					"muted",
					`usage      ${usage.turns ?? 0} turns · ↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)} · $${(usage.cost ?? 0).toFixed(4)}`,
				),
			)
		}
	}

	return new Text(lines.join("\n"), 0, 0)
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function ralphExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ralph",
		label: "Ralph",
		promptSnippet:
			"Run a resumable fresh-context loop: kind=build does verified work in the repo; kind=design searches for a target architecture. State is versioned in the project repo.",
		promptGuidelines: [
			"Use ralph kind=build for implementation work that benefits from fresh context per round and a final independent verification against the goal.",
			"Use ralph kind=design for architecture, code-structuring and refactor-target questions where the goal is a design, not code.",
			"ralph is long-running and blocks the turn. It writes docs/ralph/<name>/ into the project repository and commits it; resuming with the same name and goal continues an interrupted run.",
			"Do not use ralph for small one-shot edits, busywork, or questions answerable by reading the code once.",
		],
		executionMode: "sequential",
		description:
			"Run a resumable fresh-context loop over a repository. kind='build' does real work one verified unit per round (implement, test, fix, refactor) and ends with an independent verification of the goal. kind='design' searches for the simplest target architecture, one investigation per round, ending with an implementability audit. State lives in docs/ralph/<name>/ inside the project repository and is committed with the code; STATE.json is updated after every round, so an interrupted call continues from the next round when called again with the same name and goal. Long-running: it blocks the turn until the call budget and audit finish.",
		parameters: Type.Object({
			goal: Type.String({
				description:
					"The objective. For build: what must be true when done, with acceptance criteria in the text when known. For design: the problem, required behavior, constraints and non-goals.",
			}),
			kind: Type.Optional(
				Type.Union([Type.Literal("design"), Type.Literal("build")], {
					description: 'Protocol to run. Defaults to "build"; use "design" for target-architecture search.',
				}),
			),
			constraints: Type.Optional(
				Type.String({ description: "Hard constraints only: performance bounds, compatibility, language/runtime, invariants." }),
			),
			paths: Type.Optional(Type.Array(Type.String(), { description: "Existing files or directories the work or design must account for." })),
			rounds: Type.Optional(
				Type.Number({ description: `Rounds to run in this call. Default ${DEFAULT_ROUNDS}, maximum ${MAX_ROUNDS}; later calls add more.` }),
			),
			name: Type.Optional(
				Type.String({ description: "Problem directory name. Defaults to a slug of the goal. Reusing a name resumes that run." }),
			),
			project: Type.Optional(
				Type.String({
					description:
						"Project repository root that owns docs/ralph/. Relative paths resolve against the workspace. Defaults to the git root containing the workspace, or the workspace itself.",
				}),
			),
		}),

		renderCall,
		renderResult,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const args = readArgs(params as Record<string, unknown>, MAX_ROUNDS, DEFAULT_ROUNDS)
			const profile = PROFILES[args.kind]
			const workspace = ctx.cwd
			const projectRoot = resolveProjectRoot(args.project, workspace)
			const problemRel = `docs/ralph/${args.slug}`
			const problemAbs = path.join(projectRoot, "docs", "ralph", args.slug)

			const existing = readState(problemAbs)
			if (existing !== undefined && typeof existing.goal === "string" && existing.goal.trim() !== args.goal) {
				throw new Error(`ralph: "${args.slug}" already exists in ${problemRel} with a different goal. Use a different name, or delete that directory to start over.`)
			}
			if (existing !== undefined && typeof existing.kind === "string" && existing.kind !== args.kind) {
				throw new Error(`ralph: "${args.slug}" already exists as kind "${existing.kind}". Use a different name, or delete ${problemRel}/ to switch kind.`)
			}
			profile.ensureState(problemAbs, args)

			const resumed = existing !== undefined
			let state: RunState = existing ?? {
				version: 1,
				kind: args.kind,
				slug: args.slug,
				goal: args.goal,
				nextRound: 1,
				completedRounds: 0,
				status: "running",
				inProgress: null,
			}
			if (!Number.isSafeInteger(state.inProgress)) state.inProgress = null

			// Crash after the child wrote its report but before the state advanced:
			// ingest that report instead of paying for the round again.
			if (state.inProgress !== null) {
				const pending = profile.readReport(path.join(problemAbs, "rounds", `r${padRound(state.inProgress)}.json`))
				if (pending.value !== undefined) {
					ingestRound(problemAbs, state.inProgress, pending.value)
					state = {
						...state,
						completedRounds: Math.max(state.completedRounds, state.inProgress),
						inProgress: null,
						nextRound: state.inProgress + 1,
					}
					writeState(problemAbs, state)
				}
			}

			let round = state.inProgress ?? state.nextRound
			const resumedFrom = resumed ? round : undefined
			const startedAt = new Date().toISOString()
			const trajectory: RoundReport[] = []
			let status = "complete"
			let failure: string | undefined
			let audit: AuditReport | undefined
			const totalUsage = emptyUsage()

			state = { ...state, status: "running", kind: args.kind }
			writeState(problemAbs, state)

			const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ralph-"))
			const workerPromptPath = path.join(scratch, "worker.md")
			const auditPromptPath = path.join(scratch, "audit.md")
			fs.writeFileSync(workerPromptPath, profile.workerPrompt, "utf8")
			fs.writeFileSync(auditPromptPath, profile.auditorPrompt, "utf8")

			const childArgs = (systemPromptPath: string): string[] => {
				const result = [
					"--mode", "json",
					"-p",
					"--no-session",
					"--no-extensions",
					"--no-skills",
					"--no-prompt-templates",
					"--tools", "read,write,edit,bash,grep,find,ls",
					"--append-system-prompt", systemPromptPath,
				]
				if (ctx.model) result.push("--model", `${ctx.model.provider}/${ctx.model.id}`)
				if (ctx.thinkingLevel) result.push("--thinking", ctx.thinkingLevel)
				return result
			}

			const addUsage = (child: ChildResult) => {
				totalUsage.input += child.usage.input
				totalUsage.output += child.usage.output
				totalUsage.cacheRead += child.usage.cacheRead
				totalUsage.cacheWrite += child.usage.cacheWrite
				totalUsage.cost += child.usage.cost
				totalUsage.turns += child.usage.turns
			}

			const recordRun = () => {
				try {
					fs.appendFileSync(
						path.join(problemAbs, "runs.jsonl"),
						`${JSON.stringify({
							at: startedAt,
							finishedAt: new Date().toISOString(),
							kind: args.kind,
							goal: args.goal,
							projectRoot,
							rounds: args.rounds,
							done: trajectory.length,
							firstRound: resumedFrom ?? 1,
							completedRounds: state.completedRounds,
							nextRound: state.nextRound,
							status,
							failure,
						})}\n`,
						"utf8",
					)
				} catch {
					/* state reporting is best-effort */
				}
			}

			try {
				while (trajectory.length < args.rounds) {
					if (signal?.aborted) {
						status = "cancelled"
						failure = "cancelled by the caller"
						break
					}
					const reportAbs = path.join(problemAbs, "rounds", `r${padRound(round)}.json`)
					fs.rmSync(reportAbs, { force: true })
					state = { ...state, status: "running", inProgress: round, nextRound: round }
					writeState(problemAbs, state)

					onUpdate?.({
						content: [{ type: "text", text: `ralph ${args.kind} ${args.slug}: round ${round} running…` }],
						details: { kind: args.kind, phase: "round", round, rounds: args.rounds },
					})

					const child = await runChild({
						args: childArgs(workerPromptPath),
						prompt: profile.roundPrompt(problemAbs, projectRoot, problemRel, round, readLastReport(problemAbs), reportAbs),
						cwd: projectRoot,
						signal,
					})
					addUsage(child)

					if (!child.ok) {
						status = "round-failed"
						const detail = child.errorMessage ?? child.stderr.trim().split("\n").slice(-3).join(" | ")
						failure = `round ${round}: child exited ${child.code}${detail ? ` — ${clip(detail, 400)}` : ""}`
						writeState(problemAbs, { ...state, status })
						break
					}

					const report = profile.readReport(reportAbs)
					if (report.error !== undefined) {
						status = "round-failed"
						failure = `round ${round}: ${report.error}`
						writeState(problemAbs, { ...state, status })
						break
					}

					ingestRound(problemAbs, round, report.value as RoundReport)
					state = { ...state, completedRounds: round, inProgress: null, nextRound: round + 1 }
					writeState(problemAbs, state)
					trajectory.push(report.value as RoundReport)

					onUpdate?.({
						content: [
							{
								type: "text",
								text: `ralph ${args.kind} ${args.slug}: ${round} done — ${profile.roundLine(report.value as RoundReport)}`,
							},
						],
						details: { kind: args.kind, phase: "round", round, rounds: args.rounds },
					})
					round += 1
				}

				if (status === "complete" && !signal?.aborted) {
					const auditAbs = path.join(problemAbs, "rounds", "audit.json")
					fs.rmSync(auditAbs, { force: true })
					onUpdate?.({
						content: [{ type: "text", text: `ralph ${args.kind} ${args.slug}: independent audit…` }],
						details: { kind: args.kind, phase: "audit" },
					})
					const child = await runChild({
						args: childArgs(auditPromptPath),
						prompt: profile.auditPrompt(problemAbs, auditAbs),
						cwd: projectRoot,
						signal,
					})
					addUsage(child)

					if (!child.ok) {
						status = "audit-failed"
						const detail = child.errorMessage ?? child.stderr.trim().split("\n").slice(-3).join(" | ")
						failure = `audit: child exited ${child.code}${detail ? ` — ${clip(detail, 400)}` : ""}`
					} else {
						const parsed = profile.readAudit(auditAbs)
						if (parsed.error !== undefined) {
							status = "audit-failed"
							failure = parsed.error
						} else {
							audit = parsed.value
							try {
								fs.writeFileSync(path.join(problemAbs, "AUDIT.json"), `${JSON.stringify({ at: new Date().toISOString(), kind: args.kind, ...audit }, null, 2)}\n`, "utf8")
							} catch {
								/* state reporting is best-effort */
							}
						}
					}
				}
			} catch (error) {
				status = "error"
				failure = error instanceof Error ? error.message : String(error)
			} finally {
				fs.rmSync(scratch, { recursive: true, force: true })
			}

			state = { ...state, status }
			writeState(problemAbs, state)
			recordRun()

			const plan = profile.describePlan(trajectory)
			const last = trajectory.length > 0 ? trajectory[trajectory.length - 1] : undefined
			const auditLines = audit !== undefined ? profile.auditLines(audit) : []
			const text = [
				`ralph ${args.kind} ${status} — ${problemRel} — ${trajectory.length}/${args.rounds} rounds this call · ${state.completedRounds} total`,
				resumedFrom !== undefined ? `resumed from round ${resumedFrom}` : undefined,
				`${args.kind === "design" ? "modes" : "actions"}: ${plan}`,
				last !== undefined ? `last: ${clip(profile.roundLine(last), 400)}` : undefined,
				...auditLines,
				failure !== undefined ? `failure: ${failure}` : undefined,
				status === "complete"
					? `next call starts at round ${state.nextRound}`
					: `next call continues at round ${state.nextRound}`,
				`state: ${problemRel}/{STATE.json,LOG.md}`,
			]
				.filter((line): line is string => line !== undefined)
				.join("\n")

			return {
				content: [{ type: "text", text }],
				details: {
					kind: args.kind,
					status,
					problemDir: problemRel,
					rounds: args.rounds,
					done: trajectory.length,
					completedRounds: state.completedRounds,
					nextRound: state.nextRound,
					resumedFrom,
					plan,
					audit,
					failure,
					usage: totalUsage,
				},
			}
		},
	})
}
