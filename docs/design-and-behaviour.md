# arch_loop — design and observed behaviour

Status: report from the build session. Covers both harness ports and one live
design run. Where evidence is missing, it says so.

## 1. Scope and evidence

| Evidence | What it establishes |
|---|---|
| DSH mock harness (2 rounds + audit, resume, cancellation, bad args) | Control flow, state handling, validation, cancellation. No model involved. |
| DSH fresh boot (host row + `Coder & Organizer` preset row) | Both registrations import and `apply()`, no activation warnings. |
| DSH live process | Required one restart after install; not yet exercised with a real design round. |
| Pi live run (1 round + audit) | End-to-end behaviour: fresh child, file report, architecture update, independent audit. |
| Pi artifact inspection | Report schema compliance, state layout, audit output. |

The live Pi workspace was removed after inspection. All Pi evidence below is from
the run transcript and the files read immediately after the run.

## 2. Design

### 2.1 Loop model

One tool call is the controller. It owns the round count and launches children;
it does not judge the design.

```
call
 ├─ scaffold .ralphi/<slug>/ (CONTRACT, ARCHITECTURE, QUESTIONS, LOG, experiments/)
 ├─ for round 1..N:
 │    remove rounds/rNNN.json
 │    spawn fresh child (no previous conversation)
 │    child reads 4 files, does one investigation, writes rounds/rNNN.json
 │    validate report; append rounds.jsonl
 └─ spawn one fresh auditor (only CONTRACT.md + ARCHITECTURE.md)
      → rounds/audit.json → AUDIT.json
```

The only memory between rounds is the directory. The previous round's report is
passed as a short handoff, not as conversation.

### 2.2 State protocol

| File | Owner | Purpose |
|---|---|---|
| `CONTRACT.md` | human (generated once from `goal`/`constraints`/`paths`) | frozen problem statement |
| `ARCHITECTURE.md` | worker | best-known design; changes need evidence |
| `QUESTIONS.md` | worker | material open questions |
| `LOG.md` | worker | append-only round record |
| `experiments/` | worker | prototypes, benchmarks, re-derivations |
| `rounds/rNNN.json` | worker | routing report, validated by the controller |
| `rounds/audit.json` | auditor | audit report |
| `rounds.jsonl`, `runs.jsonl`, `AUDIT.json` | controller | durable machine record |

Report contract: `mode` ∈ {continue, simplify, experiment, rederive},
`question`, `evidence[]`, `decision`, `next`. No prose parsing; the controller
deletes the expected file before the round and fails the round if it is missing
or malformed.

### 2.3 Harness adapters

| | DSH | pi |
|---|---|---|
| Registration | Cordis plugin + bundle patch; host row + coder-preset row | Pi package (`pi.extensions`) |
| Child | in-process fresh subagent (`ctx.subagents.start`, `spawn` provider) | separate `pi` process per round |
| Child tools | inherited preset, filtered: `arch_loop` denied | built-ins only: `read,write,edit,bash,grep,find,ls` |
| Child instructions | `persona` + prompt text | `--append-system-prompt <tmp worker.md>` |
| Report transport | `outputSchema` → structured result | file `rounds/rNNN.json` |
| Isolation | fresh session, same process, project cwd | `--mode json -p --no-session --no-extensions --no-skills --no-prompt-templates` |
| Model | inherits parent route | `--model`/`--thinking` inherited from parent |

The Pi child is deliberately stripped: no extensions means no recursion into
`arch_loop`, no unrelated tools, no skill/prompt discovery. The DSH child is
denied `arch_loop` by tool filter, and delegation depth bounds further spawning.

### 2.4 Control policy

- **The model chooses the mode each round.** The controller only passes the
  previous report and the round number.
- **Question discovery before action.** Three candidate questions, ranked by
  materiality, then one investigation. This is the anti-underdesign mechanism.
- **Redefine blindness is procedural.** A `rederive` round is told to read only
  `CONTRACT.md`, write its independent design first, then reconcile. The tool
  cannot enforce that the worker did not peek.
- **No early convergence.** The loop always spends its round budget; the human
  stops it. Worker self-reports are not treated as proof.
- **One independent audit, at the end.** It reads only the contract and the
  architecture, attempts an implementation, and reports the first place it must
  invent unspecified semantics.

### 2.5 Guardrails

- Report file is deleted before each round, so a stale report cannot pass a
  failed round.
- Child non-zero exit, missing report, or schema violation fails that round with
  the round number; prior rounds remain recorded and committed.
- Cancellation aborts the current child, leaves completed rounds intact.
- Workers commit the problem directory when the workspace is a git repo, so
  `git log` is the review surface.

## 3. Observed behaviour

### 3.1 DSH activation

Two observations worth keeping:

1. The first installed version imported a harness package from a linked bundle
   and failed with `failed to import`. A linked profile bundle should stay on
   Node builtins; the fixed version has zero harness imports.
2. Once a live-host entry fails to import, it does not recover when the module is
   fixed. A fresh boot loaded the same bundle correctly; only a restart of the
   running host applied it. That is a loader generation boundary, not a plugin
   bug.

Preset integration was confirmed by two `apply()` executions in one fresh boot:
host row and coder-preset row. The coder agent gets the scoped registration; the
global row still serves other presets.

### 3.2 DSH control flow (mock)

With a mocked subagent runtime:

- 2 rounds + audit produced the expected summary and all state files.
- Resuming with the same `name` preserved `CONTRACT.md` and appended a new round.
- An aborted signal produced `cancelled` with zero rounds.
- Invalid arguments were rejected before any child start.

This validates orchestration only; no model behaviour was involved.

### 3.3 Pi live run

Command: the parent pi was asked to call `arch_loop` once with a one-sentence
goal ("fixed-capacity LRU cache, O(1) get/put, evict LRU") and `rounds=1`.

The call completed with the audit. Result summary:

```
arch_loop complete — 1/1 rounds
modes: 0 continue · 0 simplify · 1 experiment · 0 rederive
```

**Round behaviour.** The worker did not start by writing an architecture. It
converted the single-sentence goal into a representation question:

> Is the "hash index + recency order" duality forced, or can one of the two
> structures be deleted or melted into the other without losing exact LRU or the
> O(1) guarantee?

It then built a Python prototype and tested the claim rather than asserting it:

- differential test against a semantic oracle (full recency order after every
  operation): capacities 1–5 × 4 key-space densities × 40 seeds × 600 operations
- the clock-based variant diverged in 160/160 cases
- timing sweep, 200k operations, capacity 100–100,000: single-node implementation
  ~157→366 ns/op flat, O(n) oracle ~370→66,700 ns/op

Reported decision (condensed): the duality is forced, but the containers are
not; recency order cannot be removed, the index can be specialised, and both can
live on one entry type with a bucket array sized once from capacity, deleting
resize state and the cross-container handle invariant. It stated the guarantee as
expected O(1), not worst case, and rejected open addressing on state count
despite it passing.

It also reported making **six semantic decisions where the contract is silent**
and recording them in `QUESTIONS.md` — an accurate self-assessment of contract
under-specification.

**Audit behaviour.** The auditor saw only `CONTRACT.md` and `ARCHITECTURE.md`.
It found a material gap: the architecture declared exactly six `Entry` fields
while also asserting bucket back-pointers, and never specified whether bucket
heads are sentinels or nullable pointers, nor how `unlink_bucket` finds its slot.
It characterised the consequence precisely (a dangling index reference after
eviction, or an undeclared seventh field) and proposed the simpler formulation
the design missed: one sentinel entry per bucket, mirroring the head/tail
sentinels already justified.

That finding is more than a style objection: it is an implementability omission
inside the design's own stated invariant, and it lands on the same seam the
worker had already flagged as under-specified.

**Artifacts.** `ARCHITECTURE.md` updated, `LOG.md`/`QUESTIONS.md` written,
`experiments/r001-lru-prototype.py` and `experiments/r001-findings.md` created,
`rounds/r001.json` and `rounds/audit.json` valid and schema-compliant,
`rounds.jsonl` and `runs.jsonl` one line each.

## 4. Analysis

**What the design did well in this sample**

- The worker produced evidence, not prose: a prototype, a differential test, and
  a scaling measurement for a question it had to first discover.
- The report protocol held. The controller never needed to parse model text.
- The audit was genuinely independent: only the two documents, no search
  history, and it found a concrete omission rather than restating the design.
- Contract silence surfaced instead of disappearing: the worker named six
  decisions it had to make, and the audit attacked one of them.

**What one round cannot show**

- Whether iteration improves the design. Modes such as `simplify` and `rederive`
  were not exercised.
- Whether the audit's proposed sentinel formulation is correct. It is plausible
  and internally motivated, but unverified by a second critic or a prototype.
- Whether question discovery keeps finding material questions on later rounds.

**Design risks that remain**

- The single-sentence contract produced six invented decisions. A richer
  contract (constraints, invariants, non-goals) should reduce that; the current
  run confirms the README's warning rather than disproving it.
- `rederive` blindness is unenforced.
- One auditor is one opinion; there is no adversarial verification of the audit.
- No cost instrumentation is surfaced in the tool result. The Pi adapter sums
  usage in `details`, but the DSH adapter does not expose token totals.
- The DSH port has no live design round on record yet; its behaviour is inferred
  from control-flow tests and shared protocol.

## 5. Recommended next measurements

1. **Contract test, 10 rounds, real problem.** Watch whether rounds 4–10 still
   add material questions; if not, the contract or the prompt is the limit.
2. **Audit-driven follow-up.** Run a second call with the audit's finding as the
   first question ("prove or refute: per-bucket sentinels remove the
   back-pointer and the unlink-slot problem"). That tests whether the loop can
   close an audit gap rather than just detect one.
3. **DSH/Pi parity run.** Same goal, same round count, one harness each. Compare
   question quality and audit findings; this is the only way to see whether
   in-process vs child-process context changes behaviour.
4. **Instrument spend.** Surface per-call turns/tokens in the returned summary so
   a 24-round budget is a decision, not a guess.

## 6. Operational notes

- DSH: restart after plugin/preset changes; the live loader imports a module
  generation once.
- Pi: `/reload` after editing the extension; children are spawned per round, so
  a round costs a process start plus its model calls.
- Both harnesses use the same `.ralphi/<slug>/` layout, so a problem can be
  continued in either.
