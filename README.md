# continuous-delivery-services-section

The one hired CI/CD section. Repos do not hand-write CI; they call these workflows.
Public so private repos in any org can call it. Callers pay their own minutes and use their own secrets.

Caller snippet (`.github/workflows/ci.yml`):

```yaml
name: ci
on: [push, pull_request]
jobs:
  ci:
    uses: red-cup-engineering/continuous-delivery-services-section/.github/workflows/node-package.yml@main
```

Workflows (swap the file name):

- `node-package.yml` - every package.json: `npm ci`, `check`, `test` on Node 24. Inputs: `paths` (JSON array), `concurrency`.
- `lean.yml` - lake build. Input: `working-directory`.
- `submodule-advance.yml` - one PR bumping moved submodule heads (`scripts/advance.mjs`). Secret: `token` (needs `secrets: inherit` or `secrets: {token: ...}`). Schedule it with `on: schedule`. It advances a pin only where the remote head descends from the pin, lists diverged pins in the PR body instead of advancing them, writes its body to `.git/advance-body.md` (nothing outside the workspace), receives the existing sync branch and default history before reading pins, and publishes only by fast-forward. Missing heads and unknown ancestry are listed separately from proven divergent histories in the PR body and fail sync receiving visibly; any qualified partial pin proposal is still opened. Inherited checkout extraheaders are cleared before selecting one authority. Git authorization is URL-scoped and subprocess credentials travel in environment or stdin, never command arguments. Inputs: `branch`, `note`.
- `notify-parent.yml` - section side of the upward chain: on push to `main`, sends `repository_dispatch` (`section-advanced`) to the parent. Input: `parent` (owner/repo). Secret: `token`, a PAT that may dispatch on the parent.
- `superrepo-advance.yml` - parent side: `submodule-advance` with the dispatching section named in the PR. Call it on `repository_dispatch` and a daily `schedule`. Input: `source`.
- `change-test.yml` - the pre-merge change test: the release controller
  (`red-cup-engineering/guix-machine-release-service`, `scripts/test-change.mjs`) composes the machine's admitted
  workspace with the pull request's commit, installs from `https://registry.561.group/`, builds as a release is
  assembled and fails only on regressions the change introduces. Inputs: `machine` (required: the repository holding the
  machine definition that mounts this repository by gitlink), `controller-ref`. Secret: `house-read-token`, from a secret named `HOUSE_READ_TOKEN` with contents:read on every
  repository the machine pins.
- `lockfile-fresh.yml` - the pnpm lock is fresh: every workspace package has an importer whose specifiers are
  exactly its declared dependencies (overrides applied), and every `workspace:*` dependency names a workspace
  package. A ratchet: the pull request's base is read too, and only mismatches the change adds fail
  (`scripts/lockfile-fresh.mjs`, which lists every stale importer where pnpm's frozen install stops at the first).
  Mounted submodules are read at the commits the superproject records; a mount the runner cannot reach is
  reported as unread rather than judged.
  Inputs: `directory`, `runs-on` (JSON runner labels, for a repository without GitHub-hosted runners).
- `absolute-symlinks.yml` - no committed symbolic link has an absolute target: it resolves only on the machine
  that wrote it, and where the path exists a workspace tool follows it into the live tree
  (`scripts/absolute-symlinks.mjs`, reading links from the index). Inputs: `exclude` (globs reported, not failed;
  default `**/legacy/**`), `runs-on`.
- `machine-lock-fresh.yml` - a machine snapshot's `dependencies.lock.yaml` still satisfies the workspace its pinned
  controller composes, resolved the way a release resolves: every source at its pin, the pinned controller's
  `prepare-sources.mjs --manifests-only`, then pnpm 11.9.0 frozen and lockfile-only, so nothing is downloaded
  (`scripts/machine-lock-fresh.mjs`). A plain pnpm run at the snapshot root cannot answer this, because the lock
  belongs to the composed workspace. A ratchet against the pull request's base. Input: `runs-on` (the machine's
  build runner, which can read every pinned source).
- `content.yml` - JSON files with a relative `$schema` are validated; relative markdown links are checked. Input: `links`.

Lean with a directory:

```yaml
jobs:
  ci:
    uses: red-cup-engineering/continuous-delivery-services-section/.github/workflows/lean.yml@main
    with: { working-directory: . }
```

## Caller generator

```
node generator/generate-ci.mjs <repo-dir> [--parent owner/repo] [--pr owner/repo]
  [--ref <40-character supplier commit>] [--runs-on '["self-hosted","Linux","X64","bare-cedar-fog"]']
  [--default-branch main] [--token-secret LMT_SUBMODULE_PAT]
```

Generated callers pin the generator checkout's exact commit (or an explicitly selected commit). Sync callers serialize runs and take the hiring repository's actual runner labels and token secret; the nested reusable workflow comes from the same supplier revision, and its engine checkout is immutable.

Selects `node-package` (any `package.json`), `lean` (a `lakefile.lean`/`lakefile.toml`, one job per directory) and `content` (JSON with a relative `$schema`, or Markdown with relative links), and writes `.github/workflows/ci.yml`. A repository with `.gitmodules` also gets `sync.yml` (advance on dispatch/schedule); `--parent` adds the push-to-main notify. Handwritten workflows are reported against the reusable workflow that covers them and are never removed. With `--pr`, nothing is written locally: the files go up as one pull request through the git-data API (`GH_TOKEN`), extending an existing `ci/caller-generator` branch without force.

## The upward chain

```
section repo, push to main -> notify-parent.yml -> repository_dispatch(section-advanced)
parent repo -> sync.yml -> superrepo-advance.yml -> submodule-advance.yml -> one PR
```

The PR token must be allowed to open pull requests (a PAT, or the repository setting "Allow GitHub Actions to create pull requests"). Pin records only: diverged pins wait for reconciliation (requirement 16).

Tests: `npm test`.

## One path from change to machine

A house package is made, tested, received and released along one path:

1. **Pull request:** the release controller receives it before merge. A machine's runner runs
   `receive-pull-requests.mjs`: each open pull request into a ref the machine tracks is composed into the machine's
   snapshot by the change test (`scripts/test-change.mjs`) and its verdict, with the class of any assembly break, is
   recorded on the pull request. A Claude Code session runs the same change test itself before merging (the
   controller's house session start). Package-local checks may add `node-package.yml` here.
2. **Merge:** with a merge commit, by whoever made the change, once the change test reports `no-regression`.
3. **Advance and receive:** a merged section advances upward through its parents' gitlinks (`notify-parent.yml`,
   `superrepo-advance.yml`, `submodule-advance.yml`) until it reaches the repository that holds a machine's
   definition. That repository's push to `main` builds the machine from itself and the repositories it mounts, at the
   commits the gitlinks record; deployment is a separate, explicit `workflow_dispatch`.

`change-test.yml` is the same change test for a GitHub-hosted runner. It needs a `HOUSE_READ_TOKEN` secret
with contents:read on every pinned repository, so the machine's runner is the default path:

```yaml
name: change-test
on: pull_request
jobs:
  change-test:
    uses: red-cup-engineering/continuous-delivery-services-section/.github/workflows/change-test.yml@main
    with: { machine: OWNER/MACHINE-REPOSITORY }
    secrets: { house-read-token: "${{ secrets.HOUSE_READ_TOKEN }}" }
```

## Agent branch intake

`agent-work.yml` receives same-repository branch pushes into draft pull requests and adds `agent:work`, `agent:blocked` and `agent:received` metadata. Its implementation is pinned to an immutable source commit and both external actions are pinned. It checks out only that maintained implementation; branch code, issue bodies and artifacts are never executed with its write token. The ordinary build/release workflows keep responsibility for source and operating qualification.

Install the caller below on the repository default branch. Existing branch work is reconciled separately because a push workflow is read from the pushed branch. Enable Issues and automatic merged-branch deletion in repository settings. To let `GITHUB_TOKEN` create draft pulls, the repository/org Actions policy must permit Actions to create pulls; without that permission the intake records a blocked issue and fails visibly. Keep default token permission read-only; the metadata job declares only its required issue and pull permissions. An Actions-created pull can require workflow approval; observe the actual checks rather than assuming a draft created by a workflow triggers every build.

```yaml
name: Agent work
on:
  push:
    branches: ['**']
  pull_request_target:
    types: [opened, reopened, synchronize, closed]
permissions:
  contents: read
  issues: write
  pull-requests: write
jobs:
  receive:
    if: github.event_name != 'push' || (github.ref_name != github.event.repository.default_branch && !github.event.deleted)
    uses: red-cup-engineering/continuous-delivery-services-section/.github/workflows/agent-work.yml@9941b91847d4c5e7947fb044faeb4e77476dc17d
```

The example binds the received workflow commit `9941b91847d4c5e7947fb044faeb4e77476dc17d`. Only source receiving is marked; operating, deployment, and customer acceptance still require their actual evidence. This pipeline does not change ChatGPT tool annotations or override a host's tool-decision policy.

## Publication

`publish-package.yml` owns registry publication for hiring repositories. The caller supplies runner labels and a registry token or registry user/password; authentication configuration contains environment placeholders. Tags are `publish/<organization>/<package>/v<declared version>`; a legacy `publish/<package>/v<declared version>` remains valid only when it selects exactly one manifest. The declared manifest supplies the scope. The tag source must already be in the default branch's history; private packages and the existing SQLite refusal remain intact.

The package is packed once. `receive-registry-package.mjs` compares its digest with authoritative registry metadata before and after publication. An occupied version with different bytes is a refusal, and network/authentication errors cannot be reported as absence or receipt. Machine installation and useful operating receiving remain separate.
