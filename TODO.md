# TODO

Open items, mostly drawn from METHODOLOGY.md §11 (Limitations).

## Calibration

- [ ] Only Harvester is calibrated against measurements (`test/measurements/*harvester-v1.8.1.json`). vSphere, Proxmox, AHV and OpenShift Virtualization use doc-derived coefficients; vSphere, AHV and Proxmox probably understate. Run `test/measurements/capture/` on real clusters and score with `validate.js`.
- [ ] Monitoring and logging add-on coefficients are still "estimate" tier; no benchmark covers them.
- [ ] Harvester rests on a single benchmark on one hardware configuration; add more captures.
- [ ] Storage-service terms assume ~4 TB devices; clusters with many small disks cost more than the model predicts.

## Features

- [ ] Import RVTools exports (vInfo, vHost, vDisk, vNetwork, etc.) to size migrating an entire VM inventory, e.g. VMware to SUSE Virtualization, from actual VM CPU/RAM/disk data instead of hand-entered VM classes.

## Not modelled

- [ ] Network throughput and latency: storage fabric, DR replication links, Longhorn's 10 GbE recommendation.
- [ ] Asymmetric DR: async-replication overhead, asymmetric site sizing.
- [ ] Licensing (per-core / per-socket).
- [ ] NUMA, CPU pinning topology and huge pages, beyond the 1:1 GPU pin.
- [ ] Dedicated-witness and other asymmetric-role topologies.
- [ ] Heterogeneous control plane (singleton overhead is spread across the fleet, then flagged).
- [ ] Placement is aggregate-capacity checking, not bin-packing.

## Housekeeping

- [ ] Untracked `Sizing-BTC-AMM-New 3.xlsx` in the repo root: commit it or add it to `.gitignore`.
- [ ] Check whether the PDF report visual consistency pass was finished.
