# Landing changes through the section tree

Requirement owner: continuous-delivery. Written 2026-10-29 by an engineering session on Bare Cedar Fog, answering the Leader in that session.

The Leader, 2026-10-29:

- "because we're aiming for rendanheyi, *each* submodule is almost its own monorepo, monadrepo? And truly is meant to own its subservices/subsections."
- "What's broken is not the idea, it's the tech of the idea."
- "Mergebot would be the answer, though, since that leaves it more under our control and less bound to github: github is meant to be one channel into our git stuff, which is itself just meant to be one channel into version control and such."
- "we NEED SHIT ON MAIN"

## What is broken

- One performance fix on 2026-10-29 needed a merge in MetroPlat, a fix in the publisher, four republished version pins, a host pointer bump and a host release: about ten steps across six repositories. Work stopped after the first.
- `submodule-advance` opens a pull request at every level of the tree, so every parent waits for a merge.
- Three carriers state one selection of a child: the parent's gitlink, an exact npm pin and a registry version. They drift apart (MetroPlat's closure carried 524 version mismatches).
- A change spanning several sections cannot be tested or landed together, so it lands piecemeal or not at all.
- The only gate is GitHub Actions; GitHub is one channel, not the version control.

## Model

A section is a repository that owns its child sections. A parent's gitlink to a child is the restriction of the parent's state to that child. A parent commit is coherent when its children's selections agree wherever they overlap: a package reached through two children resolves to one family. Landing a change means producing a coherent new commit at every ancestor of the changed sections, up to the root.

## Requirements

- LD-1. One carrier. Inside a section tree the parent's gitlink is the only selection of a child. A child consumed within the tree is consumed from its mounted path as a workspace package. Registry versions and exact pins are derived for consumers outside the tree (including host deployments until they compose from the tree) and are never hand-maintained inside it.
- LD-2. Proposals arrive through any channel. A proposal is a commit on a named ref in any configured git remote. A GitHub pull request is one channel; a branch on a local bare repository and a MetroPlat Work item naming refs are others. The lander reads and writes git refs; forge status and comments are adapters.
- LD-3. Change sets. One proposal may name commits in several sections. The lander lands all of them or none.
- LD-4. Tested as landed. The lander composes each proposal onto the current target of every touched section, advances gitlinks up to the lowest common ancestor of the touched sections, and runs each affected section's own test contract on exactly that composition. A target ref only ever advances to a commit tested in that form.
- LD-5. Lands upward without stopping. On success the lander advances each touched section's target branch and then each ancestor's gitlink, in one pass, through the root. It opens no intermediate pull request. On failure nothing advances, and the proposal is answered with the failing section, command and log.
- LD-6. Serialized per target. Proposals touching the same section are queued, and each is re-tested on the result of the landing before it.
- LD-7. The lander runs on the Group's own nodes as admitted work, at zero cash, and needs no paid forge feature (branch protection, auto-merge or merge queue).
- LD-8. Each section declares its test contract in one place the lander reads (by default `npm test` from a frozen install). A section without one lands on a successful build alone, and the landing says so.
- LD-9. The lander replaces the pull-request-per-level chain of `submodule-advance`, `superrepo-advance` and `notify-parent`; those are deleted when it serves their callers.

- LD-10. No central registry. Every node serves its own package registry from its own store and resolves house packages from it, from its section tree, or from peers. Peers replicate by content address, so no node, Cloudflare Worker or bucket is the canonical copy. A build or landing on a node never waits on another node's or a provider's availability or request allowance. Leader, 2026-10-29: "We don't want 'the house registry' we want decentralized registries that's the whole point. We can't wait an arbitrary 2 and a half hours because of our own bad engineering."

- LD-11. Work is proportional to the change. Landing a change installs nothing that is already in the node's content-addressed package store (an install of an unchanged lock is links, not downloads or re-resolution); runs only the tests whose import closure contains a changed file, plus the section's declared receiving tests; and reuses a recorded result when the exact source and dependency identities already passed. On 2026-10-29 each publish of MetroPlat installed about 1,060 already-stored packages from scratch and ran all 1,546 tests for a handful of changed files, took 20–40 minutes, and was killed by the out-of-memory killer.
- LD-12. Work is placed, not ruled. The lander asks the Group's work system where to run each job, from current observations of every reachable node's free memory, CPU, store contents and cost (zero cash), and runs it there; a node that fills up sheds the job to another. The Leader's own machine is a cockpit first: work lands there only when it is the best placement. Coordination never depends on agents telling each other to wait. Leader, 2026-10-29, on the written rule standing in for this: "sounds like some stupid 'rule' standing in from what needs to be intelligent distributed computing capabilities."
- LD-13. A change is judged against what the target fails, and a target that cannot be tested is not a target that fails nothing. A candidate lands when every test it fails the target also fails (the target's own failures are that section's debt, reported, not charged to the proposal). When the target cannot produce a list of failures (its install is refused, or its test command does not run), the lander runs the target's test command again with the target's source on the dependencies the candidate installed, and judges against that; the verdict says `baseline: "target"` or `baseline: "target-on-candidate-dependencies"` with the reason the target alone could not be tested. When that run cannot produce a list either, the lander refuses with `reason: "target-untestable"` and both errors, and calls no failure introduced. On 2026-10-30 the branch that regenerated a lockfile main's `pnpm install --frozen-lockfile` refused could not land, because the target could not be installed, so nine failures that predated it all counted as introduced.

## Prior art

- Bors (Rust): the "not rocket science rule", where the main branch only ever holds commits tested exactly as merged.
- Zuul (OpenStack): gating dependent changes across several repositories together, over several code-review connections.
- Nix flake locks and Guix channels: each node pins its inputs by commit, and an update propagates by re-locking.

The lander takes their mechanisms, not their infrastructure.

## Receiving

- A change set touching MetroPlat and semiotic-eavt lands both `main` branches and advances `engineering-services-section` and the colony root in one run.
- A failing test in either touched section advances nothing.
- A change that repairs the lockfile of a target the lander cannot install lands when it adds no failure beyond what the target's source fails on the change's dependencies; when neither can be tested the refusal is `target-untestable`.
- The same proposal arriving through GitHub and through a local bare remote lands identically.
