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
| `rounds` | Rounds to run in this call. Default 24, ceiling 64; later calls add more. Build mode stops early once the goal is verified, so this is a ceiling, not a quota. |
| `name` | Stable directory name. Reusing it resumes that run. |
| `project` | Repository root that owns `docs/ralph/`. Defaults to the git root containing the workspace, else the workspace. |
| `answer` | The user's answer to a question from a previous `needs-input` run. Omit otherwise. |

Long-running: the call blocks the turn. Cancelling preserves every completed
round; call again with the same `name` and `goal` to continue. In build mode a
round that reports `done` triggers the independent verifier immediately: if it
accepts the goal the run stops early, and if it rejects the concrete gaps are
fed into the next round. Remaining rounds are never burned on busywork.

## What it creates

Inside the project repository, so the record is versioned with the code and
committed by the workers:

```
docs/ralph/<slug>/
  STATE.json        controller-owned resume marker (next / in-progress round)
  rounds.jsonl      per-round reports (controller-owned)
  runs.jsonl        one record per call (controller-owned)
  AUDIT.json        independent verification result
  ANSWERS.md        controller-owned trail of user questions and answers
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
git status; resume from the previous report's `next`; pick the highest-value
step from `PLAN.md`; implement it and keep going while safe progress is
available (not just the first small edit); run the project's checks and fix
damage; commit; update the three files; report
`{action, summary, evidence, next, blocked, ask}`. A round must leave the
repository measurably closer to the goal: finishing the whole goal in one round
is not required, superficial work is rejected. The audit is a fresh verifier that
runs the checks itself and returns `{satisfied, evidence, gaps}` — it does not
trust the log.

`design`: read the four design files; write three candidate questions, rank by
materiality, and pursue the most material one until it is answered with
evidence (an immaterial first question means chasing the next one, not ending
the round); choose `continue`, `simplify`, `experiment`, or `rederive`
(contract-only, independent design first); update the files, commit, report
`{mode, question, evidence, decision, next, ask}`. The audit tries to implement
the contract and reports the first place it must invent semantics.

### User questions

A round has no direct line to the user, but it is not forced to guess. When a
user-owned decision changes the work, the round sets `ask` instead of inventing a
requirement or calling itself blocked:

- the controller relays the question to the user through the host question
  service while the ralph call is still open;
- the answer is written to `ANSWERS.md` and into `STATE.json`, and the next round
  receives it as `userAnswer` and must apply it first;
- if the relay cannot run (no answerer, or ralph was started inside a child
  agent), the call ends with status `needs-input` and the question in its result.
  The caller asks the user, then re-invokes `ralph` with the same `name` and
  `goal` plus `answer`.

### Progress discipline

The round prompt is the control surface against lazy microsteps. Every round:

- starts from the previous report's `next` and does not redo discovery already
  recorded in `LOG.md` or `NOTES.md`;
- keeps working while safe progress is available, instead of stopping at the
  first edit or at a next step it could execute now;
- treats "blocked" as external and concrete only (missing credential, unavailable
  service), never as "this needs more than one round" and never as a user-owned
  decision — those go to `ask`;
- writes `next` as a self-contained continuation contract: which file, which
  change, which command, which result proves it.

### Early completion

`build` mode must not keep working after the goal is met. A build round sets
`done: true` only when it ran the checks and believes the acceptance criteria
are satisfied. The controller then:

1. runs the independent verifier immediately (it does not wait for the round
   budget);
2. stops with `complete` and an early-stop line when the verifier agrees;
3. otherwise passes the verifier's concrete gaps into the next round as
   feedback, so the round fixes the real gap instead of guessing;
4. stops with `blocked` when two consecutive verifications reject the goal with
   identical gaps — that is a disagreement the loop cannot resolve by itself.

`design` mode keeps its full search budget: it is an exploration, not a
done-condition, and stops on its audit only at the end of the call.

## Resume

`STATE.json` is written atomically before and after every round. If the harness
or the machine stops mid-call, call again with the same `name`, `kind`, and
`goal`:

- completed rounds are never repeated;
- a round whose report was already written is ingested instead of re-run (pi);
- a round interrupted mid-flight is retried at the same number;
- a round that asked the user resumes at the next round with the answer, whether
  it was relayed live or supplied as `answer` after a `needs-input` result;
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

Requires **DSH 0.2.1-rc.2 or newer**: one-shot children are started through
`ctx.subagents.startActivation({ delivery: "caller" })`. On 0.2.0-rc.2 the tool
loads but its first call fails, because that release exposed
`ctx.subagents.start()` instead. The plugin imports only Node builtins, so it
has no peer dependency to enforce this — check `dsh --version` after upgrading.

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
- Question relay requires the exact live root agent as caller. A ralph started
  inside another agent ends `needs-input` instead of blocking forever.
- The pi port does not relay user questions; a pi round guesses or reports
  blocked.
