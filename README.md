# ralphi

A fresh-context design loop for code-structuring and architecture problems.

One round = one fresh agent = one substantial investigation. No conversation
carries over; the problem directory is the only memory. You set the round
budget, the agent chooses each round whether to continue, simplify, experiment,
or re-derive from first principles. Compute buys exploration, not longer
documents.

## Layout

```
loop.workflow.js            the loop (pass its body to the workflow tool)
problems/_template/         copy this per problem
  CONTRACT.md               the only file a human must write; frozen
  ARCHITECTURE.md           best-known design; changes need evidence
  QUESTIONS.md              open questions, ranked by materiality
  LOG.md                    append-only round record
  experiments/              prototypes, benchmarks, re-derivations
```

One problem per directory. The loop is generic; only `CONTRACT.md` is specific.

## Start a problem

```sh
cp -r problems/_template problems/<slug>
$EDITOR problems/<slug>/CONTRACT.md
git add -A && git commit -m "start <slug>"
```

Fill in the contract completely. Underdesign in the loop usually traces back to
a contract that leaves behavior, constraints, or non-goals implicit.

## Run

Read `loop.workflow.js` and pass its **body** as `script`:

```js
workflow({
  meta: {
    name: 'arch-ralph',
    description: 'Fresh-context architecture design loop.',
    phases: [{ title: 'Design rounds' }, { title: 'Independent audit' }],
  },
  script: '<contents of loop.workflow.js>',
  args: { problem: 'problems/<slug>', rounds: 24 },
  run_in_background: true,
})
```

Use 10 rounds to test whether the contract is clear, 24–40 for a real search.
Collect with `job_output`; every round commits, so stopping early loses nothing.

## Review

```sh
git log --oneline -- problems/<slug>
git diff <slug-start>.. -- problems/<slug>/ARCHITECTURE.md
```

Then read `ARCHITECTURE.md`, `QUESTIONS.md`, and the audit finding. Worth doing
blind: look at the final design before looking at how many rounds produced it.
A trajectory that is all `continue` with no `simplify` or `rederive` is a sign
the loop is polishing instead of searching.

## What the loop enforces

- fresh context every round; files are the handoff
- three candidate questions and a materiality ranking before acting
- one substantial investigation per round, with an explicit commit
- a final independent audit that tries to implement the contract and reports the
  first place it must invent unspecified semantics

## What it does not do

- no resume state beyond the files and git history
- no per-round auditor, promotion gate, token budget, or candidate store
- no true blindness for `rederive` (it is procedural; the worker could peek)
- no enforcement that `ARCHITECTURE.md` changed only with evidence — review
  `git log` for that

Add machinery only when one of these actually breaks a run.
