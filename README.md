# ralphi

`arch_loop` — a fresh-context architecture/design search, installed as a DSH
tool. One call creates the problem workspace, runs N design rounds with a new
child agent each round, then one independent audit.

No manual setup: no template copying, no files to create, no workflow script to
paste.

## Use

```
arch_loop({ goal: "Design a bounded LRU cache with O(1) get/put ...", rounds: 24 })
```

Optional arguments:

| Argument | Meaning |
|---|---|
| `goal` | The problem. Requirements, constraints and non-goals when known. |
| `constraints` | Hard constraints only: bounds, compatibility, runtime, invariants. |
| `paths` | Existing files/directories a refactor target must account for. |
| `rounds` | Design rounds. Default 24, ceiling 64 (`maxRounds` in config). |
| `name` | Stable directory name. Reusing it resumes that problem. |

The call is long-running and blocks the turn. Cancelling preserves every
completed round; call again with the same `name` to continue.

## What it creates

```
.ralphi/<slug>/
  CONTRACT.md       goal + constraints + paths, written once; edit it to change the problem
  ARCHITECTURE.md   best-known design; the worker replaces it only with evidence
  QUESTIONS.md      material open questions
  LOG.md            append-only per-round record
  experiments/      prototypes, benchmarks, re-derivations
  AUDIT.json        result of the independent audit
  rounds.jsonl      structured per-round reports (controller-owned)
  runs.jsonl        one record per arch_loop call (controller-owned)
```

Workers commit the problem directory each round when the workspace is a git repo,
so `git log` is the design history.

## What each round does

1. Reads `CONTRACT.md`, `QUESTIONS.md`, `LOG.md`, `ARCHITECTURE.md`.
2. Writes three candidate questions, ranks them by materiality, pursues the most
   material one.
3. Picks a mode: `continue`, `simplify`, `experiment`, or `rederive`.
   `rederive` reads the contract only and writes an independent design before
   looking at the incumbent.
4. Updates the files, commits, and returns a small structured report.

The final audit is a fresh agent that reads only the contract and the
architecture, tries to implement it, and reports the first place it must invent
unspecified semantics. `AUDIT.json` is the convergence check, not the worker's
opinion.

## Reviewing a run

```sh
git log --oneline -- .ralphi/<slug>
git diff <start>.. -- .ralphi/<slug>/ARCHITECTURE.md
```

Then read `ARCHITECTURE.md`, `QUESTIONS.md`, and `AUDIT.json`. Useful signals:

- all rounds `continue`, no `simplify`/`rederive` → the loop is polishing
- `AUDIT.json` material → reopen with a follow-up run
- rounds stop adding material questions → kill the job (`job_kill`); state is
  already committed

## Install / update

Installed in profile `web` as the bundle `@local/dsh-plugin-arch-loop`
(`/home/cedric/dev/ralphi` is linked into the profile). After editing
`plugin.js` or `cordis.patch.yml`, restart DSH: the live process imports the
module once.

Config lives in `cordis.patch.yml`:

| Field | Default | Meaning |
|---|---|---|
| `provider` | `spawn` | Fresh subagent provider. Must support structured output and not inherit context. |
| `maxRounds` | `64` | Per-call ceiling. |
| `defaultRounds` | `24` | Used when `rounds` is omitted. |

## Deliberate limits

- No resume checkpoint inside a call: state lives in files and git, not in a
  controller process.
- `rederive` blindness is procedural, not enforced.
- Only the final audit is independent of the search; there is no per-round
  auditor.
- No token budget; round count is the only spend control.

Add machinery only when one of these breaks a run in practice.
