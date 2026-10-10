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
- `change-test.yml` - the pre-merge change test (STD-CI), run against **every machine that pins this repository**:
  - `machines` reads each candidate machine's `sources.json` (input `machines`, JSON array of `owner/repo` or
    `owner/repo:path` for a snapshot below the root; default Cold Red Gate and Bare Cedar Fog's MetroPlat) and keeps
    those that pin the calling repository (`scripts/pinning-machines.mjs`). Input `machine` names one instead.
  - `change-test`, one leg per machine: the release controller (`red-cup-engineering/guix-machine-release-service`,
    `scripts/test-change.mjs`) composes the machine's admitted workspace with the pull request's commit, installs from
    `https://registry.561.group/`, builds as a release is assembled and fails only on regressions the change
    introduces. Each leg's conclusion is that machine's check.
  - Credentials never reach the change's code. The checkout keeps none (`persist-credentials: false`). The house read
    token is given to git only through one step's environment, as a header, to form every source
    (`test-change.mjs --materialize-only`). The builds and tests then run in a step that holds no token and in which
    git may not reach the network (`GIT_ALLOW_PROTOCOL=file`).
  - `report`: one pull-request comment, found by its marker and updated in place on every run, with each machine's
    verdict, regressions, and design rules added and removed (`scripts/change-test-comment.mjs`).
  Inputs: `machine`, `machines`, `controller-ref`. Secret: `house-read-token`, from a secret named `HOUSE_READ_TOKEN`
  with contents:read on every repository the machines pin. The caller is five lines (written by the generator,
  `node generator/generate-ci.mjs --only change-test --pr OWNER/REPO`):

  ```yaml
  name: change-test
  on: pull_request
  jobs:
    change-test:
      uses: red-cup-engineering/continuous-delivery-services-section/.github/workflows/change-test.yml@main
      secrets: inherit
  ```
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
