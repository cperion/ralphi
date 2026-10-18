/**
 * arch_loop for pi — fresh-context architecture design search as one tool.
 *
 * One call scaffolds `.ralphi/<slug>/`, runs N design rounds each in a fresh
 * `pi` child process, then one independent audit. The problem directory is the
 * only memory between rounds: no conversation is carried over.
 *
 * Port of the DSH `arch_loop` plugin. The report protocol is file-based
 * (`rounds/rNNN.json`, `rounds/audit.json`) so the parent never has to parse
 * assistant prose.
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

const REPORT_FIELDS = ["mode", "question", "evidence", "decision", "next"] as const
const MODES = ["continue", "simplify", "experiment", "rederive"] as const

type Mode = (typeof MODES)[number]

interface RoundReport {
	mode: Mode
	question: string
	evidence: string[]
	decision: string
	next: string
}

interface AuditReport {
	material: boolean
	finding: string
	consequence: string
}

interface Usage {
	input: number
	output: number
	cacheRead: number
	cacheWrite: number
	cost: number
	turns: number
}

/** Details shape carried to the TUI renderer. */
interface ArchLoopDetails {
	phase?: "round" | "audit"
	round?: number
	rounds?: number
	mode?: string
	status?: string
	problemDir?: string
	done?: number
	modes?: Record<string, number>
	audit?: AuditReport
	failure?: string
	usage?: Usage
}

const WORKER_PERSONA = `You are an architecture designer and adversarial simplifier. You search for the smallest set of concepts, states, invariants and representations that satisfies the contract. You do not write production code; a prototype, test or benchmark exists only to answer a question. You treat the current design, including your own previous rounds, as a hypothesis, not as a baseline to defend.`

const AUDITOR_PERSONA = `You are an independent design auditor. You have not seen the search process. You judge only the contract and the written architecture, and you look for the first place an implementer would have to invent semantics the design did not specify.`

const WORKER_PROTOCOL = `You are one iteration of an architecture-design loop. You have no memory of previous rounds beyond the files in the problem directory.

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

const AUDIT_PROTOCOL = `Independent audit. You have not seen this search. Read only CONTRACT.md and ARCHITECTURE.md in the problem directory.

Attempt to implement the essential required behavior from those documents alone. Every time you must invent a semantic decision the design did not specify, note it. Then judge whether one material gap remains: an omission that changes correctness, a representation that forces accidental complexity, or a simpler formulation the design missed.

material=false only if you could implement the contract without inventing anything material and found no simpler representation. finding: the single most consequential gap, or "none". consequence: what breaks, or what an implementer must guess, if it is not fixed.

Your final action must be writing the audit JSON file named in the user message, with exactly these fields and nothing else:
{"material": true|false, "finding": "string", "consequence": "string"}`

const CONTRACT_RULES = `## Rules for this search
- Required behavior, observed legacy behavior, confirmed constraints, assumptions and preferences are distinct. Do not promote one into another.
- Missing requirements are open questions, never inventions.
- Definition of done: every stated requirement is accounted for, no unresolved material question remains, and an implementer can build the design without inventing semantics.`

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

interface ArchLoopArgs {
	goal: string
	constraints?: string
	paths: string[]
	rounds: number
	slug: string
}

interface ChildResult {
	ok: boolean
	code: number
	stderr: string
	usage: Usage
	stopReason?: string
	errorMessage?: string
}

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

function renderCall(args: Record<string, unknown>, theme: Theme) {
	const goal = clip(args?.goal, 72)
	const rounds = typeof args?.rounds === "number" ? args.rounds : DEFAULT_ROUNDS
	return new Text(
		`${theme.fg("toolTitle", theme.bold("arch_loop"))} ${theme.fg("accent", goal)} ${theme.fg("muted", `· ${rounds} rounds`)}`,
		0,
		0,
	)
}

function renderResult(
	result: { content: Array<{ type: string; text?: string }>; details?: ArchLoopDetails },
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
) {
	const details = result.details
	if (options.isPartial || details?.status === undefined) {
		const progress = textOf(result.content)
		return new Text(theme.fg("muted", progress.length > 0 ? progress : "running…"), 0, 0)
	}

	const ok = details.status === "complete"
	const icon = ok ? theme.fg("success", "✓") : theme.fg("error", "✗")
	const lines: string[] = [
		`${icon} ${theme.fg("toolTitle", theme.bold("arch_loop"))} ${theme.fg("muted", details.status)} ${theme.fg("accent", `${details.done ?? 0}/${details.rounds ?? 0}`)} ${theme.fg("muted", "rounds")}`,
	]

	if (details.modes) {
		const modes = details.modes
		lines.push(
			theme.fg(
				"muted",
				`modes  ${modes.continue ?? 0} continue · ${modes.simplify ?? 0} simplify · ${modes.experiment ?? 0} experiment · ${modes.rederive ?? 0} rederive`,
			),
		)
	}

	if (details.audit) {
		if (details.audit.material) {
			lines.push(
				theme.fg("warning", "audit  MATERIAL GAP — ") +
					theme.fg("text", clip(details.audit.finding, options.expanded ? 4000 : 110)),
			)
			if (options.expanded) lines.push(theme.fg("muted", `consequence  ${details.audit.consequence}`))
		} else {
			lines.push(theme.fg("success", "audit  no material gap"))
		}
	}

	if (details.failure) {
		lines.push(theme.fg("error", `failure  ${clip(details.failure, options.expanded ? 4000 : 140)}`))
	}

	if (options.expanded) {
		lines.push("")
		if (details.problemDir) {
			lines.push(
				theme.fg("muted", "state      ") +
					theme.fg("accent", `${details.problemDir}/{ARCHITECTURE.md,QUESTIONS.md,LOG.md}`),
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

function readArgs(raw: Record<string, unknown>, maxRounds: number, defaultRounds: number): ArchLoopArgs {
	const goal = typeof raw.goal === "string" ? raw.goal.trim() : ""
	if (goal.length === 0) throw new Error("arch_loop: goal must be a non-empty string")
	const constraints = typeof raw.constraints === "string" && raw.constraints.trim().length > 0 ? raw.constraints.trim() : undefined
	if (raw.paths !== undefined && !Array.isArray(raw.paths)) throw new Error("arch_loop: paths must be an array of strings")
	const paths = (raw.paths as unknown[] | undefined ?? []).filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
	const rounds = raw.rounds === undefined ? defaultRounds : raw.rounds
	if (typeof rounds !== "number" || !Number.isSafeInteger(rounds) || rounds < 1 || rounds > maxRounds) {
		throw new Error(`arch_loop: rounds must be an integer between 1 and ${maxRounds}`)
	}
	const name = typeof raw.name === "string" && raw.name.trim().length > 0 ? raw.name.trim() : goal
	return { goal, constraints, paths, rounds, slug: slugify(name) }
}

function contractText(args: ArchLoopArgs): string {
	const pathList = args.paths.length === 0 ? "None specified." : args.paths.map((p) => `- \`${p}\``).join("\n")
	const constraintText = args.constraints === undefined
		? "None stated. Treat any missing requirement as an open question in QUESTIONS.md; do not invent behavior."
		: args.constraints
	return `# Contract

## Problem
${args.goal}

## Constraints
${constraintText}

## Existing code
${pathList}

${CONTRACT_RULES}
`
}

function ensureFile(filePath: string, text: string): void {
	if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, text, "utf8")
}

function ensureState(dir: string, args: ArchLoopArgs): void {
	fs.mkdirSync(path.join(dir, "experiments"), { recursive: true })
	fs.mkdirSync(path.join(dir, "rounds"), { recursive: true })
	ensureFile(path.join(dir, "CONTRACT.md"), contractText(args))
	ensureFile(path.join(dir, "ARCHITECTURE.md"), ARCHITECTURE_TEMPLATE)
	ensureFile(path.join(dir, "QUESTIONS.md"), QUESTIONS_TEMPLATE)
	ensureFile(path.join(dir, "LOG.md"), LOG_HEADER)
}

function padRound(round: number): string {
	return String(round).padStart(3, "0")
}

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

function readRoundReport(filePath: string): { value?: RoundReport; error?: string } {
	let parsed: unknown
	try {
		parsed = JSON.parse(fs.readFileSync(filePath, "utf8"))
	} catch (error) {
		return { error: `report file missing or unreadable: ${error instanceof Error ? error.message : String(error)}` }
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { error: "report is not an object" }
	const record = parsed as Record<string, unknown>
	for (const field of REPORT_FIELDS) if (!(field in record)) return { error: `report is missing field "${field}"` }
	if (!MODES.includes(record.mode as Mode)) return { error: `report.mode is not one of ${MODES.join(", ")}` }
	for (const field of ["question", "decision", "next"] as const) {
		if (typeof record[field] !== "string") return { error: `report.${field} must be a string` }
	}
	if (!Array.isArray(record.evidence) || record.evidence.some((entry) => typeof entry !== "string")) {
		return { error: "report.evidence must be an array of strings" }
	}
	return { value: record as unknown as RoundReport }
}

function readAuditReport(filePath: string): { value?: AuditReport; error?: string } {
	let parsed: unknown
	try {
		parsed = JSON.parse(fs.readFileSync(filePath, "utf8"))
	} catch (error) {
		return { error: `audit file missing or unreadable: ${error instanceof Error ? error.message : String(error)}` }
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { error: "audit is not an object" }
	const record = parsed as Record<string, unknown>
	if (typeof record.material !== "boolean") return { error: "audit.material must be a boolean" }
	if (typeof record.finding !== "string") return { error: "audit.finding must be a string" }
	if (typeof record.consequence !== "string") return { error: "audit.consequence must be a string" }
	return { value: record as unknown as AuditReport }
}

function roundPrompt(problemDir: string, round: number, total: number, previous: RoundReport | undefined, reportPath: string): string {
	const prior = previous === undefined
		? "This is the first round: ARCHITECTURE.md has no candidate yet."
		: `Previous round report: ${JSON.stringify(previous)}`
	return `Problem directory (relative to the workspace root): ${problemDir}/
Files: ${problemDir}/CONTRACT.md, ${problemDir}/QUESTIONS.md, ${problemDir}/LOG.md, ${problemDir}/ARCHITECTURE.md

Round ${round} of ${total}. ${prior}

Prefix experiment files with the round number.

Write your round report to: ${reportPath}
Overwrite that file if it exists. Then, if the workspace is a git repository, commit exactly your problem directory:
git add ${problemDir} && git commit -m "arch_loop round ${round}"`
}

function auditPrompt(problemDir: string, reportPath: string): string {
	return `Problem directory (relative to the workspace root): ${problemDir}/
Read only: ${problemDir}/CONTRACT.md and ${problemDir}/ARCHITECTURE.md

Write your audit report to: ${reportPath}
Overwrite that file if it exists.`
}

function renderSummary(value: {
	status: string
	problemDir: string
	rounds: number
	done: number
	modes: string
	lastQuestion?: string
	lastDecision?: string
	audit?: AuditReport
	failure?: string
}): string {
	const lines: string[] = []
	lines.push(`arch_loop ${value.status} — ${value.problemDir} — ${value.done}/${value.rounds} rounds`)
	lines.push(`modes: ${value.modes}`)
	if (value.lastQuestion !== undefined) lines.push(`last question: ${value.lastQuestion}`)
	if (value.lastDecision !== undefined) lines.push(`last decision: ${value.lastDecision}`)
	if (value.audit !== undefined) {
		lines.push(value.audit.material
			? `audit: MATERIAL GAP — ${value.audit.finding}`
			: `audit: no material gap — ${value.audit.finding}`)
		if (value.audit.material) lines.push(`consequence: ${value.audit.consequence}`)
	}
	if (value.failure !== undefined) lines.push(`failure: ${value.failure}`)
	lines.push(`state: ${value.problemDir}/{ARCHITECTURE.md,QUESTIONS.md,LOG.md}`)
	return lines.join("\n")
}

export default function archLoopExtension(pi: ExtensionAPI) {
	const maxRounds = MAX_ROUNDS
	const defaultRounds = DEFAULT_ROUNDS

	pi.registerTool({
		name: "arch_loop",
		label: "Architecture Loop",
		promptSnippet:
			"Run a fresh-context architecture design search: repeated design/experiment rounds, then an independent audit of the result",
		promptGuidelines: [
			"Use arch_loop for architecture, code-structuring, refactor-target and design questions where exploring alternatives and verifying the target matters more than writing production code.",
			"arch_loop is long-running and blocks the turn. Prefer it when the user wants a considered design target rather than an immediate answer.",
			"Do not use arch_loop for small edits, bug fixes, or questions answerable by reading the code once.",
		],
		executionMode: "sequential",
		description:
			"Run a fresh-context architecture-design search on a problem. Creates or resumes .ralphi/<name>/ in the workspace, runs one substantial design iteration per round in a fresh pi child process, then one independent audit. Use for architecture, code-structuring, refactor-target and design questions. Long-running: it blocks the turn until all rounds and the audit finish; cancellation preserves every completed round.",
		parameters: Type.Object({
			goal: Type.String({
				description:
					"The problem to design for. Include required behavior, constraints, and non-goals when known; anything missing becomes an open question instead of an invented requirement.",
			}),
			constraints: Type.Optional(
				Type.String({ description: "Hard constraints only: performance bounds, compatibility, language/runtime, invariants." }),
			),
			paths: Type.Optional(Type.Array(Type.String(), { description: "Existing files or directories the design must account for (refactors)." })),
			rounds: Type.Optional(Type.Number({ description: `Number of design rounds. Default ${DEFAULT_ROUNDS}, maximum ${MAX_ROUNDS}.` })),
			name: Type.Optional(
				Type.String({ description: "Problem directory name. Defaults to a slug of the goal. Reusing a name resumes that problem." }),
			),
		}),

		renderCall,
		renderResult,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const args = readArgs(params as Record<string, unknown>, maxRounds, defaultRounds)
			const workspace = ctx.cwd
			const dir = path.join(workspace, ".ralphi", args.slug)
			const problemDir = `.ralphi/${args.slug}`
			ensureState(dir, args)

			const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-arch-loop-"))
			const workerPromptPath = path.join(scratch, "worker.md")
			const auditPromptPath = path.join(scratch, "audit.md")
			fs.writeFileSync(workerPromptPath, `${WORKER_PERSONA}\n\n${WORKER_PROTOCOL}\n`, "utf8")
			fs.writeFileSync(auditPromptPath, `${AUDITOR_PERSONA}\n\n${AUDIT_PROTOCOL}\n`, "utf8")

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

			const startedAt = new Date().toISOString()
			const trajectory: RoundReport[] = []
			let status = "complete"
			let failure: string | undefined
			let audit: AuditReport | undefined
			const totalUsage = emptyUsage()

			const recordRun = () => {
				try {
					fs.appendFileSync(
						path.join(dir, "runs.jsonl"),
						`${JSON.stringify({
							at: startedAt,
							finishedAt: new Date().toISOString(),
							goal: args.goal,
							rounds: args.rounds,
							done: trajectory.length,
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
				let previous: RoundReport | undefined
				for (let round = 1; round <= args.rounds; round += 1) {
					if (signal?.aborted) {
						status = "cancelled"
						failure = "cancelled by the caller"
						break
					}
					const reportRel = `${problemDir}/rounds/r${padRound(round)}.json`
					const reportAbs = path.join(dir, "rounds", `r${padRound(round)}.json`)
					fs.rmSync(reportAbs, { force: true })

					onUpdate?.({
						content: [{ type: "text", text: `arch_loop ${args.slug}: round ${round}/${args.rounds} running…` }],
						details: { phase: "round", round, rounds: args.rounds },
					})

					const child = await runChild({
						args: childArgs(workerPromptPath),
						prompt: roundPrompt(problemDir, round, args.rounds, previous, reportRel),
						cwd: workspace,
						signal,
					})
					totalUsage.input += child.usage.input
					totalUsage.output += child.usage.output
					totalUsage.cacheRead += child.usage.cacheRead
					totalUsage.cacheWrite += child.usage.cacheWrite
					totalUsage.cost += child.usage.cost
					totalUsage.turns += child.usage.turns

					if (!child.ok) {
						status = "round-failed"
						const detail = child.errorMessage ?? child.stderr.trim().split("\n").slice(-3).join(" | ")
						failure = `round ${round}: child exited ${child.code}${detail ? ` — ${clip(detail, 400)}` : ""}`
						break
					}

					const report = readRoundReport(reportAbs)
					if (report.error !== undefined) {
						status = "round-failed"
						failure = `round ${round}: ${report.error}`
						break
					}
					previous = report.value
					trajectory.push(report.value as RoundReport)
					try {
						fs.appendFileSync(
							path.join(dir, "rounds.jsonl"),
							`${JSON.stringify({
								at: new Date().toISOString(),
								round,
								...report.value,
							})}\n`,
							"utf8",
						)
					} catch {
						/* state reporting is best-effort */
					}
					onUpdate?.({
						content: [
							{
								type: "text",
								text: `arch_loop ${args.slug}: ${round}/${args.rounds} done — ${report.value?.mode}: ${clip(report.value?.question, 120)}`,
							},
						],
						details: { phase: "round", round, rounds: args.rounds, mode: report.value?.mode },
					})
				}

				if (status === "complete" && !signal?.aborted) {
					const auditRel = `${problemDir}/rounds/audit.json`
					const auditAbs = path.join(dir, "rounds", "audit.json")
					fs.rmSync(auditAbs, { force: true })
					onUpdate?.({
						content: [{ type: "text", text: `arch_loop ${args.slug}: independent audit…` }],
						details: { phase: "audit" },
					})
					const child = await runChild({
						args: childArgs(auditPromptPath),
						prompt: auditPrompt(problemDir, auditRel),
						cwd: workspace,
						signal,
					})
					totalUsage.input += child.usage.input
					totalUsage.output += child.usage.output
					totalUsage.cacheRead += child.usage.cacheRead
					totalUsage.cacheWrite += child.usage.cacheWrite
					totalUsage.cost += child.usage.cost
					totalUsage.turns += child.usage.turns

					if (!child.ok) {
						status = "audit-failed"
						const detail = child.errorMessage ?? child.stderr.trim().split("\n").slice(-3).join(" | ")
						failure = `audit: child exited ${child.code}${detail ? ` — ${clip(detail, 400)}` : ""}`
					} else {
						const parsed = readAuditReport(auditAbs)
						if (parsed.error !== undefined) {
							status = "audit-failed"
							failure = parsed.error
						} else {
							audit = parsed.value
							try {
								fs.writeFileSync(path.join(dir, "AUDIT.json"), `${JSON.stringify({ at: new Date().toISOString(), ...audit }, null, 2)}\n`, "utf8")
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
				recordRun()
			}

			const counts: Record<Mode, number> = { continue: 0, simplify: 0, experiment: 0, rederive: 0 }
			for (const entry of trajectory) counts[entry.mode] += 1
			const modes = `${counts.continue} continue · ${counts.simplify} simplify · ${counts.experiment} experiment · ${counts.rederive} rederive`
			const last = trajectory.length > 0 ? trajectory[trajectory.length - 1] : undefined
			const text = renderSummary({
				status,
				problemDir,
				rounds: args.rounds,
				done: trajectory.length,
				modes,
				lastQuestion: last === undefined ? undefined : clip(last.question, 300),
				lastDecision: last === undefined ? undefined : clip(last.decision, 400),
				audit,
				failure,
			})

			return {
				content: [{ type: "text", text }],
				details: {
					status,
					problemDir,
					rounds: args.rounds,
					done: trajectory.length,
					modes: counts,
					audit,
					failure,
					usage: totalUsage,
				},
			}
		},
	})
}
