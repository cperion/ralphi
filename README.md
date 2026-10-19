# ralphi

`ralph` — one resumable fresh-context loop for both harnesses. Two protocols
behind one argument:

| `kind` | Goal | Round | Final audit |
|---|---|---|---|
| `build` (default) | make a real change in a repo | one unit of work, verified and committed | independent verifier runs the project's checks against the goal |
| `design` | find the simplest target architecture | one design investigation | independent implementability audit |

One call creates (or resumes) `docs/ralph/<slug>/` inside the project repository,
runs N rounds with a fresh agent each round, then runs the audit. State is
committed with the code; `STATE.json` survives interruption.

No manual setup: no template copying, no files to create.

## Use

```
ralph({ goal: "Add cursor pagination to GET /items, tests included", rounds: 8 })
```

```
ralph({ kind: "design", goal: "Design the module structure and data types for X", rounds: 16 })
```

| Argument | Meaning |
|---|---|
| `goal` | Objective. For `build`: what must be true when done. For `design`: the problem, behavior, constraints, non-goals. |
| `kind` | `build` (default) or `design`. |
| `constraints` | Hard constraints only: bounds, compatibility, runtime, invariants. |
| `paths` | Existing files/directories the work or design must account for. |
| `rounds` | Rounds to run in this call. Default 24, ceiling 64; later calls add more. |
| `name` | Stable directory name. Reusing it resumes that run. |
| `project` | Repository root that owns `docs/ralph/`. Defaults to the git root containing the workspace, else the workspace. |

Long-running: the call blocks the turn. Cancelling preserves every completed
round; call again with the same `name` and `goal` to continue.

## What it creates

Inside the project repository, so the record is versioned with the code and
committed by the workers:

```
docs/ralph/<slug>/
  STATE.json        controller-owned resume marker (next / in-progress round)
  rounds.jsonl      per-round reports (controller-owned)
  runs.jsonl        one record per call (controller-owned)
  AUDIT.json        independent verification result
  rounds/           per-round report files (pi port)
  LOG.md            append-only per-round record
```

`kind=design` additionally:

```
  CONTRACT.md       goal + constraints + paths
  ARCHITECTURE.md   best-known design; changes need evidence
  QUESTIONS.md      material open questions
  experiments/      prototypes, benchmarks, re-derivations
```

`kind=build` additionally:

```
  GOAL.md           objective + constraints + paths
  PLAN.md           current approach, done / next
  NOTES.md          durable findings, commands, chosen interpretations
  work/             scratch files
```

## What a round does

`build`: read `GOAL.md`, `PLAN.md`, `NOTES.md`, `LOG.md`, inspect the repo and
git status; pick the highest-value unit (or the smallest step that resolves the
biggest unknown); implement it; run the project's checks and fix damage; commit;
update the three files; report `{action, summary, evidence, next, blocked}`.
The audit is a fresh verifier that runs the checks itself and returns
`{satisfied, evidence, gaps}` — it does not trust the log.

`design`: read the four design files; write three candidate questions, rank by
materiality, pursue the most material one; choose `continue`, `simplify`,
`experiment`, or `rederive` (contract-only, independent design first); update
the files, commit, report `{mode, question, evidence, decision, next}`. The audit
tries to implement the contract and reports the first place it must invent
semantics.

## Resume

`STATE.json` is written atomically before and after every round. If the harness
or the machine stops mid-call, call again with the same `name`, `kind`, and
`goal`:

- completed rounds are never repeated;
- a round whose report was already written is ingested instead of re-run (pi);
- a round interrupted mid-flight is retried at the same number;
- the interrupted round is the resume granularity, not the conversation;
- the same name with a different goal or kind is rejected instead of mixed.

## Reviewing a run

```sh
git log --oneline -- docs/ralph/<slug>
git diff <start>.. -- docs/ralph/<slug>/
```

`kind=build`: read `AUDIT.json` first — `satisfied=false` means the goal was not
met, `gaps` says what is missing. `kind=design`: `AUDIT.json` `material=true`
means the design still has an implementability gap.

## Install / update

Both harnesses register the same tool name, `ralph`.

### DSH

Installed in a DSH profile as the bundle `@local/dsh-plugin-arch-loop` (the
package name is historical; it now provides `ralph`). Install it with
`plugin_manager` / `install_bundle` pointing at this repository, then restart
DSH.

The tool can be registered at host scope (available to every agent), inside a
preset, or both. If the shipped `tool-ralph` row is enabled in the same preset,
disable it: the scoped built-in `ralph` would shadow this one.

After editing `plugin.js` or either patch, restart DSH: the live process imports
a module generation once.

Config in `cordis.patch.yml`:

| Field | Default | Meaning |
|---|---|---|
| `provider` | `spawn` | Fresh subagent provider; must support structured output. |
| `maxRounds` | `64` | Per-call ceiling. |
| `defaultRounds` | `24` | Used when `rounds` is omitted. |

### pi

Extension in [`pi/`](pi/). Install:

```sh
pi install ./pi
```

Each round spawns a fresh `pi` child with built-in tools only
(`read,write,edit,bash,grep,find,ls`), in the project root, inheriting the
parent model and thinking level. The child writes `rounds/rNNN.json`; the tool
validates it. `/reload` after editing.

## Deliberate limits

- Round is the resume granularity: a child that dies mid-round is retried, not
  continued mid-conversation.
- `rederive` blindness (design) is procedural, not enforced.
- No per-round wall-clock timeout yet; interrupt and resume is the control.
- One auditor/verifier, not an adversarial panel.
- Completion is a per-call budget plus an audit verdict; no auto-continuation
  after a restart — re-invoke with the same name and goal.
