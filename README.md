# ralphi

`arch_loop` — a fresh-context architecture/design search, installed as a tool in
both harnesses. One call creates the problem workspace, runs N design rounds
with a new child agent each round, then one independent audit.

No manual setup: no template copying, no files to create, no workflow script to
paste.

| Harness | Integration | Child per round |
|---|---|---|
| DSH | Host plugin + `Coder & Organizer` preset row | in-process fresh subagent |
| pi | extension package (`pi/extensions/arch-loop.ts`) | fresh `pi` child process |

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
| `rounds` | Design rounds to run in this call. Default 24, ceiling 64 (`maxRounds` in config); later calls add more. |
| `name` | Stable directory name. Reusing it resumes that problem. |
| `project` | Repository root that owns `docs/arch-loop/`. Defaults to the git root containing the workspace, else the workspace. |

The call is long-running and blocks the turn. Cancelling preserves every
completed round; call again with the same `name` to continue.

## What it creates

Inside the project repository, so the design record is versioned with the code
and committed by the workers:

```
docs/arch-loop/<slug>/
  CONTRACT.md       goal + constraints + paths, written once; edit it to change the problem
  ARCHITECTURE.md   best-known design; the worker replaces it only with evidence
  QUESTIONS.md      material open questions
  LOG.md            append-only per-round record
  experiments/      prototypes, benchmarks, re-derivations
  AUDIT.json        result of the independent audit
  rounds/           per-round report files (pi port; `rNNN.json` + `audit.json`)
  rounds.jsonl      structured per-round reports (controller-owned)
  runs.jsonl        one record per arch_loop call (controller-owned)
  STATE.json        controller-owned resume marker (next round, in-progress round)
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

## Resume

`STATE.json` is rewritten atomically after every round, before and after each
child runs. If DSH or the machine stops mid-call, call `arch_loop` again with the
same `name` and `goal`:

- completed rounds are never repeated;
- a round whose report was already written is ingested instead of re-run (pi);
- a round that was interrupted mid-flight is retried from `STATE.inProgress`;
- rounds continue numbering upward, and `rounds` is the budget for this call.

A later call with the same `name` but a different `goal` is rejected, so a
resumed run cannot silently drift. Use a new name, or delete
`docs/arch-loop/<slug>/`, to start over.

## Reviewing a run

```sh
git log --oneline -- docs/arch-loop/<slug>
git diff <start>.. -- docs/arch-loop/<slug>/ARCHITECTURE.md
```

Then read `ARCHITECTURE.md`, `QUESTIONS.md`, and `AUDIT.json`. Useful signals:

- all rounds `continue`, no `simplify`/`rederive` → the loop is polishing
- `AUDIT.json` material → reopen with a follow-up run
- rounds stop adding material questions → kill the job (`job_kill`); state is
  already committed

## Install / update

Installed in profile `web` as the bundle `@local/dsh-plugin-arch-loop`
(`/home/cedric/dev/ralphi` is linked into the profile). It is registered twice,
deliberately:

- host scope, from this bundle's `cordis.patch.yml` — available to every agent;
- `Coder & Organizer` preset (`preset-coder`), inside the user's
  `dsh-presets/coder-preset` package — the tool belongs to that agent's
  composition. Scoped registration shadows the global one for that agent.

After editing `plugin.js` or either patch, restart DSH: the live process imports
each module generation once, and an entry that failed to import cannot recover.

Config lives in `cordis.patch.yml`:

| Field | Default | Meaning |
|---|---|---|
| `provider` | `spawn` | Fresh subagent provider. Must support structured output and not inherit context. |
| `maxRounds` | `64` | Per-call ceiling. |
| `defaultRounds` | `24` | Used when `rounds` is omitted. |

### pi

The extension lives in [`pi/`](pi/): `pi/package.json` declares the package, and
`pi/extensions/arch-loop.ts` registers the same tool.

```sh
pi install /home/cedric/dev/ralphi/pi
```

Each round spawns `pi --mode json -p --no-session --no-extensions --no-skills
--no-prompt-templates --tools read,write,edit,bash,grep,find,ls
--append-system-prompt <worker.md>`, in the project root and inheriting the
parent model and thinking level. The worker writes `rounds/rNNN.json`; the tool
validates that file, so no assistant prose is parsed. The audit writes
`rounds/audit.json`.

In the TUI the call renders as the goal plus round count, rounds stream as
progress lines, the collapsed result shows status, mode mix and the audit
verdict, and the expanded view (Ctrl+O) adds the audit consequence, the state
path, and token/cost usage. The system prompt advertises the tool through its
snippet and guidelines, and calls are serialised so two loops cannot fight over
one problem directory.

Pi loads extensions once at startup; after editing the extension, `/reload` in an
interactive session (or restart) picks it up.

`arch_loop` is installed globally in `~/.pi/agent/settings.json`. To scope it to
one project instead, `pi install -l /home/cedric/dev/ralphi/pi` from that
project.

## Deliberate limits

- A round is the resume granularity: work done by a child that dies mid-round is
  lost and that round is retried, not resumed mid-conversation.
- `rederive` blindness is procedural, not enforced.
- Only the final audit is independent of the search; there is no per-round
  auditor.
- No token budget; round count is the only spend control.

Add machinery only when one of these breaks a run in practice.
