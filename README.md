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
- **Custom applications** — add arbitrary workloads so their resource demand is folded into every total.
- **Bare-metal virtualization sizing** — plan the SUSE Virtualization (Harvester) hosts that run SUSE AI. Define one or more **physical host types** (sockets/cores/threads, RAM, storage, GPUs, optional hypervisor reservation), set CPU/RAM overcommit and an N+x resiliency policy, and the tool treats every cluster node as a VM to derive sizing. **GPU VMs are pinned 1:1** (never overcommitted) automatically. Two modes: **Auto** (how many identical hosts are needed, with per-host utilization in normal and degraded states) and **Pool** (capacity-check a mixed/heterogeneous inventory, reserving the largest hosts for failure). Supports extra VMs, external storage arrays (FC / iSCSI / DAS / CSI / NFS), and multi-site DR. Full formulas, assumptions and references are documented in [METHODOLOGY.md](METHODOLOGY.md).
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
const APP_VERSION = "2.3.0";                                          // shown in footer & About
```

## Project structure

```
.
├── index.html                 # the entire application
├── METHODOLOGY.md             # sizing formulas, assumptions & references
├── assets/
│   ├── suse-ai-neg-green-stacked.svg   # header/About logo (dark theme)
│   └── suse-ai-pos-green-stacked.svg   # PDF/light-background logo
├── .github/workflows/deploy.yml
├── .nojekyll
├── LICENSE
└── README.md
```

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

## Disclaimer

This tool is for **planning purposes only** and is **not an official SUSE product**. Always confirm sizing against the latest official [SUSE documentation](https://documentation.suse.com/) before a production deployment. "SUSE", "SUSE AI" and the SUSE AI logo are trademarks of SUSE S.A., used here for identification only.

## License

[MIT](LICENSE)
