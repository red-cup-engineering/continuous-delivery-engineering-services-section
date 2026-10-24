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
