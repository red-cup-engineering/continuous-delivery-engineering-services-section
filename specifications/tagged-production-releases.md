# Tagged production releases

Requirement owner: Bare Cedar Fog machine deployment. Engineering implementation:
[computer-deployment-engine issue 48](https://github.com/red-cup-engineering/computer-deployment-engine/issues/48).

Leader, 2026-10-19: move from "shit monitors main to deploy stuff" to "proper
release tags" and current industry practice. Authored by Codex in engineering
execution; the authenticated GitHub account is separate from that authorship.

## Requirements

Production deployment MUST select a published immutable host release, rather than
a default-branch landing or a controller startup. A stable SemVer tag in the host's
own repository identifies its exact host commit. Its checksum-bound release asset
binds the composition, agency, source paths, qualified native product and artifact
digests. Package versions and host release versions are independent.

The existing builder service MUST deploy the already formed and qualified native
product without installing packages, projecting an agency or rebuilding the
machine. Each deployment obtains fresh native target lease, live snapshot,
capacity admission and health-gated receiving. Credentials and persistent state
remain outside the product. Existing profile generations and recovery custody
remain retained during this migration.

Default-branch publication and composition MAY continue preparing candidates.
They do not authorize production activation. Missing releases, missing assets,
changed tags or checksums, interrupted attempts and profile/record disagreement
cause an explicit hold; no fallback to main or automatic uncertain-effect replay
is allowed. An explicit native rollback also holds automatic promotion until its
record and release selection are reconciled.

## Design

Replace the existing `release-on-landing.service` selector in this machine's
declaration with LAGOON's immutable host-release reconciler. Retain its historical
unit identity and resource; introduce no second deployment loop or timer. Read
published release metadata through the existing authenticated GitHub CLI. The
Cold Red Gate target uses `561-group/cold-red-gate-services-section`, its actual
host source, rather than a filtered deployment bundle or inventory repository.

The selector is an independent auxiliary. The native main unit Wants its long-running auxiliaries, so a stopped selector may start with main before its health gate. Successful native activation then explicitly restarts the changed selector, replacing its invocation; other independent auxiliary invocations are preserved. The target's qualified product, lease, native receiving and health gate protect CRG activation independently of the builder's MetroPlat HTTP readiness. Installed receiving verifies this actual startup behavior and the loaded selector, without claiming an after-health-only start.

The target declarations live in `deployment/release-targets.json`, copied through the existing native deployment declaration. Scheme reads that configuration data; remote profile observation strings are not native builder inputs.

The release product lives in the native Guix store with explicit roots; its small
descriptor is a release asset. The original Guix closure copy transports the same
immutable artifacts to the target. A release descriptor contains no deployment
lease token or expected-live snapshot. LAGOON's shared product and controller
contracts own validation and replay behavior; this host declaration supplies the
target and existing operating resources.

## Receiving

Source receiving proves the declaration selects the released controller and
preserves unrelated declarations, credentials and jobs. Frozen registry receiving
and native machine formation prove the selected provider actually exists in the
immutable output. Installed receiving then proves: main changes and restart alone
do not activate; a published release selects its exact source and artifact tuple;
duplicate observation does not reactivate; uncertainty and rollback hold; the
ordinary native receiving keeps useful MetroPlat operations and persistent state.
Source acceptance alone does not establish any of those operating outcomes.

## Receiving the composition policy consumer

The first immutable-selector bootstrap retains its fixed qualified source and
preserves unrelated auxiliary invocations. After that bootstrap is independently
received, a qualified successor also replaces `compose-on-publication.service`
through the existing native `restart-units` lifecycle after the exact new main
artifact passes its health gate. This replaces the process that applies Guard's
nested dependency policies. Selecting the package in a manifest or replacing
Cold Red Gate's publisher does not load those policies in this BCF process.

Keep the existing composition unit identity, credential receiver, registry,
organization scope, state directory and journal cursor. Keep it independent of
main stop propagation; add neither a second composer nor another clock. The native quiescence hold blocks main Wants, rollback and boot from admitting
a replacement before the captured old invocation has been received as drained.
The explicit replacement remains after main health. Do not thaw the superseded main-watching
deployment selector to perform this change.

Before profile or unit-file replacement, LAGOON captures the actual old PID,
InvocationID and cgroup, verifies independent stop custody, and fsyncs a private
profile-owned hold and persistent systemd condition drop-in. Loading the selected
new ExecStop carrier does not replace the old interpreter: its existing exact
journal-reader closure drains pending and queued asynchronous batches, commits
their original cursor, and exits. The qualified GHS carrier verifies that source
and exact child identity before closing only that reader.

The caller allocates 60 seconds to that drain inside the unit's finite 90-second
stop budget, leaving 30 seconds for native termination and fencing. HTTP work has
a 30-second deadline, while a PNPM operation can take 900 seconds; therefore this
allocation deliberately permits refusal. A timeout may terminate old work. It
never cancels the stop or manufactures success. Before final worker admission,
LAGOON requires a fresh private receipt bound to the original invocation, no
unknown Git result, a terminal unit and a hierarchically unpopulated captured cgroup. Missing or
inactive legacy processes alone do not reconcile interrupted effects.

A refused, stale, unknown or missing receipt leaves the durable hold in place
through generic activation failure, restored old unit files, rollback and boot.
The original source checkout, cursor, native journal and Git/ref subjects remain
in their existing custody. Reconcile uncertain writes against original expected
heads and receive the exact old cohort before its custodian clears that hold.
No timer, reset-failed, process absence or new activation clears it. The hold remains through main health and every reload/receive hook; only final worker start releases it. Any subsequent activation failure installs a fresh hold before stopping that possible new invocation, and rollback never automatically resumes the old worker. This is the
existing deployment owner's gate, not another controller or daemon.

The native product's existing installed-profile receiving driver must inspect
the generated compose unit and its exact selected GHS provider, the retained
credential/state bindings and independent stop relationships, and read the
authoritative native restart list with Scheme. After promotion, separately
receive a new composition invocation actually loading that provider and resuming
the retained cursor. Follow a genuine publication through ordinary composition:
uncovered nested policies hold the affected advance, authored coverage permits
it, and unrelated safe advances remain possible. Source tests and a generated
unit alone do not discharge this operating condition.

## Fabrication storage

Leader, 2026-10-19: data hygiene belongs in code-system fabrication, across Cold
Red Gate, the laptop and cloud buckets. The source-owned `host-usage.json` beside
this machine declaration supplies existing LAGOON headroom inputs and explicit
stage estimates. It enables no directory scan and no cleanup timer. Its mixed
recovery parent is protected, not declared disposable by age.

Before growing a stage, the fabrication owner admits peak bytes and inodes on the
actual destination filesystems, combining simultaneous allocations on the same
filesystem and preserving the free share and growth allowance. Capacity samples
and peak estimates are not reservations or quotas against concurrent writers.
Missing budgets and insufficient measured headroom refuse before materialization.
Fresh checks between stages and the original native store guard remain required.

Reuse the qualified physical PNPM graph; source materialization has its own small
allowance and does not cover Guix import/build peaks. Keep a qualified product and
provenance in durable product custody, separate from reproducible intermediates.
Exact staging retirement requires its owner's source, custody, process, lease,
live and rollback reference decisions. `retention.mjs --no-gc` still retires
generations and is outside this migration's authorized cleanup. Null owner
commands expose missing safe cleanup capability; they authorize no deletion.

Bare Cedar Fog self-promotion remains an explicit tagged-product operation through
the original local native receiver. Its controller does not deploy its own builder.

## External basis

[GitHub immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
lock the published tag and attached assets. GitHub recommends preparing a draft,
attaching every asset, then publishing. [SLSA provenance](https://slsa.dev/spec/v1.2/provenance)
provides the basis for retaining verifiable source-to-artifact information. These
are design references; this migration does not assert a SLSA certification or level.

## Qualified successor graph

The ordinary publication composer selected CDE0.3.0, GHS0.2.0, Metro0.10.2,
Console0.1.6, CSE0.1.12 and SEAVT0.3.1 in the actual source manifest and generated
lock. The product's installed receiving must resolve the CSE wire-dispatch owner
relative to Metro's actual presentation/serving module, and prove it is the same
received provider used by FeltOS actor processing. A root-level dependency pin
does not establish that loaded consumer closure.

The obsolete selector's WSL-owned persistent quarantine remains independent of
this source change and of LAGOON's managed composer drain. Installing a new
product does not by itself release that quarantine; its original owner must
receive the exact installed controller/product and original unknown effects
through the separately selected receiving Resource. No source test here performs
fabrication or grants a production start.

The publication successor selects GHS0.2.1, preserving the received composer
drain contract and the accepted exact-current-tree branch classifier. Its
generated TypeScript publication operation consumes Code0.14.19 through the
GitHub provider's actual package scope. Installed receiving must resolve that
specific supplier and import its public source-build qualification operation;
the independently selected runtime-root Code edition is not evidence for this
consumer. Native registry receiving and frozen installation must precede machine
formation. Actual publication, installed catch-up and the long-running Cold Red
Gate publisher remain separately received operating effects.

## Receipt recovery and consumer qualification

Leader, 2026-10-20: "Then fix why MetroPlat isn't returning receipts and finish the runtime uptake. Recording the next step isn't seeing the work through to Done."

Leader, 2026-10-20: "Our production workflow should not require a pnpm workspace or lockfile for every repository. It should MAYBE require a package.json"

This repair selects independently published ActivityPub0.10.0, CSE0.1.15 and FeltOS0.21.9-dev.0. Its coherent upstream graph also selects CDE0.3.1, GHS0.2.3, Metro0.10.2, Console0.1.7 and Inference0.2.3. Installed receiving MUST resolve Code0.14.20 through the actual GHS0.2.3 publication consumer, preserve Console0.1.7's Organizing0.2.3 law and receive Inference0.2.3 through its selected Organizing0.7.2 supplier. Provider publication MUST consume their explicit source manifests and fabricated artifacts without requiring provider workspaces or locks. This BCF deployment owns its own exact frozen dependency graph and authored policy because its actual native consumer needs them.

The authored policy MUST select FeltOS0.21.9-dev.0 at the driver and peer consumers, CSE0.1.15 through both FeltOS actor processing and Metro0.10.2 wire presentation, and AP0.10.0 through each of those actual receipt consumers. Their qualified Organizing0.7.2 law selections remain scoped to those editions; unrelated historical caller laws remain authored and distinct. Package manifest pins alone do not establish those loaded suppliers when workspace policy overrides them.

Installed receiving MUST resolve the selected versions relative to the actual FeltOS and Metro entry modules, verify the shared CSE and ActivityPub receipt consumers and their original public exports, and exercise terminal malformed-request refusal independently from transient supplier failures. A typed terminal protocol refusal yields one persisted correlated actor receipt; an operational failure retains retry behavior. Actor state and admitted governing uptake MUST survive native restart. Existing independent native product, health, quarantine, quiescence, release publication and customer operating receiving gates remain required. No source test or receipt file stands for their useful live result.

The source-owned receipt-recovery-fabrication-storage.json record declares sequential packing, lock and frozen-consumer stages and a separately unsealed native-product estimate. Exact accepted source, graph identity and v0.1.1 host release selection MUST seal the native stage before formation. Preserve the existing physical100GB Codex floor, native WSL reserve and growth policies; neither guest free space nor deleting staging proves backing-volume reclamation.
