# Source-owned PNPM package CI
The private AOE consumer has an exact PNPM workspace lock and registry-scoped dependencies. The shared npm-only workflow cannot reproduce that graph. Private hosted Actions capacity is refused, and the repository has no registered runner.

- NP-1. Existing npm callers shall retain their install, check and named-test behavior.
- NP-2. A PNPM caller shall declare an exact stable PNPM version in its source-owned workflow input or package.json packageManager field; missing, ranged or conflicting versions shall refuse before subprocess execution.
- NP-3. PNPM installation shall use the original lock with --frozen-lockfile and --ignore-scripts, preserve source registry and release-age policy, and keep package/lock bytes unchanged.
- NP-4. The workflow shall receive the install implementation from an explicitly supplied immutable revision of this original CD repository, with checkout credentials disabled.
- NP-5. Private read credentials shall be passed explicitly as optional named workflow secrets, restricted to the caller-declared HTTPS registry, and removed before checks/tests.
- NP-6. The install subprocess shall receive no raw credential environment variables, and the credential file shall be owner-only and removed after success or failure.
- NP-7. A PNPM job shall bound network concurrency at four, child concurrency at one, Node heap at 512 MiB and all caches/temporary material under its runner-owned temporary directory.
- NP-8. Runner labels shall identify an actually registered, online, authorized runner for the private consumer; hosted billing refusal shall not route private source to a public source-only provider.
- NP-9. A source-owned structured test argument vector shall reach the original named npm script as literal argv. A separate closed native Node test descriptor shall verify the exact original canonical script and absence of pre/post lifecycle hooks, then place its explicit file-concurrency limit before the unchanged quoted file patterns. It shall refuse mismatched scripts, hooks, mixed argument modes and escaped paths before execution, without mutating an immutable package or using disallowed NODE_OPTIONS flags.

Receiving: unchanged npm workflow tests; executable fake-provider cases for exact pin, frozen lock, credential confinement/removal and failures; a real pinned PNPM frozen install and native AOE tests; actual GitHub runner id/labels/scope and completed exact-source job after independent source review.


- NP-10. Public source-only callers may explicitly select the standard Ubuntu 24.04 or latest runner through the existing generator. Generation and static audit shall use the same finite selector as live admission. Public generation is not evidence of public repository ownership: the existing source receiver shall re-read exact repository identity and visibility before any write and refuse a private hosted selection. Larger, unknown and other platform labels are unsupported, not assumed zero-spend. Private callers and effectful release/sync generation retain house-runner admission. A completed source check remains distinct from packed, installed and live consumer receiving.

- NP-11. Every generated public hosted checker job shall independently require the GitHub provider event to identify this repository as public before allocating its reusable job. The private field must serialize to the JSON boolean false, not a null/missing/string value. Absent visibility, private visibility or a mismatched repository shall skip allocation. This is triggering-event evidence, not a fresh repository observation on reruns; current source-publication admission remains separate and later visibility changes are not proven by the event snapshot.

- NP-12. A package with native qualification tied to an exact Node release shall be able to bind that release through the original caller and reusable workflow; omitted selection retains existing Node24 behavior. The generator shall refuse ranges and command-like values.

## Explicit dependency-free native qualification

World requirement: a public package's dependency-free component must receive its
source-owned native tests without hiring an installer, unrelated detected checks,
or a second package-specific CI implementation. The consumer owns the selected
test's dependency closure; a no-install declaration is not proof of that closure.

- NP-13. The existing generator shall accept a nonempty, unique `checks` subset of `node-package`, `lean`, and `content` only with `workflows:['ci']`, refuse unknown or unavailable selected capabilities, and preserve automatic detection when `checks` is omitted. Omitting this guarantee could silently hire the content check's dependency installer for a dependency-free qualification.
- NP-14. The generator's explicit npm profile shall require `install:false`, `check:false`, explicit bounded package paths, exact `nodeVersion`, a named `testScript`, the NP-9 native descriptor and explicit `timeoutMinutes`; it shall refuse unknown profile fields, PNPM/registry/credential fields, mixed argument modes, and anything other than `checks:['node-package']` with `workflows:['ci']`. Existing default and PNPM profiles retain their behavior. Without this closed profile a typo or ignored input could silently install or execute a lifecycle command.
- NP-15. The reusable workflow shall expose `native-no-install` as an explicit boolean opt-in, default false. The new npm generator profile shall set it true; only that profile shall require the closed npm/native/no-install/no-check combination, exact source equality in both checkouts, exact Node runtime and NP-9's manifest-matching native command without npm lifecycle scripts. Missing descriptors, malformed selectors and changed source shall refuse in this mode, not fall through to `npm run --if-present`. Existing hand-authored `install:false` callers with the opt-in absent retain their prior behavior; absence of indexed search results is not evidence that no such callers exist.
- NP-16. The reusable workflow shall apply a positive integral `timeout-minutes` input in the range 1..360 to both jobs, validating it before source test execution. Omission shall retain the original effective GitHub default of 360 minutes; new no-install generation requires an explicit value. The receiving consumer selects 15 minutes per job, supported by the owner's existing 15-minute bounded checker precedent. For one package this bounds allocated job execution to 30 minutes, not elapsed queue/startup time; for N paths the cumulative bound is `(1+N)*timeoutMinutes`.
- NP-17. Newly generated callers and supplier receipts shall name the original repository's canonical `continuous-delivery-engineering-services-section` coordinate and immutable supplier commit; audits and adoption may recognize the retained historical alias but shall never emit an obsolete `uses` coordinate. No-install callers shall explicitly declare `contents:read` and no secrets. GitHub Actions does not follow repository redirects for reusable workflows.
- NP-18. The reusable workflow shall disable the pinned setup-node action's automatic package-manager cache only for the explicit native-no-install profile and omit an explicit cache override. A dependency-free component with an npm or PNPM root declaration and no lockfile shall not acquire a lockfile or installed-package-manager prerequisite through that action. Other callers retain its prior enabled cache behavior. Setup-node's original tool-version probes are not dependency installation or npm-script execution.

Acceptance: generic selector omission/default controls, selected-only jobs despite
detected content/Lean, malformed/mixed/credential-profile refusals, timeout bounds,
two exact-checkout assertions, unchanged normal/PNPM tests, real named native-test
execution and lifecycle refusal, canonical/legacy caller adoption, and existing
immutable-source receiving/replay/tree-frame/regeneration-parity tests. Exact-head
provider execution and independent source review remain required; this source
contract grants no runner, release, publication, deployment or machine acceptance.
Add explicit cache-input mapping and no-lockfile npm/PNPM-root fixtures, with
legacy install:false and install:true controls. Those source fixtures do not
replace execution of the real pinned action and consumer workflow by the provider.

