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
- `submodule-advance.yml` - one PR bumping moved submodule heads (`scripts/advance.mjs`). Secret: `token` (needs `secrets: inherit` or `secrets: {token: ...}`). Schedule it with `on: schedule`. It advances a pin only where the remote head descends from the pin, lists diverged pins in the PR body instead of advancing them, writes its body to `.git/advance-body.md` (nothing outside the workspace), and never force-pushes a branch that carries a commit by anyone but the bot: it adds a commit on top instead. Inputs: `branch`, `note`.
- `notify-parent.yml` - section side of the upward chain: on push to `main`, sends `repository_dispatch` (`section-advanced`) to the parent. Input: `parent` (owner/repo). Secret: `token`, a PAT that may dispatch on the parent.
- `superrepo-advance.yml` - parent side: `submodule-advance` with the dispatching section named in the PR. Call it on `repository_dispatch` and a daily `schedule`. Input: `source`.
- `change-test.yml` - the pre-merge change test: the release controller
  (`red-cup-engineering/guix-machine-release-service`, `scripts/test-change.mjs`) composes the machine's admitted
  workspace with the pull request's commit, installs from `https://registry.561.group/`, builds as a release is
  assembled and fails only on regressions the change introduces. Inputs: `machine` (default `emsenn/cold-red-gate`),
  `controller-ref`. Secret: `house-read-token`, from a secret named `HOUSE_READ_TOKEN` with contents:read on every
  repository the machine pins.
- `lockfile-fresh.yml` - the pnpm lock is fresh: every workspace package has an importer whose specifiers are
  exactly its declared dependencies (overrides applied), and every `workspace:*` dependency names a workspace
  package. A ratchet: the pull request's base is read too, and only mismatches the change adds fail
  (`scripts/lockfile-fresh.mjs`, which lists every stale importer where pnpm's frozen install stops at the first).
  Inputs: `directory`, `runs-on` (JSON runner labels, for a repository without GitHub-hosted runners).
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
```

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

1. **Pull request:** the release controller receives it before merge. Cold Red Gate's runner, which already
   holds the credential it releases with, runs `receive-pull-requests.mjs` every 30 minutes: each open pull
   request into a ref the machine tracks is composed into the machine's snapshot by the change test
   (`scripts/test-change.mjs`) and its verdict, with the class of any assembly break, is recorded on the pull
   request. A Claude Code session runs the same change test itself before merging (the controller's house
   session start). Package-local checks may add `node-package.yml` here.
2. **Merge:** with a merge commit, by whoever made the change, once the change test reports `no-regression`.
3. **Receive:** the machine's own release workflow advances to the merged commit with the controller's
   `advance-reviewed-sources.mjs`, then builds, seals, probes and receives it.

`change-test.yml` is the same change test for a GitHub-hosted runner. It needs a `HOUSE_READ_TOKEN` secret
with contents:read on every pinned repository, so the machine's runner is the default path:

```yaml
name: change-test
on: pull_request
jobs:
  change-test:
    uses: red-cup-engineering/continuous-delivery-services-section/.github/workflows/change-test.yml@main
    secrets: { house-read-token: "${{ secrets.HOUSE_READ_TOKEN }}" }
```
