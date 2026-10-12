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
- `submodule-advance.yml` - one PR bumping moved submodule heads (`scripts/advance.mjs`). Secret: `token` (needs `secrets: inherit` or `secrets: {token: ...}`). Schedule it with `on: schedule`. It advances a pin only where the remote head descends from the pin, lists diverged pins in the PR body instead of advancing them, writes its body to `.git/advance-body.md` (nothing outside the workspace), receives the existing sync branch and default history before reading pins, and publishes only by fast-forward. Missing heads and unknown ancestry remain unresolved in the PR body and fail sync receiving visibly; any qualified partial pin proposal is still opened. Git authorization is URL-scoped and subprocess credentials travel in environment or stdin, never command arguments. Inputs: `branch`, `note`.
- `notify-parent.yml` - section side of the upward chain: on push to `main`, sends `repository_dispatch` (`section-advanced`) to the parent. Input: `parent` (owner/repo). Secret: `token`, a PAT that may dispatch on the parent.
- `superrepo-advance.yml` - parent side: `submodule-advance` with the dispatching section named in the PR. Call it on `repository_dispatch` and a daily `schedule`. Input: `source`.
- `change-test.yml` - the pre-merge change test (STD-CI), run against **every machine that pins this repository**:
  - `machines` reads each candidate machine's committed recursive Gitlink source graph (input `machines`, JSON array of `owner/repo` or
    `owner/repo:path` for a snapshot below the root; default Cold Red Gate and Bare Cedar Fog's MetroPlat) and keeps
    those that pin the calling repository (`scripts/pinning-machines.mjs`). Input `machine` names one instead.
    Discovery fails on unreadable or invalid declarations; it never treats an unknown machine as unpinned.
    Each selected snapshot is bound to the repository commit read during discovery, and the test checks out that
    exact commit. Snapshot paths and commits are part of the artifact identity.
  - `change-test`, one leg per machine: the release controller (`red-cup-engineering/guix-machine-release-service`,
    `scripts/test-change.mjs`) is consumed through the bounded hosted helper described below. Actual execution
    requires the owner's qualified image, installed Guix/toolchain and offline frozen dependency supply.
    Missing runtime admission refuses; a source-only receipt does not qualify the machine.
  - Credentialed preparation invokes only the pinned helper's reviewed source controller. Checkouts use
    `persist-credentials: false`; Git receives a URL-scoped read header only in preparation's environment.
    `materialize-sources.mjs --export-change` carries inert committed objects. Candidate execution, when a real
    runtime is admitted, uses the restricted non-root container described below, with no preparation-host credentials.
  - `report`: one pull-request comment, found by its marker and updated in place on every run, with each machine's
    verdict, regressions, and design rules added and removed (`scripts/change-test-comment.mjs`). The report
    reconciles every expected machine against the tested pull-request head and the controller receipt. Missing,
    duplicate, malformed, unexpected or wrong-head artifacts cannot produce `no-regression`. Failed discovery
    produces an unknown-coverage comment, including when no test leg could start. Before writing, the report
    rechecks the pull request head so an older run cannot replace a newer head's comment. A successful empty discovery
    says only that none of the configured candidate machines pins the repository.
  Inputs: `machine`, `machines`, `controller-ref`. Secret: `house-read-token`, from a secret named `HOUSE_READ_TOKEN`
  with existing authorized contents:read on every repository the machines pin. The generator pins the source
  supplier and maps only this named secret; `--house-read-token-secret` selects an existing binding. The example
  below names this review's workflow revision and remains a proposal until receiving requirements are met:

  ```yaml
  name: change-test
  on: pull_request
  jobs:
    change-test:
      uses: red-cup-engineering/continuous-delivery-services-section/.github/workflows/change-test.yml@a819b55e1d4024d177d16706f0ca0e6190354fbe
      secrets:
        house-read-token: ${{ secrets.HOUSE_READ_TOKEN }}
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

1. **Pull request:** the release controller receives it before merge. Cold Red Gate's runner, which already
   holds the credential it releases with, runs `receive-pull-requests.mjs` every 30 minutes: each open pull
   request into a ref the machine tracks is composed into the machine's snapshot by the change test
   (`scripts/test-change.mjs`) and its verdict, with the class of any assembly break, is recorded on the pull
   request. A Claude Code session runs the same change test itself before merging (the controller's house
   session start). Package-local checks may add `node-package.yml` here.
2. **Merge:** with a merge commit, by whoever made the change, once the change test reports `no-regression`.
3. **Receive:** the machine's own release workflow advances to the merged commit with the controller's
   `advance-reviewed-sources.mjs`, then builds, seals, probes and receives it.

`change-test.yml` proposes a hosted adapter for the same controller. It still needs the actual runtime,
machine formation and existing authorized source-reader binding described below; the machine's existing
receiving path remains the default:

```yaml
name: change-test
on: pull_request
jobs:
  change-test:
    uses: red-cup-engineering/continuous-delivery-services-section/.github/workflows/change-test.yml@a819b55e1d4024d177d16706f0ca0e6190354fbe
    secrets: { house-read-token: "${{ secrets.HOUSE_READ_TOKEN }}" }
```

### Source-only hosted change receiving

The change-test workflow reads the reviewed controller's recursive committed
Gitlinks, rather than legacy `sources.json` pins. Its preparation step calls
`materialize-sources.mjs --export-change`: a complete, independent Git source
carrier and inventory, with the preparation digest retained outside the carrier.
The controller refuses machine-definition or mounted-topology changes that need
separate head/base graph receiving. Publication-purpose raw sources remain on
their existing bounded publication route.

`hosted-change.mjs` consumes that carrier through the controller's actual
`prepareExportedComparison` and `test-change.mjs` interfaces. Only the trusted
helper runs on the acquisition host. The candidate process is a non-root Docker
container with read-only controller/helper/carrier inputs, fresh writable result
state, no network, no capabilities, no Docker socket or credential-bearing host
mounts, and explicit PID, memory, CPU and time bounds. Controller local Git config
is allowlisted before mounting; host credential environment is never forwarded.
A returned verdict must match the prepared machine and changed commit identities.
Candidate processes can write their comparison results; this is not independent
adversarial test-result integrity or a SLSA claim.

No runtime image is admitted by this change. The existing delivery owner must
review a `scripts/runtime-bindings/<controller-commit>.json` binding with kind
`guix.hosted-runtime.v1`, matching `controllerCommit`, source contract
`guix.change-source-carriers.v1`, an immutable owner image digest, a retained
`qualificationSha256`, and positive `uid`/`gid` matching the runner. The image must
already be present: the helper never pulls one. Qualification must establish the
controller's actual pinned Guix/channel/toolchain, offline frozen dependency
supply, and container execution with the real machine closure. Merely filling in
these fields is not qualification. Without that reviewed provider, the workflow
refuses before container execution. This source proposal does not add credentials,
image grants, runner capacity, deployment targets or runtime acceptance.

The controller's 512 MiB/100,000-file carrier limits bound accepted output after
acquisition; they are not a peak-disk or network acquisition quota. Source bytes
plus a separately retained digest are source custody evidence, not build
provenance or installed receiving. The current machine repositories still require
their owner-reviewed migration to the recursive formation contract before this
new controller can receive them. Preparation and container execution currently
share a hosted runner; splitting acquisition and test jobs requires authenticated
artifact transport preserving file modes and independently bound digests.

Source preparation is separately allowlisted by immutable controller revision in
`scripts/reviewed-source-controllers.json` before any controller code receives the
source-reader environment. Current source-only supplier is Guix PR107 at
`1d6f1ae842424fec43be9a892c8d5fc4296174d7` (47 source-level checks independently replayed).
This admission does not admit a runtime image or establish machine receiving.
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
