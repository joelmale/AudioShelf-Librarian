# Agent operating model

This document defines how Codex coordinates multi-agent delivery in
AudioShelf-Librarian. It turns the execution model originally embedded in
`librarian-engine-plan.md` §9 into a repository-wide protocol that can be used
for the remaining librarian work and future milestones.

The objective is not to maximize agent count. It is to keep requirements and
decisions in one orchestration thread, give each delegated task a bounded
contract, isolate concurrent writes, and require independent evidence before
integration.

## Source-of-truth order

Agents resolve instructions and project state in this order:

1. `AGENTS.md` — durable repository constraints, safety rules, commands, and
   completion expectations.
2. The user's current prompt — the requested outcome, scope, permissions, and
   task-specific acceptance criteria.
3. The relevant plan and architecture documents — intended behavior and
   recorded decisions.
4. The current implementation, tests, and git state — evidence of what exists
   now.
5. `docs/current-status.md` — a restart checkpoint, not an authority that can
   override code or newer evidence.

When sources conflict, stop and reconcile the difference. Do not silently pick
the source that makes the work easiest. Update stale documentation when the
correct state is established and the task permits it.

## Repository surfaces

```text
AGENTS.md                                  durable repository guidance
docs/agent-operating-model.md             collaboration protocol
docs/current-status.md                    restart checkpoint
.codex/config.toml                        project multi-agent defaults
.codex/agents/tech_lead.toml              milestone planning and integration
.codex/agents/explorer.toml               read-only investigation
.codex/agents/ic_implementer.toml          bounded implementation
.codex/agents/ic_reviewer.toml             read-only adversarial review
.agents/skills/audioshelf-work-order/      reusable orchestration workflow
```

The main Codex task is the orchestrator. There is intentionally no
`orchestrator.toml`: scope control, user communication, cross-agent sequencing,
and final acceptance belong in the task that received the user's request.

## Roles and accountability

| Role | Owns | Must not do |
|---|---|---|
| **Orchestrator** | User intent, scope, ordering, worktree allocation, agent steering, integration, human gates, and final acceptance | Hand the whole outcome to an unsupervised agent, accept self-reported success, or bypass a required user decision |
| **tech_lead** | One milestone: reality check, dependency graph, work orders, interface decisions, integration assessment, and phase report | Treat a plan checkbox as proof, fan out conflicting writers, or absorb routine implementation that has a clear IC boundary |
| **explorer** | Read-only execution-path tracing, contract discovery, evidence, risks, and ownership boundaries | Edit, mutate live systems, or present a guess as implemented behavior |
| **ic_implementer** | One work order, the smallest defensible implementation, focused tests, and a reviewable handoff | Expand scope, overwrite sibling/user changes, merge, or approve its own work |
| **ic_reviewer** | Independent review of the actual diff, tests, invariants, and failure modes; accept/revise/escalate recommendation | Edit the implementation or substitute style preferences for material findings |

Accountability is asymmetric by design: the implementer produces, the reviewer
challenges, the tech lead reconciles interfaces, and the orchestrator accepts.
Liveness or retry automation may continue an incomplete pass, but it never
replaces these ownership boundaries.

## Milestone workflow

### 1. Reconcile reality

The orchestrator inspects git status and asks `tech_lead` to compare the plan,
current checkpoint, implementation, and tests. Use `explorer` for independent
questions that can be answered read-only and in parallel.

The output is a dependency-ordered plan that distinguishes:

- already implemented and verified;
- implemented but awaiting acceptance;
- genuinely missing;
- blocked on another work item;
- blocked on user judgment or authorization;
- deliberately parked or out of scope.

### 2. Issue bounded work orders

Each delegated implementation must receive a self-contained brief containing:

```text
Outcome:
Why it matters:
Relevant context and decisions:
Files or ownership boundary:
Interfaces/contracts that must remain stable:
Exemplar files to imitate:
Required behavior:
Explicitly out of scope:
Safety constraints:
Named tests and failure paths:
Verification commands:
Done when:
Required handoff:
```

The brief should eliminate unnecessary rediscovery without copying large parts
of the repository into the prompt. Exact contracts and non-obvious invariants
belong in the brief; general repository rules stay in `AGENTS.md`.

### 3. Allocate concurrency deliberately

The repository operating policy permits at most three spawned agent threads in
addition to the main task, or the host's lower limit. This is a ceiling, not a
target. `.codex/config.toml` enables the multi-agent feature; the role files and
this protocol define how it is used.

- Parallelize independent exploration, test analysis, and documentation review.
- Parallelize code changes only when their file ownership is disjoint and each
  writer has an isolated Git/Codex worktree.
- If isolated worktrees have not been allocated, serialize all writers.
- Serialize SQLite migrations, shared schemas/types, API and SSE contracts,
  central tool registries, dependency manifests, and integration files.
- Treat `organizer.ts`, `rollback.ts`, `scanner.ts`, realign/commit/rollback
  routes, path containment, secrets, and live-database migrations as
  safety-critical single-owner work.

The orchestrator records ownership before work starts and resolves integration
order before parallel branches are merged.

### 4. Review every implementation slice

`ic_reviewer` reviews the actual diff after the implementer completes. The
review checks:

- requested behavior and acceptance criteria;
- repository and architecture invariants;
- filesystem, database, authentication, and secret-handling safety;
- boundary validation and error recovery;
- concurrency and partial-failure semantics;
- regressions and missing failure-path tests;
- whether a claimed test meaningfully proves the behavior.

Material findings return to the original implementer. The corrected diff is
reviewed again. The orchestrator integrates only when findings are closed or an
explicitly documented risk is accepted by the user.

### 5. Verify and accept

Run narrow tests during each work order. At a milestone boundary, run the
applicable repository gate from `AGENTS.md`, normally:

```bash
npm run typecheck
npm run lint
npm test
```

Add `npm run build`, `npm run verify:bundle`, or `npm run release:check` when
the affected surface or release boundary calls for them. Do not run live smoke
or mutation flows merely because they exist.

The orchestrator's acceptance report covers the outcome, work orders, files
changed, verification, review disposition, residual risk, user decisions, and
next action.

## Human gates

Agents prepare evidence and stop before:

- live-library moves, renames, deletes, rollback, or realignment;
- one-way writes to Audiobookshelf or another external system;
- production deployment or release publication;
- secret, credential, authentication, or environment changes;
- destructive Git operations or history rewriting;
- decisions explicitly reserved for the user by a plan.

For the current librarian plan, §10.C steps 6–7 require real-library cosine
analysis and the user's judgment about 5–10 representative queries. Agents may
prepare the harness and evidence, but must not invent the expected answers.

The audio-transcript pipeline remains parked until Phase 6 is complete and the
cheaper-source measurements in its own plan justify continuing. Completing an
earlier phase does not automatically authorize transcript work.

## Restart and handoff protocol

Update `docs/current-status.md` when a milestone changes state or before work is
handed off for an extended period. Keep it concise:

- last reconciliation date;
- active milestone and acceptance target;
- completed and verified work;
- in-progress ownership;
- blockers and required user decisions;
- checks last run;
- exact next action.

At restart, inspect git and the implementation first, then reconcile the
checkpoint. Never resume solely from a chat summary or status file.

## Triggering the workflow

The skill can be invoked explicitly:

```text
Use $audioshelf-work-order and the repository-defined agents to complete the
remaining work for [milestone]. Keep the main task as orchestrator, have
tech_lead reconcile the plan with the code, delegate bounded work to explorer
and ic_implementer, gate every implementation through ic_reviewer, wait for all
required results, and stop at documented human gates.

Done when: [task-specific acceptance criteria].
```

A prompt can also ask directly for the same role sequence. Explicit invocation
is preferred for large plan phases because it makes the intended workflow
unambiguous.
