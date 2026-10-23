# continuous-delivery-services-section

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![change-test](https://github.com/red-cup-engineering/continuous-delivery-services-section/actions/workflows/change-test.yml/badge.svg)](https://github.com/red-cup-engineering/continuous-delivery-services-section/actions/workflows/change-test.yml)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

The one hired CI/CD section. Repos consume its reusable workflows instead of duplicating CI implementations. This source is public so that private repositories in the Group's different GitHub organizations can reference exact commits.

**CI receiving for this public source owner:** Its own trusted-branch source checks use the
standard `ubuntu-24.04` GitHub-hosted runner, free for public repositories,
instead of requiring the development laptop. Only this hosted public source-
contract job passes `--legacy-peer-deps` to its pinned npm installation,
matching the existing Cloud Build source self-check. The full private-composition
job retains its normal peer validation; no shared `.npmrc` relaxes it. This
source-only installation does **not** erase the required Git-services peer
from `package.json` or qualify a downstream composition.
The public `agent-work-contract` job now executes only the full owner-selected
standalone, dependency-closed source-contract suite: generator/rendering,
retained-runner graph analysis, node-package interface, and provider-native
Cloud Build configuration. The full `node-package` **reusable workflow** still
requires a caller-supplied, observed self-hosted runner and original composed
Git-services 4.1.1 dependency. It is **not** an automatic job of this public
push/pull_request workflow: that previous wiring left the overall run queued
for unavailable Bare Cedar Fog even after the public source-contract job
succeeded. Independent public source CI now finishes without claiming
the missing private composition tests. An original consuming repository must
receive the complete suite on genuinely available compute; the public source
suite cannot substitute a weakened local implementation or prove installation.
Use `node generator/generate-ci.mjs . --audit-runners --public-repo` to audit
this source owner's exceptional runner route. This exception does not change
private consumers' own self-hosted runner requirements, the exact-source
build receiver, the Guix/LAGOON release path, or installed customer acceptance.
No CI result is implied by a runner selector alone.

## Release integrity: no ghost packages or sacrificed dependencies

The original `src/release/closure.mjs` and `scripts/release-pack.mjs` must preserve every declared runtime and optional dependency. A missing internal owner, unresolved local `workspace:`/`file:`/`link:` coordinate, or dependency cycle is an **actual refusal before packing or publication**, never an apparent success with a smaller manifest. The old `--drop` release shortcut and generated workflow input have been retired. Existing Code-owned npm publication/version-policy and the genuine registry remain the authoritative release tools; this CD source never invents an external version or grants registry writes. An exact packed archive only qualifies source preservation; a real registry write, native LAGOON construction, installed MetroPlat and market receiving remain distinct outcomes.

## Reviewed Guix source-controller bindings

The original `scripts/reviewed-source-controllers.json` is a **manually
reviewed, versioned source-data declaration**, not executable code or an
archive receipt. Its actual consumer is
[`scripts/hosted-change.mjs#admitSourceController`](scripts/hosted-change.mjs)
before importing any selected Guix verifier. To record a newly qualified
controller, review its exact immutable original commit and tree and obtain
the Git **blob** SHA-1 of the source `scripts/verify-release-source.mjs`
from that controller (not a hash of a checkout path or a claimed approval).
The live helper checks the verifier's bytes against that identity again.
Git objects and validator results establish source identity only, not
run authority, host availability or a machine's Work receiving.

New source declarations use `guix.reviewed-source-controllers.v3` and the
descriptive `sourceVerifierGitBlobSha1` property under the
[Draft 2020-12 schema](scripts/reviewed-source-controllers.schema.json).
The existing helper reader also accepts **exact historical v2** entries
with `verifierBlob`, translating them into the same v3 result. It refuses
mixed/unknown fields, duplicate commits, missing/oversized/symlinked input,
unsupported versions and unread source; it does not rewrite retained
historical records or manufacture a release-controller approval.
[Native refusal tests](test/hosted-change.test.mjs) exercise this same
reader alongside the existing source and worker tests.

## Native off-host artifact fabrication and independent receiving

The original **public** Red Cup Continuous Delivery owner already has
`scripts/release-pack.mjs` and native release/source tests. Its
[`native-source-package.yml`](.github/workflows/native-source-package.yml)
now runs those original components on GitHub-hosted `ubuntu-24.04`, with
no private source checkout, secrets, private GitHub Actions consumption or
machine-host dependency. It checks the exact triggering Git revision and
packages **the original Continuous Delivery source owner** using its
source-owned release-closure/version logic; it does not construct a new
resource-placement engine or publish a second registry.

The first independent runner creates the actual npm-format release archive,
`plan.json` and `SHA256SUMS`; the second runner downloads that exact
GitHub Actions artifact, verifies its SHA-256, extracts the npm archive and
executes the original dependency-closed placement/release tests **from the
unpacked artifact**, not the producer checkout. It also observes its own
running CPU, available RAM and free disk and asks the original
`scripts/place-job.mjs` to plan one genuine already-admitted CI qualification
against this already allocated runner. The source job executes **only after**
the original planner selects that exact observed runner. This local job
observation is not a provider quota report or authority to run arbitrary
customer effects. No private data leaves its repository.

**Receiving limits:** Artifact construction, artifact transfer and isolated
package execution are genuine independent cloud results, but the tarball's
mandatory `@red-cup-engineering/git-services-section` peer remains
unavailable to that public source-only installation. This does not qualify
the full private Composition, Guix/LAGOON construction, runtime deployment,
independent production actor Work, enterprise resource settlement or buyer
acceptance. Preserve the existing reusable `node-package.yml` and those
original receiving gates unchanged. Source-only CI by itself never proves
the separate native artifact/consumer job passed; inspect both completed
jobs and their exact source/artifact identities.

## Resource-based compute placement, not a cloud shortlist

The existing [resource-placement engine](src/placement/place.mjs), [shared
allowance and budget owner](src/placement/allowance.mjs), [lease/fencing
owner](src/placement/lease.mjs), [build settlement](src/placement/settle.mjs)
and [original runnable entrypoint](scripts/place-job.mjs) form one concrete
distributed-work mechanism. This is an Engineering engine; the instance node
measurements and provider-account credentials remain in their actual
Operations/corporate owners. Do not make another cloud/machine catalogue,
agent-only deployer or `sources.json` to describe this one.

**Admit measured capacity and source-egress authority, not a vendor's
advertised free tier.** A private job sent to any externally metered free
provider must carry a scope-specific original `sourceEgress` grant
(`permitted`, `provider`, `scope`, `authorityRef`). Missing or mismatched
grants are refused before a budget quote. Merely seeing an account or installed
CLI cannot grant permission to send private Git source to it. Source
snapshots under `data/placement/nodes/` are historical examples: a node
must be observed `up` or `intermittent` within the last hour, with the
needed capabilities and memory/cores/disk and a qualified budget where
applicable. The current private GitHub-hosted runner is marked **down**
because its free minutes are exhausted; Cold Red Gate is marked **down**
because it is unavailable; the recorded cloud session's heartbeat expires
after one hour. A new program invocation cannot default unknown spent
GitHub minutes to zero. Other qualified nodes remain eligible even without
a GitHub allowance. Non-observed node status, unknown cost kinds and private
source on public-only compute refuse.

**Distribute a whole original office shift before selecting a provider.**
`planFleet(jobs,nodes,{now,ledger,budgets})` extends the same resource-placement
engine, not a second scheduler. It provisionally packs *multiple jobs* against
the same fresh, independently observed node CPU/RAM/disk and free-tier budgets,
with temporary holds for maximum runtime and scoped private-source egress
authority. **Any truthy original job effect (boolean, typed object, or verb string)**
is pending independent effect authority rather than provisionally placed as a
pure build. The single-job view uses the same truthiness rule when marking
`needsLeaderWords`; an unrecognized effect form must not become an implicit
pure-operation grant. Original unknown/missing effects still receive the
existing pure-eligibility semantics; an actual dispatcher needs the separately
qualified effect classification and grant. It never mutates the original node or provider evidence, assumes
a free account exists, acquires a live lease, or launches code. Uncertain
resources create probe requests rather than silently receiving capacity; jobs
with external effects require their real independent authority. Consumers
must secure atomic provider budget holds and original fenced leases with
an authenticated executor before turning proposals into effects. The original
fleet regression uses one owned host, a CircleCI Free node and an OCI A1
node with bounded *test-only* observations; it confirms distribution and
no shared-quota double booking without pretending those nodes are online.

**Settle only independently observed spent minutes and independent
build agreement.** The original GitHub hosted allowance now prices and
reserves a job's *maximum* bounded duration; a missing maximum cannot turn
an optimistic estimate into free capacity. Consumed minutes without a
provider readback, negative consumption, overrun beyond the original hold,
or replay of a settled job are refused without mutating the balance.
A single build or multiple readings from one node may be locally inspected
but may **not** be published as independently verified Guix/store output;
only agreeing claims from distinct, separately authenticated builders are
publishable. The placement/settlement layer still requires an actual
single-writer ledger and native provider readback before external effects.

**Price the actual currently available capacity.** The original `quoteBudget`
already subtracts outstanding free-quota reservations through
`budgetAvailable`. Its companion scarcity ranking must price the **same**
available balance, not an earlier nominal `remaining` snapshot; otherwise
two individually eligible providers can be ranked backward after another
office reserves one provider's credits. This is a price/placement correction,
never evidence of execution, billing, a newly observed provider or a lease.
The original provider-budget hold, fencing and native settlement remain required.

**Admit a real bounded lease before changing the fencing table.** The
existing `grant` and `renew` operations require nonempty original job/node
identities, an actual parseable observation time, a positive whole-millisecond
TTL and a representable expiry **before** incrementing a token or replacing a
live expiry. Bad time/TTL must not poison the original monotone counter or
create an indefinite/expired authority claim. Fenced acceptance remains the
original receiver's responsibility, never a grant of office authority.

**Conserve actual multi-provider capacity.** The original free-budget
quote refuses a zero-resource reservation; every externally metered Work
must claim at least one positive resource unit. A provider's observed
remaining units can shrink while a held Work executes, so settlement
checks **all** billed denominations against remaining observed capacity
before debiting **any** of them or finalizing the hold. An infeasible
readback requires reconciliation; it must not create a negative OCI,
GCP or Cloudflare free-quota balance or disguise a charge as zero cost.
This is an accounting boundary, not an account connection or executed job.

**Read original quota before planning and hold before dispatch.** Provider
adapters must authenticate fresh native, non-secret provider readback and
supply an account-scoped free-only budget observation. Its `sourceRef`,
`observedAt`, `expiresAt`, denominations and hard-stop rule are required.
`newObservedBudget`, `quoteBudget`, `holdBudget`, `settleBudget` are
functions of the *existing shared allowance module*, not a separate stored
ledger. A `metered-free` node supplies explicit units per minute and a
maximum admissible job duration. The allocator computes and returns the
hold for the **maximum** runtime, not only the optimistic estimate; it
refuses exhausted, unobserved or stale balances, wrong units, paid spillover
and fake hard stops. Atomic holding and a fenced lease are still mandatory
before an external effect is executed; a placement plan alone is no job
or provider admission.

**One CLI, no guessed credentials or ledger defaults:**

```sh
# Plan an actual ordered office shift with the same original source:
node scripts/place-job.mjs \
  --jobs /original/jobs.json --nodes /existing/installed/node-observations \
  --budget-stdin --now 2026-10-15T06:30:00Z < /observed/provider-readback.json

# Original single-job compatibility uses --job instead of --jobs.
node scripts/place-job.mjs \
  --job /original/job.json --nodes /existing/installed/node-observations \
  --budget-stdin --now 2026-10-15T06:30:00Z < /observed/provider-readback.json

# Optional hosted allowance only when an actual provider reading is known:
node scripts/place-job.mjs --job /original/job.json \
  --nodes /existing/installed/node-observations --plan free \
  --used 2000 --observed-at 2026-10-15T06:30:00Z
```

The `/observed/provider-readback.json` path denotes a transient
native provider readback already qualified by the caller, **not** a new
installed executable, machine registry or claim that CircleCI/OCI is
connected. With no authenticated, current provider observations the engine
refuses to dispatch work there.

### Current free-capacity constraints (provider offers, not live nodes)

- CircleCI Free: private 30,000 credits/month, 5 credits/min for `small`
  (1 CPU, 2 GB); public open-source Linux builds may qualify for an
  additional 400,000 credits/month. **Never spend a public OSS allowance on
  private source.** The actual CircleCI account/project and private checkout
  must be received first. References: https://circleci.com/pricing/ and
  https://circleci.com/pricing/price-list/ and
  https://circleci.com/docs/guides/plans-pricing/credits/
- OCI Always Free A1: 1,500 OCPU-hours and 9,000 GB-hours/month
  (approximately 2 OCPUs and 12 GB continuously), plus separate AMD micro
  allowances in the tenancy home region. The source allocator handles OCPU-
  and GB-hour balances *as independent dimensions*; tenancy free-only
  enforcement and a running guest need separate native provider receiving.
  Reference: https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
- Cloudflare Workers Free: 100,000 requests/day and 10 ms CPU/request, not
  a POSIX worker or a useful substitute for Node test/build VMs. Admit only
  request-sized pure work through the original web/networking capability
  with its **own** per-request CPU bound; this minute-based builder does
  not pretend that a whole build fits in one Worker request.
  Reference: https://developers.cloudflare.com/workers/platform/limits/
- GitLab.com Free: 400 shared compute minutes/month; Render Free offers
  750 web-instance hours/month but sleeps on idle. They are potential
  provider offers, **not installed accounts, live workers or trusted
  private Git checkouts**. References: https://docs.gitlab.com/ci/pipelines/compute_minutes/
  and https://render.com/docs/free

The real next receiving event is a no-billing provider observation with
an independently verified test job/lease and original output, followed by
quota settlement from actual usage. The source regression is
[test/placement.test.mjs](test/placement.test.mjs); it exercises blocked
GitHub consumption, expired provider observations, CircleCI credit holds,
the two independent OCI quota dimensions, invalid private/public source
placements and genuine lease fencing.

## Free private CI without Google billing or GitHub-hosted minutes

**Selected consumer:** private `red-cup-engineering/git-services-section`.
The native [CircleCI Free configuration](.circleci/config.yml) is held at its
existing reusable **Red Cup Continuous Delivery** Engineering owner; the code
and `npm run verify` remain in the actual private Git Services repository.
This replaces that consumer's exhausted GitHub-hosted CI and unapproved
Google Cloud Build activation. CircleCI Free currently grants 30,000 monthly
credits (up to 6,000 small-Docker minutes) without a credit card, with jobs
blocked at exhaustion rather than silently billed. This emergency independent
hosted route is **not** a substitute for bringing up Guix/LAGOON-owned compute.

**One-time native provider receiving (requires authorized account action):**
In CircleCI Free, install the CircleCI GitHub App with *repository-limited*
access to `red-cup-engineering/continuous-delivery-services-section` (public
configuration source) and `red-cup-engineering/git-services-section` (private
checkout source). Create the project for the **private Git Services repository**.
Select this Engineering owner's `.circleci/config.yml` at protected `main`
as its **configuration source**, and the private Git Services repository as
**checkout source**. Supply the project checkout's normal SSH grant if the
GitHub App onboarding requires it. Choose the GitHub App trigger preset
**"Pushes to default branch"**; this source additionally filters to
`pipeline.git.branch == "main"`. Do not authorize billing, add a paid
account, create a context, copy private code into the public configuration
repository, or deploy a Worker as a stand-in.

The native CircleCI job selects a **small** Docker executor with CircleCI's
published Node 24 image, verifies the exact provider `CIRCLE_SHA1` against
the checked-out Git commit and origin repository, checks the existing full
`npm run check && npm test` contract, then runs `npm run verify` in a
**separate step**. It does not install workspace dependencies just to pass a
source-only suite, spend Google or GitHub-hosted minutes, persist private
artifacts, use caches, publish releases or read production credentials.

**Real acceptance (still outstanding until connected):** independently read
the CircleCI project's actual linked GitHub App/repository, config source,
checkout source, active main trigger, Free-plan credit balance, and first
completed pipeline/job ID. Verify the exact Git Services commit and full
native test count/output. A skipped workflow, successful public config-source
test, or a locally executed subset is *not* private CI delivery. Then admit
a second private Red Cup consumer through the same Engineering-owned config.
Keep [owning P0 CI incident #7](https://github.com/red-cup-engineering/github-engineering-services-section/issues/7)
open until real provider build receipts exist.

**Second original private consumer prepared — inference energy WorkPlacement.**
The separate [private inference CircleCI configuration](.circleci/private-inference.yml)
will qualify [computer-inference-engine](https://github.com/red-cup-engineering/computer-inference-engine)
as another exact GitHub App **checkout source**, while this **public** Continuous
Delivery repository at protected `main` remains the config source and
`.circleci/private-inference.yml` is its independent Config File Path.
CircleCI's [multiple-configuration project contract](https://circleci.com/docs/guides/orchestrate/set-up-multiple-configuration-files-for-a-project/)
explicitly supports distinct config, checkout and trigger source repositories.
This never changes the existing Git Services configuration or uses a second
paid GitHub-hosted Actions runner.

The source-guarded `cimg/node:24` small executor rejects wrong Git origin,
a stale `CIRCLE_SHA1`, changed native package identity or missing
WorkPlacement test contract; uses pinned pnpm 10.18.3 against the original
`pnpm-lock.yaml`, with lifecycle install scripts disabled; and then executes
the **actual** `test/dispatch/attention-work-placement.test.mjs` and
`test/dispatch/resource-control-time.test.mjs` source tests. It is a
**bounded native WorkPlacement receiving gate**, not the inference package's
entire test suite or an electricity sensor.

**Activation remains separately owed.** An authorized organization admin must
first complete the original CircleCI Free GitHub App integration, retaining
repo-limited grants and Free-plan cost controls. After the original Git
Services project actually receives its test, activate the second inference
project with this file and its own private checkout, choose a matching
main-branch event, and read the CircleCI pipeline/job/commit/test result.
Without authentic provider installation, registry dependency availability and
a completed result, this is only independently testable CI configuration
source—not independent CI success or physical joules per accepted Work.

**Durable alternative:** Oracle Always Free capacity can be received as an
authorized Guix/LAGOON self-hosted runner when original tenancy capacity and
Red Cup repository/runner access are observed. Self-hosted Actions jobs use no
GitHub-hosted minutes but require real registration and live receiving; no
`bare-cedar-fog` or `cold-red-gate` fallback is an independent solution.

**GCP custody:** the existing Cloud Build owner below is retained as a
distinct reusable provider capability, **not selected or approved** for Git
Services. Do not request, approve, or trigger Google builds for this consumer
without a later, explicit change in financial authority.

### Additional public open-source compute lane

The same original Continuous Delivery Engineering owner also supplies
[.circleci/public-source.yml](.circleci/public-source.yml) for its own
**public repository** checkout, distinct from the private Git Services
configuration above. CircleCI Free publishes up to **400,000 credits/month**
for qualifying Linux open-source builds in a public repository, separate
from the 30,000 private-personal credits. Eligibility and the actual
recognized balance must be checked in the provider account. This is not a
license to execute private source in a public pipeline.

This public config checks the exact GitHub source/revision and uses a
`cimg/node:24` **small** Docker executor, installs the existing pinned
parser with lifecycle scripts disabled, and invokes the original
`npm run test:public-source-contract`. The *same* package-owned command
is used by the older GitHub public-source job; its explicit test selection
no longer diverges, repeats `test/placement.test.mjs`, or accidentally
substitutes the unavailable full private-composition suite.

When CircleCI GitHub App access is provided, create a **separate** CircleCI
public Red Cup Continuous Delivery project choosing this repository
as both config and checkout source, selecting
`.circleci/public-source.yml` at protected `main`; enable
**Pushes to default branch**. That opens an independent source-test
compute lane without private checkout grants. Observe an actual
public CircleCI job, correct Git revision, test count, and OSS credit
eligibility before counting this allowance as received capacity.

## Native Cloud Build trigger receiving for private GitHub source

The existing provider-native cloudbuild.yaml is a source execution recipe;
installation belongs to this Continuous Delivery section, not to independent
ad hoc instructions at each consuming repository. The actual operation is
[scripts/cloudbuild-github-trigger.mjs](scripts/cloudbuild-github-trigger.mjs).
It uses supported gcloud builds connections/repositories/triggers API
through one authenticated CLI, without holding, printing or copying credentials.

Run node scripts/cloudbuild-github-trigger.mjs --help for the complete options.
From an already authorized cloud toolchain, discover --project=ID --region=REGION
--repository=OWNER/REPO finds the unique existing second-generation GitHub
connection and repository resource, without guessing provider identifiers or
creating another account, mirror, or registry. Absent, inaccessible and duplicate
connections refuse rather than inventing a source. inspect then reads the project,
billing-enabled status, installed GitHub App connection, linked repository URI,
dedicated build principal, and all native trigger declarations. ensure first
performs those identical reads, creates only one absent approved exact-main
private-source trigger, and rereads the provider's returned ID/configuration.
A conflicting or switched trigger halts; repeat invocations reuse the qualified
original. It does not create an account, connection, IAM principal, install a
self-hosted runner, read secrets, run a test, or spend build minutes merely by
creating a manually approved trigger.

Inputs must name the actual selected GCP project, region, existing second-
generation GitHub connection and repository resource ID, the source
owner/repo, a dedicated same-project service account, and the verified digest
of a suitable Node 24 image. Do not guess a connection ID or commit a private
token. Obtain those from the legitimate existing GCP principal. The consuming
source repository supplies its real cloudbuild.yaml; Git Services currently
has one using its complete `npm run verify` suite.

After a real build completes, `read-build` reads **both** the provider's
build and the actual original `cloudbuild.yaml` Git blob at the provider's
resolved commit, using `--source-workspace=/absolute/authenticated/checkout`.
It compares every provider-executed build step against the committed source
recipe after resolving Google Cloud's exact substitution values. The original
source preflight must be a preceding Bash step; **the selected test step must
run `npm run verify` as its direct `npm` entrypoint and arguments**, not
inside Bash. Otherwise even a faithfully executed committed script can
exit successfully before it reaches the tests. The receiver refuses arbitrary
early exits, bypassed test commands, changed entrypoints, extra steps,
`allowFailure`, `allowExitCodes` and mismatched images or environments.
This reuses the native `git show COMMIT:cloudbuild.yaml` source reader and
Cloud Build's original executed-step status, without a second code store.

`read-build` still checks the original GitHub repository, exact commit,
2nd-generation source provenance, approved build, selected service account,
digest-pinned image and selected original executable command. The caller
supplies actual source workspace, repository resource, image, service account,
command and step ID; this owner does not hardcode Git Services. Actual billing
consumption must be read separately. A trigger that excludes relevant files
or adds extra substitutions refuses instead of silently skipping tests. 
Billing-enabled does not establish remaining free quota; provider cost/usage
and budget must be checked independently before approving a build. A source
merge or installed trigger does not restore CI until the native build steps
actually execute successfully.

This is the established provider infrastructure under Git Services CI incident
[red-cup-engineering/github-engineering-services-section#7](https://github.com/red-cup-engineering/github-engineering-services-section/issues/7).
The operative regressions are
node --test test/cloudbuild-trigger-operations.test.mjs; the existing
public-source contract job runs them without private credentials or the
unavailable private Git Services peer. GCP account/installation effects require
an authenticated provider session; the source tests do not substitute for it.


### Execute the selected private source, rather than stopping at an installed trigger

The original `scripts/cloudbuild-github-trigger.mjs` now owns the complete
provider request boundary. After `discover`, `inspect` and (if necessary)
`ensure` have received the actual installed, manually approved native trigger,
`plan-build` reads the same GCP identity and emits the exact
`gcloud builds triggers run --sha=<40-hex-commit>` request **without running it**.
Only `request-build` with `--authorize-request=pending` actually submits that
request. It neither approves the pending build nor claims tested software; an
independent authorized approver must check actual budget/free quota and approve
it. The request reads the native build ID and verifies the exact commit,
connected source, trigger, service account and required PENDING approval.
If the provider response or readback is ambiguous, **do not retry**: reconcile
that request from GCP's actual build inventory first, to avoid duplicates and
unintended billed minutes. No parallel ledger or machine registry is introduced.

After approval and successful execution, use existing `read-build` with
the real build ID and original selected test command. The receiver admits
either a normal main-source build or an exact pinned-SHA invocation, **only**
when GCP's resolved connected repository and immutable commit agree, the
original full test step actually passed, and the protected image/principal
and approval evidence match. An accepted source-only CI run is not Guix
promotion. The installed service still requires LAGOON generation,
supervisor, process and native work readback.

## Runner custody: normative Group default (2026-10-13)

**Use our own machines for ordinary Group CI, change receiving, branch intake, and releases. Do not select GitHub-hosted runners as an implicit fallback.** The existing caller generator requires a `self-hosted` label and an explicit machine or pool identity. For example, `["self-hosted","Linux","X64","bare-cedar-fog"]` names a machine observed completing jobs for `561-group`. A different organization or repository may not have permission to use it.

A callable workflow does **not** provide the runner: its *owning repository* must have a registered, authorized, online runner (or access to an organization/enterprise runner group) with every requested label. A runner registered in the `561-group` organization is **not** automatically available to `causeway-services`, `red-cup-engineering`, `coesite-operations`, or `lenticule-science`. Runner provisioning is an Operations/host-custody responsibility; do not create a made-up machine catalogue or hand-wave access by copying labels. No repo should silently spend GitHub-hosted minutes when house capacity is absent. If a house runner is not reachable, say `runner-capacity-unreceived`, retain the work, and repair the actual organization registration, runner group permissions, or machine service.

**Audit existing callers:** `node generator/generate-ci.mjs /path/to/checkout --audit-runners` prints all static routing defects and exits nonzero; run it on the actual source checkout with this section's pinned Node dependencies installed.

**Verify real access (separate from routing):** `GH_TOKEN` must be supplied by an already authorized secret/credential-custody surface with GitHub runner-administration read permission; do not paste or commit it. Run `node generator/generate-ci.mjs /path/to/checkout --audit-runner-access --repo causeway-services/turntide-islands-services-section`. This reuses `receiveRunnerSelection` in the source generator's existing GitHub receiver and inspects the *consuming* repository's online eligible runner identities. It returns `access-unverified` when the registration is absent or the API cannot be read, and exits nonzero. A positive runner response only proves online eligibility at the observation time; a completed job and independent receiving remain necessary. No registration tokens or runner configurations are generated by this audit. `--public-repo` permits intentional public-repository GitHub-hosted jobs to be reported as exceptions. GitHub-hosted jobs in public repositories are free but should be used to isolate untrusted public contributions; **never run untrusted fork PR code on a persistent privileged house machine**. Audit proof is not a running-job receipt. Independently check the actual job's `runner_id`, labels, steps, result, and customer receiving. GitHub-hosted workflow billing and self-hosted machine operating costs are different expense classes.

`Guix` defines the installed machine/release; the registry at `registry.561.group` distributes admitted build inputs. GitHub only coordinates source and execution requests. Correct a routing policy here and in the generated/handwritten callers, not by adding a separate per-repository runner manager.

Caller snippet (`.github/workflows/ci.yml`):

```yaml
name: ci
on: [push, pull_request]
jobs:
  ci:
    uses: red-cup-engineering/continuous-delivery-services-section/.github/workflows/node-package.yml@d160dbac65a830ef89a9b51e06737cc0d9a92bd3
    with:
      runs-on: '["self-hosted","Linux","X64","bare-cedar-fog"]'
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
  Inputs: `directory`, `runs-on` (JSON runner labels), required `supplier-revision` (lowercase 40-hex commit), and the exact composed `tool-workspace-repository`, `tool-workspace-revision`, and workspace-relative `tool-workspace-checker-path`. Required secret: `source-read-token`, an existing read credential for the composed workspace and its recursively selected private source repositories.
  The generated caller must hire `lockfile-fresh.yml@<commit>` and supply that same commit as
  `supplier-revision`; it equals the actual generator revision. The workflow admits the commit grammar before
  checkout and checks that the composed workspace and selected checker Gitlink match their exact revisions. It
  receives the recursively recorded source tree, installs the checker and its declared workspace dependency
  closure with that root's exact PNPM and frozen full lock, then runs the checker against the pull request's
  head/base manifests. Only the composed workspace checkout receives `source-read-token`; head/base metadata
  checkouts use the caller's default token. The caller generator takes the existing secret name through
  `--source-token-secret` and binds it to this workflow secret. The genuine private Git peer remains required at `>=4.1.1`; CD declares its workspace
  source as a development dependency so the checker and source generators resolve the actual mounted owner.
  No package is published to make this source closure installable.
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
    uses: red-cup-engineering/continuous-delivery-services-section/.github/workflows/lean.yml@d160dbac65a830ef89a9b51e06737cc0d9a92bd3
    with:
      working-directory: .
      runs-on: '["self-hosted","Linux","X64","bare-cedar-fog"]'
```

## Caller generator

```
node generator/generate-ci.mjs <repo-dir> [--parent owner/repo] [--pr owner/repo]
  [--ref <40-character supplier commit>] [--runs-on '["self-hosted","Linux","X64","bare-cedar-fog"]']
  [--default-branch main] [--token-secret LMT_SUBMODULE_PAT] [--source-token-secret LMT_SUBMODULE_PAT]
  [--tool-workspace <json-file>] [--branch ci/caller-generator]
  [--verify-commit <40-character received source commit>]
```

Generated callers pin the generator checkout's exact commit (or an explicitly selected commit). Sync callers serialize runs and take the hiring repository's actual runner labels and token secret; the nested reusable workflow comes from the same supplier revision, and its engine checkout is immutable. For an existing lockfile-fresh caller, `--tool-workspace` reads `{ "repository": "OWNER/REPO", "revision": "<40-hex-commit>", "checkerPath": "path/to/checker-gitlink" }`; `--source-token-secret` names the hiring repository's existing read credential and is emitted only as the reusable workflow's `source-read-token` secret binding.

Selects `node-package` (any `package.json`), `lean` (a `lakefile.lean`/`lakefile.toml`, one job per directory) and `content` (JSON with a relative `$schema`, or Markdown with relative links), and writes `.github/workflows/ci.yml`. A repository with `.gitmodules` also gets `sync.yml` (advance on dispatch/schedule); `--parent` adds the push-to-main notify. Handwritten workflows are reported against the reusable workflow that covers them and are never removed. With `--pr`, the working tree is not edited: the generator reads the exact committed source into a temporary directory, then receives its output through the Git data API (`GH_TOKEN`) into a draft pull request. The default review branch is `ci/caller-generator`; `--branch` names an existing owning review branch. Symlinks are refused, and submodule working copies, ignored files and uncommitted edits cannot affect generation. Existing handwritten workflows remain untouched.

## Generated-source receiving

`generator/open-pr.mjs` is the source receiving operation already used by the caller generator. It now requires the target repository, exact generation source commit, review branch, immutable supplier commits and complete regular UTF-8 output files. It binds byte length, SHA-256 and Git blob identity for every output and verifies the complete parent-to-result tree, preserving unrelated files. The source proposal is retained in the resulting Git commit and draft review, not in a second receipt repository.

An existing branch must still name the generation base or the identical previously received proposal. A missing branch can start only from the current default source. A changed branch requires fresh generation from its current head; the operation never rebases generated bytes silently, overwrites another contribution or forces a ref. Identical restart/replay finds the exact prior commit/review without another write. Lost ref or review responses are reconciled at the original destination. Unresolved publication remains an error with that destination retained; it is not permission to publish elsewhere. Closed exact reviews are not silently recreated.

After review, the later build uses the same pinned generator with `--verify-commit` and the same generation options. It reads the proposal from the received commit, requires its single original parent, checks that the full source tree matches the received tree, verifies that only the declared output blobs changed, and regenerates those bytes from the committed source. Different source, supplier or output identities fail parity. This read-only command requires no GitHub credential. A successful source/parity check is not independent review, merge, release or runtime acceptance.

The operation needs an **already authorized** source-writing actuator. Missing `GH_TOKEN`, denied publication, incomplete provider reads, unsupported modes or absent review creation fail visibly; no token, permission, workflow or runner is installed by the generator.

### Machine-generated products

The same receiver contract can consume generated declaration files, but the read-only build is not their source-writing authority. A production binding must retain the exact owning Gitlink, generator/supplier commits, complete generated bytes and input selection/lock identities; admit only its declared output paths; and deliver them to the existing owner review branch through an already authorized writer. That writer must consume the complete artifact without executing artifact-supplied code. Source review and a later ordinary build with no tracked generation drift remain mandatory.

As observed on 2026-10-13, MetroPlat's current workflows provide verification and branch/PR metadata intake, not a source-writing artifact receiver. Bare Cedar Fog's qualifying build has `contents: read`. The reusable submodule-advance writer is hired separately and currently accepts gitlink changes only; its existence does not grant generated-file publication for MetroPlat. This change migrates the actual CI-caller generator; it does not claim automatic MetroPlat descriptor receiving or change that build's source guard. Binding that producer to a qualified existing writer, or explicitly authorizing a new writer within this section, remains required before the model-mediated production handoff can be removed.

## The upward chain

```
section repo, push to main -> notify-parent.yml -> repository_dispatch(section-advanced)
parent repo -> sync.yml -> superrepo-advance.yml -> submodule-advance.yml -> one PR
```

The PR token must be allowed to open pull requests (a PAT, or the repository setting "Allow GitHub Actions to create pull requests"). Pin records only: diverged pins wait for reconciliation (requirement 16).

Tests: `npm test`.

## One path from change to machine

### Approved test-source integration allocation (2026-10-16)

The Leader explicitly approved separating strictly test-only source integration
from machine qualification on 2026-10-16 at 18:27:11 UTC, in response to the
18:26:17 proposal: “strictly test-only changes can merge after independent review,
source tests and exact packaged-artifact receiving”; runtime, dependencies,
workflows, build/deployment policy and mixed changes retain the existing machine
gate, and branch protections stay unchanged. Governing source: original task
`01a12e43-345e-71de-affb-cda1fd6890ee`. This paragraph records that explicit
governing decision; this policy amendment is **not itself test-only** and is not
self-authorized by the exception it defines.

A strictly test-only proposal may merge after **test-source qualification** only
when all of the following are independently established at its exact candidate:

- The complete committed diff changes only existing test files. Production
  modules, manifests, dependency locks, generators, workflow definitions,
  build/deployment policy, admission rules and receiving selections are unchanged.
- The changed files are tests only, not production entrypoints or fixtures consumed
  by runtime/build code. Unknown or mixed consumption is ineligible.
- Tests are not skipped or removed, coverage is not reduced, and failure
  expectations, dependency checks and tolerances are not weakened. A repaired
  positive fixture must satisfy the unchanged production contract; corresponding
  refusal and preservation cases remain tested.
- Independent review relates every changed assertion to the existing production
  contract and accepts the exact source revision. An authenticated full diff,
  the original public source suite and independent execution of the original
  tests from the exact packaged artifact all qualify that revision. Receipts
  bind candidate/tested tree identity, artifact digest and distinct producer and
  receiver jobs. A changed base or candidate requires fresh qualification of the
  resulting tree; prior review can be retained only for demonstrably unchanged
  reviewed bytes and scope.
- The owning pull request records eligibility, independent review and source/
  artifact receipts, and uses an ordinary merge commit under unchanged repository
  protections. Missing evidence keeps it unqualified.

Changes to test selection or execution scripts, generated output, runtime-used
fixtures, production behavior, dependencies, composition, workflows, build or
deployment policy are **not** eligible. Neither a filename under `test/` nor
passing CI is sufficient. Mixed changes and uncertain impact retain the machine
comparison requirement below. This route grants no publication, machine-pin
advancement, installation, deployment, spending or runtime acceptance.

The received stage is **test-source qualification**, never machine
`no-regression`. Tests included in a package remain changed artifact bytes.
Later machine integration and operating acceptance retain their original
Code/Guix/LAGOON obligations. The initial motivating proposal is
[PR #74](https://github.com/red-cup-engineering/continuous-delivery-services-section/pull/74);
its [independent source/artifact review](https://github.com/red-cup-engineering/continuous-delivery-services-section/pull/74#issuecomment-6222054562)
predates this decision and did not itself waive the former gate.

### Approved non-executable source integration allocation (2026-10-16)

The Leader explicitly approved this bounded source-only extension at
18:56:43 UTC on 2026-10-16, responding to the 18:55:11 proposal to integrate
inert requirements/documentation after verifying that they are not loaded or
generated into runtime behavior. Conversation provenance: thread
`01a12e43-345e-71de-affb-cda1fd6890ee`, proposal
`Sentinel_ee403f6fdf3481918d482835d7afe3fb`, approval
`Sentinel_951afdbb8fd08191888386f6f08ca858`. These conversation identifiers
are provenance, not an institutional Task or stage-admission witness.
This governing policy amendment is authorized by the explicit Leader decision,
**not** by the non-executable-source exception it defines; policy changes remain
outside that exception.

A proposal limited to non-executable requirements or documentation may merge
after **non-executable source qualification** only when all of the following
are independently established at its exact candidate:

- Independent review identifies every changed field or passage, its current
  consumers and the exact assessed source/build scope. Within that scope the
  changed content is only preserved, displayed, parsed or schema-validated.
  It is not interpreted as runtime configuration, generation directives,
  build/deployment selections, access rules or integration policy.
  Unknown interpretation within the assessed scope is ineligible; filename,
  location, a documentation label or passing CI cannot establish inertness.
- The complete diff leaves runtime code, executable configuration, generation
  directives, workflows, dependencies, access/admission rules, integration
  policy and receiving selections unchanged. Mixed changes retain their normal
  controls and machine qualification; this route cannot qualify them.
- Independent review accepts the exact source revision and records its evidence
  and scope limits in the owning pull request. The original applicable source
  suite and independent tests from the exact packaged artifact qualify that
  candidate. Receipts explicitly bind the candidate/tested tree, changed
  packaged bytes and artifact digest, and distinct producer and receiver jobs.
  Preservation or copying into a package is still an artifact change requiring
  explicit receiving; source tests alone do not receive the changed digest.
- A changed base or candidate requires fresh qualification of the resulting
  tree. Prior review is retained only for demonstrably unchanged reviewed bytes,
  consumers and scope. Missing evidence keeps the candidate unqualified.
  Integration uses an ordinary merge commit under unchanged protections.

This stage grants source integration only, not publication, machine-pin
advancement, runtime installation, deployment, spending or operating acceptance.
Unknown downstream interpretation is not presumed inert: downstream composition,
installation, pin advancement and integration retain their original gates.
The Code/Guix/LAGOON obligations and applicable runtime comparison remain intact.
A source-only result is never a machine `no-regression` verdict.
The motivating requirement proposal is
[PR #76](https://github.com/red-cup-engineering/continuous-delivery-services-section/pull/76);
its independent consumer review is limited to its qualified source/build scope
and does not qualify a durable executor or any downstream deployment.

### Machine-affecting integration

Except for the two explicitly approved source-only routes above, a house package is made,
tested, received and released along the following path. Runtime, dependency,
composition, workflow, build/deployment-policy and mixed changes retain it:

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
    uses: red-cup-engineering/continuous-delivery-services-section/.github/workflows/change-test.yml@d160dbac65a830ef89a9b51e06737cc0d9a92bd3
    with:
      machine: OWNER/MACHINE-REPOSITORY
      runs-on: '["self-hosted","Linux","X64","bare-cedar-fog"]'
    secrets: { house-read-token: "${{ secrets.HOUSE_READ_TOKEN }}" }
```

## Intentional branch and pull-request work

Automatic branch-to-PR intake is retired. The reusable `agent-work.yml` workflow,
its generated `agent-work-intake.yml` caller, and their old acceptance suite are
no longer installed or generated. Existing branches remain in GitHub; create or
update an intentional review on the owning branch when the work is ready.

The caller generator defaults to CI and synchronization only. Explicit selection
of the retired intake is refused. Generated source still uses the existing
`open-pr.mjs` receiver for an intentional, exact-source draft review, preserving
concurrent owner changes and later regeneration parity. CI exercises those
current generator and immutable-source contracts. The retained
`agent-work-contract` job identifier is a compatibility name, not an active
branch-intake operation.

This retirement does not relax source review, runner admission, or separate
deployment and customer receiving. The machine no-regression merge gate remains
for every change outside the two explicitly approved source-only integration
allocations above; retirement itself creates no exception.

## Reconcile retired branch-intake callers across actual GitHub repositories

The old reusable `agent-work.yml` was retired, but repositories may still
pin immutable *historical* revisions in `.github/workflows/agent-work-intake.yml`.
Changing the current reusable workflow cannot remove those callers.

Use the **existing** generator and GitHub source-receiving API as one fleet
operation rather than opening hundreds of independent chat/tool transactions.
With an already authorized, appropriately scoped `GH_TOKEN`, run:

```sh
node generator/generate-ci.mjs --retire-obsolete-intake-fleet \
  --organizations 561-group,red-cup-engineering,lenticule-science,coesite-operations
# After reviewing the source owner's plan and the token's reachable scope:
node generator/generate-ci.mjs --retire-obsolete-intake-fleet \
  --organizations 561-group,red-cup-engineering,lenticule-science,coesite-operations --apply
```

The same operation is exposed through the public source owner's manually
dispatched [cloud workflow](../.github/workflows/retire-obsolete-intake-fleet.yml).
That hosted job needs a **preexisting** `FLEET_GITHUB_TOKEN` secret, with repository
metadata read, contents read/write, and access to each selected organization.
The GitHub-hosted default `GITHUB_TOKEN` does not grant cross-org private
repository writes; the connector credential from a ChatGPT session is not
transferred to Actions. If that secret does not exist, the workflow refuses
before any remote effect. No additional runner on Cold Red Gate/Bare Cedar Fog
is required for this bounded GitHub-only maintenance.

The provider first exhausts paginated, credential-visible repository lists
(up to 500 records per organization), then checks default branches and native
Git blob identities. The only eligible source is the exact *known* retired
caller file: three previously observed Git blob versions with the original
pinned reusable workflow, branch-push and PR-target triggers. Custom workflows,
archives, forks, inactive repositories, unknown contents, unrelated releases,
and unique open source branches are not touched. No invented `sources.json`,
machine registry or replacement SLC store is written.

Plan mode makes **no** changes. Apply mode refuses any incomplete readable
preflight, bounds effects to 400 eligible source leaves, checks each default
branch HEAD before its exact-SHA GitHub Contents deletion, and reads the file
back independently. A denied/uncertain write is never retried through another
actuator or reported as received. Cloud logs contain aggregate numbers only:
reachable repositories, absent, eligible, unrecognized, unread, removed,
refused and indeterminate. Credential-visible coverage does not establish
organization-global visibility, and workflow removal does not prove all CI,
source-history receiving or application deployment succeeded.

## Publication

`publish-package.yml` owns registry publication for hiring repositories. The caller supplies runner labels and a registry token or registry user/password; authentication configuration contains environment placeholders. Tags are `publish/<organization>/<package>/v<declared version>`; a legacy `publish/<package>/v<declared version>` remains valid only when it selects exactly one manifest. The declared manifest supplies the scope. The tag source must already be in the default branch's history; private packages and the existing SQLite refusal remain intact.

The package is packed once. `receive-registry-package.mjs` compares its digest with authoritative registry metadata before and after publication. An occupied version with different bytes is a refusal, and network/authentication errors cannot be reported as absence or receipt. Machine installation and useful operating receiving remain separate.


## Preserved public compute application

This section owns [Union Free Compute Runner](https://github.com/red-cup-engineering/union-free-compute-runner),
repository ID `1308158077`, transferred from `emsenn/union-free-compute-runner`
without changing its public audience, refs or source history. Its bounded public
source test, six-platform architecture assay and signed Deno assay remain
separate manual entrances. The obsolete pinned automatic branch-intake caller
is retired under this section's exact known-caller contract, not substituted
for those assays.

The application's owned-data correction and actual public-source test receiving
must be received at its source before dispatch. It does not admit private source,
new provider signing credentials, paid runners or a private CI workaround.
Original [GHS P0 #7](https://github.com/red-cup-engineering/github-engineering-services-section/issues/7)
still requires the existing CircleCI project's actual private Git Services
checkout, current Free credit receiving and full original verify result.


This source owner's two automatic public qualification workflows bind their
authored package cache, temporary files, archive, unpacked receiver and resource
observation records beneath `data/logs/public-source-ci-logs` before package
installation or fabrication. Original immutable action pins, test commands,
artifact transfer, receiving assertions and time limits remain intact. `HOME`
and hosted action-internal supplier paths are not reconfigured. This is an
authored-path admission, not confinement of arbitrary test programs or a claim
that other reusable workflows have already received the same migration.
