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
