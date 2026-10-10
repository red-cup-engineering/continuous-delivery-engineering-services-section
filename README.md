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
- `submodule-advance.yml` - one PR bumping moved submodule heads. Secret: `token` (needs `secrets: inherit` or `secrets: {token: ...}`). Schedule it with `on: schedule`.
- `change-test.yml` - the pre-merge change test: the release controller
  (`red-cup-engineering/guix-machine-release-service`, `scripts/test-change.mjs`) composes the machine's admitted
  workspace with the pull request's commit, installs from `https://registry.561.group/`, builds as a release is
  assembled and fails only on regressions the change introduces. Inputs: `machine` (default `emsenn/cold-red-gate`),
  `controller-ref`. Secret: `house-read-token`, from a secret named `HOUSE_READ_TOKEN` with contents:read on every
  repository the machine pins.
- `content.yml` - JSON files with a relative `$schema` are validated; relative markdown links are checked. Input: `links`.

Lean with a directory:

```yaml
jobs:
  ci:
    uses: red-cup-engineering/continuous-delivery-services-section/.github/workflows/lean.yml@main
    with: { working-directory: . }
```

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
