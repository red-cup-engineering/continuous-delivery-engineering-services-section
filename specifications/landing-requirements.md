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

## Prior art

- Bors (Rust): the "not rocket science rule", where the main branch only ever holds commits tested exactly as merged.
- Zuul (OpenStack): gating dependent changes across several repositories together, over several code-review connections.
- Nix flake locks and Guix channels: each node pins its inputs by commit, and an update propagates by re-locking.

The lander takes their mechanisms, not their infrastructure.

## Receiving

- A change set touching MetroPlat and semiotic-eavt lands both `main` branches and advances `engineering-services-section` and the colony root in one run.
- A failing test in either touched section advances nothing.
- The same proposal arriving through GitHub and through a local bare remote lands identically.
