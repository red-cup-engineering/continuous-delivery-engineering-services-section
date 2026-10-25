# PNPM CI and runner receiving design
The existing reusable node-package workflow keeps npm as its default. Its opt-in package-manager=pnpm path checks an immutable supplier-ref, checks out this CD source with persist-credentials=false, and invokes its install script. The caller pins the same accepted CD revision in both uses and supplier-ref. Checks/tests run after credential destruction.

Default tests retain the existing named npm script invocation; optional test-arguments carries a bounded literal JSON argv without shell interpretation. Native Node file concurrency cannot be supplied in NODE_OPTIONS, and appending --test-concurrency after the script's glob does not bound file workers. The optional node-test descriptor supplies expectedScript, files and concurrency. It accepts only the canonical original command `node --test` followed by JSON-quoted relative patterns; verifies those exact script bytes in package.json; refuses pre/post hooks, other command forms and mixed argument modes; then invokes the same Node executable with --test-concurrency before those unchanged patterns. This closed entry point neither parses arbitrary scripts nor executes caller commands. It keeps immutable artifact bytes unchanged. Native receiving includes a two-file overlap control that fails under concurrent workers and passes when this interface bounds concurrency at one.

The install script validates an exact source-owned workflow pnpm-version or packageManager pin, the existing pnpm-lock.yaml, the explicit runner temporary directory and optional HTTPS registry identity before execution. Both pin carriers must agree when present; there is no default version. A workflow pin can receive an already-published artifact without changing its immutable package bytes. npm exec bootstraps only that exact PNPM release through the caller's original native npm registry configuration; the PNPM child receives explicit private-registry userconfig and bounded cache/store paths. Installation disables all lifecycle scripts. A private mode-0600 userconfig contains only origin-scoped authentication; environment credentials are scrubbed from the child, captured diagnostics are redacted, and finally removes the userconfig even on failure. It compares package and lock digests after the frozen install. It does not rewrite .npmrc, workspace policy or lock data.

Runner activation is separate host-owned composition. The old BCF superrepo runner was retired; its registration and binaries are absent, so its label alone is not usable capacity. The existing ci-runner-host-service already supports repository scope, exact asset SHA256, just-in-time registration command, bounded work lifecycle and scheduling. Its operational record must use BCF data/state rather than legacy ~/.local. Machine activation must be composed through the wsl-host record/owner; there is no hand-written unit, bashrc or systemd command in this CD repair. The AOE repository-scoped registration uses the existing authenticated GitHub principal and exact registration-token endpoint; no new account, paid capacity or org-wide runner grant is assumed. Registration token stdout stays inside the original installer.

Resource plan: source/test work adds at most 32 MiB and 2,000 inodes in this CD owner's data/logs. A wsl-host capacity observation on 2026-10-23 reported physical backing availability53,235,630,080 bytes. Its legacy3% reserve must not replace the host owner's100GB absolute floor: the governing reserve is the greater floor/share plus growth and overhead. Current physical availability therefore does not admit runner materialization. The snapshot is not a reservation. Runner installation requires fresh host admission before its growing stage: official runner2.338.0 archive227,660,598 bytes, estimated unpacked footprint1GiB, AOE graph/checkout estimated2GiB, own temporary allowance1GiB; peak estimate4.25GiB and50,000 inodes. Actual retained max must be measured against the host budget. One runner executes one job; workflow matrix concurrency must be1 for this allocation. Parent wsl-host memory ceiling and observed pressure remain governing; a unit memory ceiling does not create capacity. No runner materialization or credential write is performed by these source tests.


The public source-only generator now shares the original receiver's finite standard-Ubuntu selector. Its existing publicRepository option controls rendering and static audit, while receiveRunnerSelection still requires an authenticated repository observation with matching full_name and numeric identity. It admits only ubuntu-latest and ubuntu-24.04 for an actually public consumer, never because the shared supplier is public. Unsupported labels fail closed. This repairs the prior composition mismatch where the public audit and receiver accepted a route that renderCi could not produce. Release, sync and private workflows retain their existing admission. The PNPM owner can use an exact-revision shared caller after source qualification; runner admission alone does not qualify toolchain, dependencies, skipped native tests or archive contents.

Public generated jobs carry a job-level provider event visibility/full-name condition in addition to source-receiving admission. GitHub evaluates this condition before allocating the reusable job. toJSON(private) must equal the literal string false to avoid loose null/false equality. Missing/mismatched or explicitly private event records cannot inherit the generation-time public flag. The event is a triggering snapshot, including on rerun, not fresh visibility attestation; source publication separately re-reads current repository identity. House routes remain unchanged.

The optional exact nodeVersion carrier maps to the existing setup-node action through node-version. Its default remains24, preserving existing callers; qualified PNPM consumers select24.19.0 explicitly rather than assuming a moving major establishes original provider identity.

Provider expression semantics follow the original GitHub contexts/expressions contracts: nonexistent properties evaluate to an empty string; loose boolean equality therefore is insufficient. Job-level if is evaluated before dispatch, while github.event remains the triggering payload. References: https://docs.github.com/en/actions/reference/workflows-and-actions/contexts and https://docs.github.com/en/actions/reference/workflows-and-actions/expressions.

## Generic no-install extension (NP-13 through NP-18)

The original generator remains the only producer, and the original node-package
workflow remains the only native test executor. Two alternatives were compared:
(a) special-case a media package, copy its test logic or create another workflow;
(b) express an explicit checker subset and reuse the existing closed native test
descriptor. Choose (b): the selection is an ordinary source-owned CI contract,
not media policy. It changes no PNPM installation rule and embeds no consumer
implementation or private fixture. `checks` selects from detected capabilities;
it never invents a capability. Omission retains detection of all original checks.

The new npm/no-install generator profile is a closed record with packageManager,
paths, install, check, nodeVersion, testScript, nodeTest and timeoutMinutes. It
requires `workflows:['ci']` and `checks:['node-package']`; paths are unique relative
package directories, bounded to 32, with no parent traversal or expression syntax.
No registry identity, credential name, PNPM pin, argument vector or unknown field
is admitted. The existing PNPM profile remains separate. Every selected native
file pattern and expectedScript retains the NP-9 canonical equality. A generated
caller binds its immutable supplier in uses/supplier-ref and source in github.sha,
sets contents:read, and carries no secrets. The workflow checks source identity in
both checkout jobs and validates no-install restrictions before a test can start.
The final existing descriptor gate verifies package.json again and executes the
same Node executable with shell:false. The qualification path performs no
dependency installation, npm-script/lifecycle execution or check-script execution;
the original setup-node action may still query installed tool versions.

The reusable `install:false` interface existed before this generator profile.
Changing every direct no-install caller to require a descriptor would silently
break that supported contract even though the old generator never emitted it.
An indexed bounded search returning no callers cannot establish their absence.
Choose explicit `native-no-install` (boolean, default false), not a global
reinterpretation of install:false or an unqualified fleet migration. The new
closed generator profile emits true. Its strict admission, source and actual-Node
checks apply only under that flag. Existing direct callers retain their original
install/check/named-script/optional-native-descriptor semantics when it is absent.

Independent review traced the exact pinned setup-node supplier and rejected the
first candidate's implicit automatic-cache selection. Its action.yml defaults
package-manager-cache to true; main.ts detects npm, yarn or pnpm in the root
manifest; cache-restore.ts requires a lockfile and cache-utils.ts queries the
package manager's cache/store path. Thus even an npm-only workflow could try PNPM
when the package root declares it, or fail because a dependency-free package has
no lockfile. The workflow now passes `package-manager-cache: !inputs.native-no-install`
and no explicit `cache`, preserving prior cache behavior for every legacy caller.
In strict mode no restore state is retained, so the action's post hook does not
save a package cache. This does not replace the action or change its pin. Its
util.ts still probes node/npm/yarn --version; the contract deliberately does not
claim there is no package-manager process at all.

Source verification covers the exact action-input expression, absent override,
strict-native fixtures with npm/PNPM root declarations and no lockfile, and the
legacy install:false named-script continuation. Independent provider execution
must still verify the real action and no-install consumer; the fixture is not a
fake action implementation or a claim that the complete workflow has run.

Timeout is execution resource selection, not a universal house allocation:
GitHub documents an omitted job timeout of 360 minutes. The reusable input keeps
that effective default for existing npm/PNPM callers. The supported explicit
domain is integral 1..360; the selected dependency-free receiving uses 15 minutes
for each of discover and its one package, matching the existing lockfile-fresh
checker precedent. The sum is 30 allocated-job minutes for that one-path recipe;
N paths sum to `(1+N)*timeoutMinutes`. Queue/startup delays and provider cancellation
latency are not a wall-clock termination theorem. A timeout produces a failed or
cancelled provider attempt, never a passing receipt; reconcile that original run.

Canonical repository identity is `red-cup-engineering/continuous-delivery-engineering-services-section`
(GitHub ID 1410813101). The historical alias identifies the same original owner but
cannot be hired through GitHub Actions redirects. New `uses` strings and supplier
receipt identities are canonical. Audit and lockfile-caller adoption recognize
both exact coordinates, preserve unrelated policy, and emit only the canonical
one. Existing immutable-source proposal, complete tree-frame verification and
later byte parity are unchanged: changing an input requires fresh receiving.

Environmental expectations: the caller repository is independently observed as
public for standard hosted execution; the selected exact Node release is available;
the authored tests really need no dependencies; official action pins remain
received suppliers; and the original provider supplies trustworthy checkout/run
evidence. Source selection and JSON identity are not an execution authority grant.
Verification is split between generator/descriptor/refusal unit contracts and
the original provider's exact-head no-install job, followed by consumer receiving.

Primary provider contracts:
- https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idtimeout-minutes
- https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations
- https://github.com/actions/setup-node/blob/a0853c24544627f65ddf259abe73b1d18a591444/action.yml
- https://github.com/actions/setup-node/blob/a0853c24544627f65ddf259abe73b1d18a591444/src/main.ts
- https://github.com/actions/setup-node/blob/a0853c24544627f65ddf259abe73b1d18a591444/src/cache-restore.ts
- https://github.com/actions/setup-node/blob/a0853c24544627f65ddf259abe73b1d18a591444/src/cache-utils.ts
- https://github.com/actions/setup-node/blob/a0853c24544627f65ddf259abe73b1d18a591444/src/util.ts

