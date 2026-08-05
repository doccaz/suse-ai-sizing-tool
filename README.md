# SUSE AI Sizing Architect

An interactive, browser-based planning tool for estimating the **compute, memory, storage, GPU and network** footprint of a [SUSE AI](https://www.suse.com/solutions/ai/) deployment — before you provision a single node.

🔗 **Live demo:** https://doccaz.github.io/suse-ai-sizing-tool/

![Built with React](https://img.shields.io/badge/React-18-30BA78)
![No build step](https://img.shields.io/badge/build-none-30BA78)
![Deploy](https://img.shields.io/badge/deploy-GitHub%20Pages-30BA78)
![License](https://img.shields.io/badge/license-MIT-30BA78)

---

## Overview

The SUSE AI Sizing Architect lets you model a cluster, attach SUSE AI services and your own custom workloads, and instantly see whether your hardware has enough headroom. It runs entirely client-side — no backend, no data leaves the browser — and is delivered as a single self-contained `index.html`.

## Features

- **Multi-cluster fleet** — model a whole deployment, not just one cluster. An in-tab **cluster switcher** lets you size several **downstream** SUSE AI clusters, a suggested **Rancher Management** cluster (HA defaults, on by default), and a dedicated **Observability** cluster. Every cluster is independently toggleable; the sidebar shows both the selected cluster's totals and a **fleet rollup**, and the diagram / virtualization / PDF aggregate across the fleet.
- **Suggested specialised clusters** — when you enable **SUSE Observability** on a workload cluster, the tool recommends moving it into a dedicated, right-sized Observability cluster (one click; reversible via *Merge back*). The Rancher Management cluster is pre-seeded with HA control-plane defaults (3 × 4 vCPU / 16 GB).
- **Base node sizing** — control plane plus GPU and general-purpose worker groups, with sensible SUSE-recommended defaults. Each group can be **enabled or disabled** independently, so a CPU-only deployment can simply switch the GPU worker group off and have it drop out of every total.
- **Reusable node profiles** — define named per-node sizes (Small / Medium / Large / GPU, or your own) once and assign one to a group from a dropdown. This makes it easy to balance **scale-up** (fewer, larger nodes) against **scale-out** (more, smaller nodes): change the profile or the node count and the totals update instantly. Editing a profile propagates to every group that uses it.
- **Per-group fault tolerance** — add **N + x spare nodes** to any group to provision HA headroom; the spares are cloned from the group's profile and counted in all capacity totals (e.g. `4 nodes (3+1 FT)`).
- **Per-node configuration** — flip any group into per-node mode to give individual nodes distinct CPU / RAM / storage / GPU values, and add or remove nodes freely.
- **SUSE AI services** — NeuVector (Security), Longhorn (Storage), Private Registry, Milvus, Ollama, Open WebUI and Observability, several with selectable sizing profiles.
- **Custom applications** — add arbitrary workloads so their resource demand is folded into every total. A built-in **App Catalog** offers common workloads, plus an optional **AI sizing lookup** for anything not listed: bring your own API key for **Anthropic (Claude)**, **OpenAI (GPT)** or **Google (Gemini)** and the model estimates conservative CPU / RAM / storage / GPU. The key is stored only in your browser and sent directly to the chosen provider — never to any backend — and calls are billed to your own account.
- **Bare-metal virtualization sizing** — plan the SUSE Virtualization (Harvester) hosts that run SUSE AI. Define one or more **physical host types** (sockets/cores/threads, RAM, storage, GPUs, optional hypervisor reservation), set CPU/RAM overcommit and an N+x resiliency policy, and the tool treats every cluster node as a VM to derive sizing. **GPU VMs are pinned 1:1** (never overcommitted) automatically. Two modes: **Auto** (how many identical hosts are needed, with per-host utilization in normal and degraded states) and **Pool** (capacity-check a mixed/heterogeneous inventory, reserving the largest hosts for failure). Supports extra VMs, external storage arrays (FC / iSCSI / DAS / CSI / NFS), and multi-site DR. Full formulas, assumptions and references are documented in [METHODOLOGY.md](METHODOLOGY.md).
- **Hypervisor platform overhead** — pick your platform (**SUSE Virtualization / Harvester**, OpenShift Virtualization, vSphere/ESXi, Nutanix AHV, Proxmox VE) and the real management-plane cost is applied automatically: per-node kubelet reserve, platform and storage pods, cluster services, per-VM hypervisor overhead, storage-engine memory and per-GPU passthrough. Harvester is modelled in depth and **calibrated against a measured single-node vs 3-node benchmark**, with toggles for rancher-monitoring, rancher-logging, the Longhorn V2 data engine and the GPU stack. Cluster services are counted **once**, not per node, so overhead does **not** scale linearly with cluster size — an "Overhead by Cluster Size" table shows the curve. Figures are denominated in **scheduler requests** (what actually blocks VM placement); memory that is consumed but never requested — chiefly Longhorn's replica engines — is tracked separately and enforced by its own design rule, so the tool won't recommend a host that OOMs. **Every coefficient is cited and marked Verified, Measured or Estimate**, and **every one is editable**. Selecting a platform never alters your overcommit ratios. Each platform also carries a **model-completeness** marker: Harvester is *Calibrated* against measurement; the others are *Modelled* — every significant category is covered (management plane, storage service, per-node and per-VM terms) but from vendor documentation and shipped manifests rather than measurement, so treat cross-platform comparison as indicative of shape rather than a benchmark. OpenShift Virtualization's coefficients come from the KubeVirt/HCO/CNO manifests and its own node auto-sizing script, so its control plane is counted **once per cluster** rather than per node.
- **Live totals** — a sticky sidebar shows total capacity vs. demand and remaining headroom in real time, flagging GPU deficits automatically.
- **Architecture diagram** — an auto-generated visual of your cluster and the services running on it.
- **Network & firewall rules** — the required ports are derived from your selected components.
- **PDF report export** — a multi-page report (fleet summary with a per-cluster breakdown table, architecture, virtualization host sizing, network tables) generated in-browser.
- **Save, load & share** — auto-saves to your browser, exports/imports JSON, and produces a share link that encodes the entire configuration in the URL.

## Tech stack

| Concern | Choice |
| --- | --- |
| UI | React 18 (UMD) + Babel Standalone (in-browser JSX) |
| Styling | Tailwind CSS (CDN) with a custom SUSE-green dark theme |
| Fonts | Inter + JetBrains Mono |
| PDF | jsPDF + jspdf-autotable + html2canvas |
| Hosting | GitHub Pages (static, no build) |

Everything loads from CDNs, so there is **no build step** — open `index.html` and it works.

## Running locally

Because the app is fully static you can simply open the file:

```bash
# clone, then open in your browser
git clone https://github.com/doccaz/suse-ai-sizing-tool.git
cd suse-ai-sizing-tool
xdg-open index.html      # or just double-click it
```

Or serve it (recommended, so relative asset paths resolve identically to production):

```bash
python3 -m http.server 8080
# visit http://localhost:8080
```

## Deployment (GitHub Pages)

This repository ships with a GitHub Actions workflow (`.github/workflows/deploy.yml`) that publishes the site automatically on every push to `main`.

1. Push the repository to GitHub.
2. In **Settings → Pages**, set **Source** to **GitHub Actions**.
3. Push to `main` (or run the workflow manually) — the site goes live at
   `https://<user>.github.io/<repo>/`.

> The Pages URL is derived from the repository name. With this repo named
> `suse-ai-sizing-tool`, the site is served at `https://doccaz.github.io/suse-ai-sizing-tool/`.
> To serve it at `https://doccaz.github.io/suse-ai/` instead, rename the repository to `suse-ai`.

## Configuration

Two constants at the top of the `<script>` block in `index.html` are meant to be edited:

```js
const GITHUB_URL  = "https://github.com/doccaz/suse-ai-sizing-tool"; // "Fork on GitHub" ribbon
const APP_VERSION = "2.4.0";                                          // shown in footer & About
```

## Project structure

```
.
├── index.html                 # the entire application
├── METHODOLOGY.md             # sizing formulas, assumptions & references
├── test/                      # test suite (see test/README.md)
│   ├── run.sh                 # ./test/run.sh runs everything
│   └── golden-baseline.json   # sizing output captured pre-v2.5.0
├── assets/
│   ├── suse-ai-neg-green-stacked.svg   # header/About logo (dark theme)
│   └── suse-ai-pos-green-stacked.svg   # PDF/light-background logo
├── .github/workflows/deploy.yml
├── .nojekyll
├── LICENSE
└── README.md
```

## Tests

The app has no build step, so the tests **extract the real functions out of
`index.html`** and run them under Node — they cannot drift from the code.

```bash
npm install --no-save @babel/core @babel/preset-react puppeteer-core
./test/run.sh
```

They cover the JSX compiling, the sizing maths (anchored on Harvester's
published 16-core → 1020 mCPU example), import compatibility with older saved
configurations, docs-vs-code citation consistency, a golden-baseline regression,
and a headless-Chrome smoke test. See [test/README.md](test/README.md).

## Version history

The commit history tracks the evolution of the tool from its first app.new scaffold to the current revamp:

| Date | Version | Highlights |
| --- | --- | --- |
| 2025-07-17 | React scaffold | Initial app.new React project — profile-based sizing with PDF export |
| 2025-07-18 | Single-file baseline | Consolidated into a self-contained `index.html` |
| 2025-07-22 | PDF + per-node | PDF report export and per-node resource sizing |
| 2025-07-23 | Custom apps | User-defined workloads folded into the totals |
| 2025-08-08 | Individual nodes | Full per-node configuration across all groups |
| 2026-06-14 | **v2.0.0** | Dark SUSE-themed UI, unified features, save/share, GitHub Pages CI |
| 2026-06-23 | **v2.1.0** | Virtualization tab: bare-metal SUSE Virtualization (Harvester) host sizing — multiple host types (auto & mixed-inventory modes), automatic GPU VM pinning, overcommit, fault tolerance, optional hypervisor reservation, external storage and DR; documented in METHODOLOGY.md |
| 2026-06-24 | **v2.2.0** | Cluster Sizing: reusable named node profiles (scale-up vs scale-out), enable/disable any node group (CPU-only deployments), per-group N+x fault tolerance, and a lower control-plane default (4c/8g) |
| 2026-06-24 | **v2.3.0** | Multi-cluster fleet model: in-tab cluster switcher, suggested Rancher Management cluster, dedicated Observability cluster (suggested when the service is added), per-cluster + fleet rollup totals, and fleet-wide aggregation across the diagram, virtualization and PDF report |
| 2026-06-24 | **v2.3.1** | Consistent all-vector PDF report (Helvetica) with a shared header/footer, page numbers and a vectorized fleet-summary page |
| 2026-06-24 | **v2.4.0** | App Catalog AI sizing lookup is now multi-provider (bring-your-own-key for Anthropic, OpenAI or Google Gemini), with a per-provider key store and an explanatory tooltip |
| 2026-08-04 | **v2.5.0** | Hypervisor platform overhead model: selectable platform (Harvester, OpenShift Virt, vSphere, AHV, Proxmox) applying per-node, control-plane, per-VM and per-device overhead; Harvester add-on toggles; per-coefficient sources with Verified/Estimate provenance in the UI and PDF; "Overhead by Cluster Size" comparison table. Configurations saved before this release load with no platform selected, so their numbers are unchanged until you opt in |
| 2026-08-05 | **v2.12.2** | Swept the remaining user-facing prose for stale platform assumptions — sentences written when Harvester was the only modelled platform and then rendered for all of them. A vSphere user was told their host-local storage was **SUSE Storage / Longhorn** and their cluster services were **Rancher, CDI and the KubeVirt operators**; both sentences now name the selected platform's own components (vSAN / vCenter, the CVM / Prism Central, Ceph-ZFS / corosync, ODF / the CNV operators). The "not modelled" callout no longer promises the total is a **lower bound**, matching the correction already made in METHODOLOGY and the PDF. The coefficient legend documents the **measured** tier it had been rendering without explaining, and the raw-capacity upgrade prompt no longer names RKE2/KubeVirt/Longhorn as though every platform ran them. Platform prose now lives in one `PLATFORM_WORDS` table that the tests assert stays in step with the model |
| 2026-08-05 | **v2.12.1** | Fixed the overhead panel and the PDF provenance footnote describing every platform in Kubernetes terms. vSphere, AHV and Proxmox have no pods and no scheduler-request layer, but both surfaces said "per-node platform pods" and "figures are scheduler requests — what blocks VM placement" regardless of selection; they now say **host consumption — what is reserved and what is used are the same thing**. The PDF footnote also stopped asserting Harvester's no-kubelet-memory quirk on platforms that do reserve memory, stopped calling uncalibrated totals a **lower bound** (the direction of the error is not uniform), and now states the real basis for a Modelled platform. The PDF suite generates a second report on a non-Kubernetes platform and asserts none of those claims reappear |
| 2026-08-05 | **v2.12.0** | Provenance pass on the doc-sourced platforms, and the first test coverage they have ever had. **vSphere:** Broadcom has published no per-VM overhead table or formula since ESXi 5.1 — the current page says overhead "depends on a large number of factors" and directs you to read `VMMEM` from `vmware.log` — so the per-VM coefficient is now labelled for what it is, an explicit linear approximation with no vendor arithmetic behind it, with the measurement path documented. The vCenter override controls no longer advertise the table placeholder as their default. **AHV:** the CVM is not a constant — Nutanix sizes it as base + per-feature increments capped at +16 GB, so **Redundancy Factor 3** and **capacity-tier deduplication** become toggles (~8 GB each, together hitting the cap), both off by default since a plain RF2 cluster does not pay them. **Tests:** vSphere, AHV and Proxmox totals are pinned at the reference configuration, the vCenter step table is asserted at both ends, and the § 7a.1b comparison table is now reconciled with what the engine actually computes |
| 2026-08-05 | **v2.11.0** | OpenShift Virtualization overhead re-derived from the **shipped manifests** instead of a sizing blog. The model previously charged the whole CNV control plane per node; only `virt-handler` is a DaemonSet, so virt-api, virt-controller, virt-exportproxy, CDI, HCO and the operators moved to the **cluster scope and are counted once** — the same singleton correction Harvester got in v2.5.0. Per-node terms are now the declared DaemonSet requests (virt-handler 10 m/325 MiB, ovnkube-node 125 m/1650 MiB), and OpenShift's own **node auto-sizing script** is transcribed verbatim as a Term A reserve — the only platform whose kubelet reserves *memory* as well as CPU (16 GiB on a 512 GB host). Red Hat's published "+2 cores per node" is kept as a **consumption-basis cross-check**, not a scheduler request, because charging a recommendation-with-headroom as a request double-counts. Cluster monitoring is sourced the same way, from `cluster-monitoring-operator` `assets/`. Net effect at 20 nodes: CPU down ~18%, RAM up — the direction the methodology previously claimed was impossible, so the "uncalibrated platforms understate" caveat has been corrected too. First non-Harvester platform with test coverage |
| 2026-08-05 | **v2.10.0** | Harvester's platform coefficients recalibrated from a live v1.8.1 cluster, decomposed **by workload kind** — DaemonSet means per-node, Deployment/StatefulSet means cluster-wide — which measures the split directly instead of inferring it from an algebraic fit. Two corrections: the **add-on per-node RAM was 20–50× too high** (rancher-monitoring 1.5 GB → 0.03 GB per node, its real cost being Prometheus/Grafana/Alertmanager once per cluster), and the **cluster-wide term was 3–4× too small** (0.99 thr / 2.27 GB → 3.875 thr / 7.135 GB), because the earlier figure came from a *single-node* cluster where none of the HA replication exists — coredns, virt-api, virt-controller and the CNI operator each run 2 replicas once there is more than one node. The per-node term was independently confirmed by both clusters, agreeing to 0.03%. Prediction error against the lab drops from −19% CPU / +23% RAM to **+5% / +12%**. The model now targets multi-node HA clusters and deliberately no longer reproduces the single-node v1.7.1 benchmark; coefficients reflect **v1.8.1 with kube-ovn**, and a lighter CNI such as canal will cost less (see METHODOLOGY.md § 7a.10) |
| 2026-08-05 | **v2.9.0** | Validated against a **live Harvester v1.8.1 cluster** (read-only), which confirmed the kubelet-reserve formula exactly at 24, 32 and 4 threads against the real kubelet config; Longhorn's 12%-of-allocatable on two node sizes; that `capacity.memory == allocatable.memory` (no kubelet memory reservation) and that Longhorn requests no memory at all; every hard-coded setting; and the per-VM formula against **10 real virt-launcher pods, worst error 0.0004%**. It also falsified two details, both now fixed: **VFIO is 1 GiB per passthrough *VM*, not per device** (a live 2-device guest pays exactly 1 GiB — KubeVirt's branch is a boolean), and **page tables follow the memory request, not the guest size** (a 32 GiB guest at 150% overcommit requests 21.33 GiB and costs 550 MiB, not 570). Numbers change for multi-GPU guests and for anyone using memory overcommit |
| 2026-08-04 | **v2.8.0** | Per-VM overhead now implements KubeVirt's own [`GetMemoryOverhead()`](https://github.com/kubevirt/kubevirt/blob/main/pkg/virt-controller/services/renderresources.go) instead of approximating it: 220 MiB of fixed components (verified identical in v1.6.3 and `main`) + guest RAM/512 for page tables + 8 MiB/vCPU + 8 MiB IOThread + 32 MiB graphics, times `AdditionalGuestMemoryOverheadRatio` — **1.5 on Harvester, 1 on OpenShift**, which is the entire reason a guest costs ~1.5× more on Harvester. Tier upgraded to **Verified** for both platforms, and for the 1 GiB VFIO/GPU term. Applied to the benchmark's 2 vCPU / 2 GiB guest the formula gives 420 MiB against 421 MiB measured — two independent lines of evidence agreeing to 0.25%, neither fitted to the other. This supersedes Red Hat's published `(1.002 × RAM) + 146 MiB + 8 MiB/vCPU`, which is the same calculation with a dated fixed term. Per-VM RAM rises ~5% for Harvester and falls ~33% for OpenShift |
| 2026-08-04 | **v2.7.0** | Overhead models completed for the non-Harvester platforms. Added the management plane (**vCenter**, sized from Broadcom's published deployment-size table by cluster size; **Prism Central**; Proxmox cluster services; OpenShift's 3 × 4 vCPU/16 GB control plane) and the **storage services** (vSAN, Ceph, ODF) — the latter expressed per TB of raw disk and dropping to zero on external storage. OpenShift gains the KubeVirt per-VM CPU term. Platform depth markers reworked: Harvester is **Calibrated**, the rest are now **Modelled** rather than partial/indicative. The remaining differences between platforms are architectural (Longhorn *reserves* CPU from the scheduler; vSAN and Ceph merely consume it) rather than gaps — see METHODOLOGY.md § 7a.1b |
| 2026-08-04 | **v2.6.0** | Harvester overhead recalibrated against a [measured single-node vs 3-node benchmark](https://gist.github.com/Vicente-Cheng/ae8d5ce743f94c0c9a333574813bc777). Four corrections: cluster services are now counted **once**, not per node (a 3-node cluster measures 2.19× a single node, not 3×); per-VM overhead raised 166 → 421 MiB and given a CPU term; Longhorn's storage-engine memory (~136 MiB per replica per VM disk) added as a physical-RAM term with its own design rule; Longhorn's 12% is of *allocatable*, not capacity. New **Measured** provenance tier, and overhead is now explicitly denominated in scheduler requests. **If you are on v2.5.0 with a platform selected, your numbers will change** — small clusters get *lighter* (3 nodes / 50 VMs: 64 → 44 GB, as the control plane stops being counted three times) while VM-dense ones get *heavier* (7 nodes / 200 VMs: 126 → 133 GB and 109 → 122 threads, from the corrected per-VM terms), and a physical-RAM figure that v2.5.0 did not report at all now appears (+46 to +133 GB across those cases). Pre-v2.5.0 configurations remain unaffected — they still load with no platform selected |

## Disclaimer

This tool is for **planning purposes only** and is **not an official SUSE product**. Always confirm sizing against the latest official [SUSE documentation](https://documentation.suse.com/) before a production deployment. "SUSE", "SUSE AI" and the SUSE AI logo are trademarks of SUSE S.A., used here for identification only.

## License

[MIT](LICENSE)
