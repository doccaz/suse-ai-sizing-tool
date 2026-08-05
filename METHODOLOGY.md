# Sizing Methodology

This document describes how the **SUSE AI Sizing Architect** computes its
recommendations, the assumptions behind each formula, and how those assumptions
relate to established virtualization and Kubernetes sizing practice. It covers
both the **Cluster Sizing** model (the SUSE AI Kubernetes workload) and the
**Virtualization** model (the bare-metal SUSE Virtualization / Harvester hosts
that run the cluster as virtual machines).

The virtualization model is derived from a real, hand-built customer sizing
spreadsheet (`Sizing-BTC-AMM`) and generalised, with two deliberate refinements
over that hand calculation:

1. **GPU virtual machines are never overcommitted** — they pin physical CPU,
   RAM and GPUs 1:1. Overcommit applies only to non-GPU VMs.
2. **Hosts are modelled as one or more *types*** so that mixed/heterogeneous
   inventories can be evaluated, not just a single uniform host.

> ⚠️ **Planning aid, not an official tool.** All figures are estimates for early
> planning. Always validate against current SUSE documentation and a qualified
> SUSE professional before purchasing or deploying.

---

## The Cluster Sizing model (Kubernetes layer)

The **Cluster Sizing** tab models the SUSE AI Kubernetes cluster itself. It
compares **capacity** (what the nodes provide) against **demand** (what the
selected services and custom apps request) and reports the remaining headroom or
deficit per resource (vCPU, RAM, storage, GPU).

### Cluster fleet

A deployment is modelled as a **fleet of clusters** rather than a single cluster.
Each cluster has a **role** and an **enabled** flag, and is sized with the same
node-group / profile / service model described below:

- **Downstream** (`workload`) — the SUSE AI clusters that run your AI workloads;
  there can be several.
- **Rancher Management** — the cluster running the Rancher control plane that
  manages the downstream clusters. Suggested on by default with HA control-plane
  sizing (3 × *Management* profile = 4 vCPU / 16 GB) and no AI workloads. Sizing
  scales with the number of downstream clusters and nodes under management.
- **Observability** — a dedicated SUSE Observability cluster. Because
  observability is best isolated from the workloads it watches, enabling the
  **SUSE Observability** service on a downstream cluster prompts the tool to move
  it into its own cluster: a 3-node HA control plane plus general workers sized
  from the chosen Observability profile (1 worker for non-HA, 2 for HA). The
  service's demand is then removed from the downstream clusters (reversible).

Totals are reported at two levels: **per selected cluster** (the editor's
sidebar) and a **fleet rollup** that sums capacity and demand over every *enabled*
cluster. The architecture diagram renders one block per cluster, the PDF report
adds a per-cluster breakdown table, and the **Virtualization** model treats every
node of every enabled cluster as a VM (see §2). Disabling a cluster removes it
from all of these.

### Node groups

Nodes are organised into three groups: **control plane**, **GPU-enabled
workers**, and **general-purpose workers**. Each group is independent and has:

- an **enabled** flag — a disabled group contributes nothing to capacity, the
  architecture diagram, or the downstream virtualization fleet. This lets a
  CPU-only deployment switch the GPU worker group off entirely;
- a **sizing mode** — *uniform* (one profile applied to every node in the group,
  plus a node count) or *per-node* (each node edited individually for
  heterogeneous hardware);
- a **fault-tolerance** value `x` (see *Effective nodes* below).

### Reusable node profiles

A **node profile** is a named per-node size (`cpu`, `ram`, `storage`, `gpus`) —
e.g. *Small (4c/8g)*, *Medium (8c/32g)*, *Large (16c/64g)*, *GPU
(16c/32g/1 GPU)*. Profiles are user-editable and a group in uniform mode
references one. This decouples the two levers a customer must balance:

- **scale-up** — assign a larger profile (fewer, bigger nodes);
- **scale-out** — raise the node count (more, smaller nodes).

Editing a profile propagates to every uniform-mode group that uses it. The
default control-plane profile is *Small* (**4 vCPU / 8 GB**), a deliberately
lean starting point for a control plane that runs etcd and the API server rather
than application workloads; scale it up for large or high-churn clusters.

### Effective nodes and fault tolerance (N + x)

Capacity is summed over each group's **effective nodes**:

```
effective_nodes(group) =
    []                                         if group disabled
    group.nodes                                if fault_tolerance x = 0
    group.nodes + x spare clones of the node   otherwise
```

The `x` spare nodes are **N + x** resiliency headroom: real, provisioned
capacity sized so the group keeps running the full workload through `x`
simultaneous node failures. Spares are clones of the group's node profile and
are counted in every total (shown as e.g. `4 nodes (3+1 FT)`). The control-plane
quorum guidance (≥ 3 nodes for etcd) is evaluated against the effective count, so
configuring `2 + 1` satisfies it.

```
capacity.cpu = Σ_groups Σ_(n ∈ effective_nodes(group)) n.cpu      (and ram / storage / gpu)
demand.cpu   = Σ_(selected services) p.cpu + Σ_(custom apps) a.cpu
delta.cpu    = capacity.cpu − demand.cpu                          (negative ⇒ deficit)
```

These sums are **per cluster**; the **fleet rollup** is the same quantities
summed again over every enabled cluster. The effective nodes are exactly the set
handed to the **Virtualization** model below — each becomes one VM (see §2).

---

## 1. Terminology and units

| Term | Meaning |
| --- | --- |
| **vCPU** | A virtual CPU presented to a VM (or a pod CPU request). |
| **Thread / pCPU** | A hardware-schedulable CPU thread = `sockets × cores/socket × threads/core`. With Hyper-Threading / SMT enabled, `threads/core = 2`. |
| **Physical core** | `sockets × cores/socket` (excludes SMT). |
| **Overcommit ratio** | `vCPU : pCPU` — how many vCPU are scheduled per physical thread. |
| **RWO / RWX** | Kubernetes volume access modes (ReadWriteOnce / ReadWriteMany). |
| **Replication factor** | Number of synchronous copies a distributed storage layer keeps (e.g. SUSE Storage / Longhorn default = 3). |
| **Fault tolerance (N+x)** | Number of host failures the cluster must absorb while still running the full workload. |
| **GB** | Gigabytes; RAM and storage are treated in GB throughout. Decimal/binary rounding is ignored at planning altitude. |

All CPU and RAM demand is ultimately normalised to **physical units**
(threads and physical GB) before being compared to host capacity, because that
is the resource that physically constrains placement.

---

## 2. The VM fleet

Every *effective* Kubernetes node from **every enabled cluster** in the fleet
(nodes of enabled groups, including any N + x fault-tolerance spares) becomes
exactly one virtual machine on the virtualization layer:

- Control-plane nodes → control-plane VMs
- GPU worker nodes → GPU VMs
- General-purpose worker nodes → worker VMs

Disabled node groups — and disabled clusters — contribute no VMs.

To this we add any **custom VMs** declared on the Virtualization tab (e.g.
registry, bastion, load balancers), each expanded by its `count`. Note that the
Rancher Management and Observability clusters are now first-class clusters in the
fleet, so their nodes are already counted above and need not be added as custom
VMs.

For the fleet we compute, splitting **GPU** (any VM with `gpu > 0`) from
**non-GPU** VMs:

```
total_vcpu        = Σ vm.cpu
total_ram         = Σ vm.ram
total_storage     = Σ vm.storage
total_gpu         = Σ vm.gpu
gpu_vcpu          = Σ vm.cpu  (GPU VMs only)
nongpu_vcpu       = Σ vm.cpu  (non-GPU VMs only)
gpu_ram, nongpu_ram   — analogous
largest_vm_*      = max over VMs of cpu / ram / storage / gpu
```

The **largest single VM** matters because a VM cannot be split across hosts — it
must fit entirely on one host (see §7, Rule 1).

---

## 3. CPU sizing, overcommit and GPU pinning

### Hyper-Threading

Host CPU capacity is expressed in **hardware threads**:

```
threads_per_host = sockets × cores_per_socket × threads_per_core
```

The reference spreadsheet used `2 sockets × 24 cores + Hyper-Threading = 96`,
i.e. it counts each SMT thread as a schedulable unit. This tool does the same by
default. Counting an SMT thread as one schedulable vCPU is effectively a **~2:1
overcommit against physical cores** and is standard practice for mixed server
consolidation, **but SMT does not double real throughput** (typical uplift is
~1.1–1.3×). For latency-sensitive or licensing-bound workloads, set
`threads/core = 1` or lower the overcommit ratio to size against physical cores.

### Overcommit (non-GPU VMs only)

CPU demand is normalised to physical threads. Non-GPU vCPU are divided by the
overcommit ratio; **GPU vCPU are kept 1:1**:

```
cpu_thread_demand = gpu_vcpu  +  nongpu_vcpu / vcpu_ratio  +  platform_lump_cpu
```

Worked example (this tool's defaults): a fleet of 16 GPU vCPU + 32 non-GPU vCPU
at a 4× overcommit ratio needs `16 + 32/4 = 24` physical threads — **not**
`48/4 = 12`. The GPU portion is never compressed.

**Why GPU VMs are pinned.** GPU/AI inference and training VMs use PCIe
passthrough or vendor partitioning (NVIDIA vGPU / MIG); their vCPUs feed the
accelerator and are sensitive to scheduling latency and NUMA locality. Industry
guidance is to pin GPU/accelerated and other performance-critical VMs at 1:1 and
reserve overcommit for bursty, idle-heavy general workloads.

### RAM

RAM is handled the same way, with GPU VMs pinned 1:1:

```
ram_demand = gpu_ram  +  nongpu_ram / ram_ratio  +  platform_lump_ram
```

`platform_lump_*` is the control-plane, per-VM and per-device overhead of
[§ 7a](#7a-hypervisor-platform-overhead) (zero when no platform is selected).
Note it is added **outside** the overcommit divide: per-VM hypervisor overhead is
real host memory backing the guest process and cannot be overcommitted away.

The default RAM ratio is **1.0×**. Memory overcommit (ballooning, KSM, swap) is
risky for production and especially for AI workloads — under-provisioned memory
leads to the host OOM-killing VMs — so the tool defaults to no memory
overcommit and recommends keeping it at or near 1.0×.

### Recommended overcommit ranges

| Workload class | vCPU : pCPU | Notes |
| --- | --- | --- |
| GPU / AI inference & training | **1 : 1 (pinned)** | Enforced automatically. |
| Databases, latency-sensitive | 1 : 1 – 2 : 1 | |
| General server / app VMs | 2 : 1 – 4 : 1 | Monitor CPU-ready / steal time. |
| Dev / test, bursty | 4 : 1 – 8 : 1 | Only with good headroom monitoring. |

---

## 4. Storage sizing

### Host-local (hyperconverged) storage

When storage is host-local (SUSE Storage / Longhorn), every volume is
synchronously replicated, so raw capacity demand is multiplied by the
replication factor:

```
storage_demand = total_storage × replication_factor      (default ×3)
```

A replication factor of **3** is the documented Longhorn default and the common
production choice (tolerates the loss of two replicas). Because a Longhorn volume
(one replica) **cannot be striped across nodes**, the largest single volume must
fit on a single host (Rule 3).

### External storage arrays

If an external array is selected (Fibre Channel, iSCSI, direct-attached LUNs,
external CSI driver, or NFS), redundancy is handled by the array (RAID / erasure
coding / array replication), **not** by host-local replication. In that case:

- host-local replication is **not** applied;
- storage is **removed** from the per-host disk constraint (hosts only need boot
  / system disks);
- the **usable** capacity to provision on the array is reported separately as
  `total_storage × DR_sites`.

The connection type is captured for the bill of materials and to remind you to
provision the data path (HBAs / NICs / multipath / CSI driver) on every host.

---

## 5. GPU sizing

GPUs are treated as **passthrough/partitioned devices that are never
oversubscribed**:

```
min_hosts_by_gpu = ceil(total_gpu / gpus_per_host)
```

A host with zero GPUs cannot run a GPU VM; this is surfaced as a failed rule
rather than silently inflating the host count. (vGPU/MIG partitioning can place
several VMs on one physical GPU; model that by setting `gpus_per_host` to the
number of *partitions* a host exposes.)

---

## 6. VM density

Independently of CPU/RAM, each host has a maximum number of VMs:

```
min_hosts_by_vms = ceil(total_vms / max_vms_per_host)
```

The default `max_vms_per_host = 40` is a conservative hypervisor figure. (The
analogous Kubernetes limit, used in the workload model, is the kubelet default
of **110 pods per node**.) Both are soft, configurable ceilings driven by
control-plane, networking and management-agent overhead rather than raw
compute.

---

## 7. Design rules (capacity-planning invariants)

From the reference spreadsheet's "Rules" sheet, generalised:

1. **The largest VM must fit on a single host** — `host_threads ≥ largest VM's
   physical thread requirement`, and likewise for RAM. (A GPU VM's requirement
   is its raw vCPU; a non-GPU VM's is `vCPU / overcommit`.)
2. **The largest volume must fit on a single host** (host-local storage only) —
   volumes are not striped across nodes.
3. **A GPU host must exist for the largest GPU VM.**
4. **The cluster must survive `x` host failures** — one failed host *plus* a
   spare so maintenance/upgrades can proceed while a host is already down. This
   is the standard N+1 / N+2 rule and mirrors VMware HA *admission control*
   reserving failover capacity, and the general HA principle of never running a
   cluster with zero spare capacity.
5. **Platform overhead** — the spreadsheet ignored hypervisor/OS CPU and RAM
   entirely, which overstates usable capacity. This is now modelled
   automatically per hypervisor platform: see
   [§ 7a Hypervisor platform overhead](#7a-hypervisor-platform-overhead) for
   the five terms, their coefficients and their sources.

   The per-host **reserve threads** / **reserve RAM** fields remain, and still
   default to **0**. They are now an *additional* manual reserve layered **on
   top of** the automatic platform model — not a duplicate of it. Use them for
   site-specific headroom the platform model does not know about (a monitoring
   agent, a backup proxy, a deliberate safety margin).

6. **Platform overhead must stay a minority of the host** — the tool fails a
   design-rule check when per-node overhead exceeds **35%** of a host's threads
   or RAM. Crossing that line usually means the hosts are too small for the
   platform rather than that the workload is too large.

7. **The platform must support the requested overcommit** — Nutanix AHV cannot
   overcommit memory. Selecting a platform never rewrites your overcommit
   ratios (see § 7a), so a conflict is reported as a failed design rule instead.

8. **Physical RAM must hold what is consumed but never requested** — chiefly
   Longhorn's replica engines (§ 7a.5a). Because these are not requests they
   cannot block scheduling, so they are checked **physical against physical**:
   platform RSS + storage engines + VMs at their measured resident size, versus
   host RAM. Comparing them against VM *requests* would be wrong — requests run
   ~3.6× resident size, so that check would fail designs that are actually fine.

9. **One node carries the cluster services** — the apiserver, etcd and ingress
   leaders land together, measured at ~2× the memory of their peers. Uniformly
   sized hosts must have that headroom. Informational, since it constrains the
   *distribution* of overhead rather than its total.

---

## 7a. Hypervisor platform overhead

A virtualization platform consumes real capacity before a single guest VM
starts: a management plane, storage services, agents on every node, and a
per-VM cost the hypervisor pays for each guest. Ignoring it is the single
largest source of under-sizing in a bare-metal design.

Select a platform in the Virtualization tab and the model below is applied
automatically. **Selecting a platform never changes your overcommit ratios** —
see [§ 7a.7](#7a7-what-is-deliberately-not-applied).

### 7a.1 Provenance — how to read the tables

Every coefficient carries a tier. The tool shows it in the UI and prints it in
the PDF, so a reader can always tell a derived number from an observed one.

| Tier | Meaning |
|---|---|
| **Verified** | Traced to vendor source code, or to a published worked example that this model reproduces numerically. The citation names the file and line, or the doc page. |
| **Measured** | Taken from an independent benchmark of a real cluster. Stronger than an estimate, but it is one configuration — see the caveats in [§ 7a.9](#7a9-calibration-against-a-measured-cluster). |
| **Estimate** | Vendor documentation, blog, or community figure. Indicative, not authoritative. Adjust to your own measurements. |

> **Why no Harvester RAM figure is "Verified".** Harvester writes **only**
> `system-reserved=cpu=` and `kube-reserved=cpu=` to the kubelet
> (`package/upgrade/upgrade_node.sh:446`, `set_reserved_resource`). It
> configures **no kubelet memory reservation at all**, so there is no vendor
> formula for Harvester memory overhead to cite. The RAM coefficients are
> instead calibrated against measurement (§ 7a.9) and remain editable. If you
> have figures from your own clusters, they are better than these.

### 7a.1b Model completeness — and why platform totals still differ

Provenance tiers describe how well *one coefficient* is sourced. Model depth is a
separate axis: how much of a platform is modelled at all.

| Platform | Model | Line items | Basis of coefficients |
|---|---|---|---|
| **Harvester** | **Calibrated** | 16 | Vendor source code + a measured cluster |
| OpenShift Virtualization | Modelled | 11 | Shipped KubeVirt/HCO/CNO manifests + OpenShift's own node auto-sizing script |
| vSphere / ESXi | Modelled | 4 | Broadcom published tables and formulas |
| Nutanix AHV | Modelled | 4 | Nutanix documentation |
| Proxmox VE | Modelled | 5 | Proxmox and Ceph documentation |

**Modelled** means every significant category is represented — management plane,
storage service, per-node and per-VM terms — but the coefficients come from
vendor documentation rather than measurement. Only Harvester has been checked
against a real cluster.

#### The totals still are not equal, and that part is real

At 5 nodes / 100 VMs on 96-thread / 512 GB / 7.68 TB hosts:

| Platform | CPU | RAM |
|---|---|---|
| Harvester | 87 thr | 76 GB |
| OpenShift Virtualization | 52 thr | 236 GB |
| vSphere + vSAN | 53 thr | 115 GB |
| Nutanix AHV | 51 thr | 209 GB |
| Proxmox + Ceph | 15 thr | 102 GB |

These are now the same order of magnitude, and the remaining differences are
architectural rather than artifacts:

- **Harvester's CPU is high because Longhorn *reserves* it.** The instance
  manager takes 12% of allocatable as a *guaranteed CPU request* whether or not
  it is used — the scheduler will not place a VM in it. vSAN and Ceph consume
  comparable CPU but do not reserve it from a scheduler, so it does not appear
  as removed capacity. Same physical cost, different accounting.
- **AHV's RAM is high because the CVM is a fixed 32 GB per host**, plus Prism
  Central. That is a genuine design trade, not a modelling artifact.
- **OpenShift's RAM is high because its kubelet reserves memory and Harvester's
  does not.** OpenShift runs a node auto-sizing script that writes
  `systemReserved` at boot; on a 512 GB host that is **16 GiB per node before
  the scheduler sees anything** (§ 7a.3a). Harvester writes no memory
  reservation at all, so the same physical cost shows up on Harvester as pod
  requests and resident memory rather than as removed capacity.
- **Proxmox is genuinely the leanest stack** — no Kubernetes layer, no guaranteed
  storage reservation.

> **Still be careful comparing.** The Harvester figure is measured; the others
> are derived from vendor documentation and will be less accurate. Treat a
> cross-platform comparison as indicative of *shape*, not as a benchmark.

### 7a.1a What the numbers are denominated in

Three different quantities get called "overhead", and on a real cluster they
differ by up to 2×. Getting them confused produces sizing that is confidently
wrong, so the tool commits to one:

| Quantity | What it means | Used here? |
|---|---|---|
| **Scheduler requests** | What pods *reserve*. Kubernetes will not place a VM if the requests do not fit. | **Yes — this is the basis.** |
| Pod usage | What pods actually consume right now (`kubectl top`). | No — informational only. |
| Host consumption | `MemTotal − MemAvailable`, including the OS and kernel. | Only for the physical-capacity rule. |

**Overhead is expressed as scheduler requests, plus the kubelet reserve** (which
comes out of capacity before the scheduler ever sees the node). This is the
quantity that actually limits how many VMs fit. The measured cluster in § 7a.9
hit **99% of allocatable in requests while consuming only 37–49% of physical
RAM** — sizing on consumption would have promised roughly twice the density the
scheduler was ever going to allow.

The exception is memory that is consumed but never requested — chiefly Longhorn's
replica engines. Those cannot block scheduling, but the host still needs the RAM.
They are tracked separately, marked **physical RAM only** in the UI and the PDF,
excluded from the sizing totals, and enforced by their own design rule.

Every coefficient is overridable in the UI ("Show overhead factors"). Overrides
are stored per configuration and survive export/import.

### 7a.2 The five terms

| Term | What it covers | How it scales |
|---|---|---|
| **A** | Kubelet reserve (CPU only) | per node, from host thread count |
| **B** | Platform / management pods | per node |
| **B′** | **Cluster services (singletons)** | **once per cluster — does *not* scale with node count** |
| **C** | Per-VM hypervisor overhead | per VM, from guest RAM and vCPU |
| **C′** | Storage-engine memory (*physical*) | per VM disk × replicas |
| **D** | Passthrough device overhead | per GPU / SR-IOV VF |
| **E** | Storage reserve | percentage of raw disk per node |

> **Term B′ is the one most models get wrong.** Rancher, CDI, and the KubeVirt
> and Harvester operators are singletons: a 3-node cluster runs *one* of each,
> not three. Measured, a 3-node cluster costs **2.19×** a single node, not 3×
> (§ 7a.9). Charging the control plane per node over-states a 3-node cluster's
> memory by roughly 50%.
>
> **OpenShift Virtualization makes exactly the same mistake if you take its
> published "+2 cores per node" literally.** Red Hat's guidance is a
> consumption-basis recommendation that amortises the control plane over the
> nodes; charged as a per-node scheduler request it overstated a 20-node cluster
> by roughly 7 GB per node. The model now itemises instead: only virt-handler is
> a DaemonSet, so everything else KubeVirt runs (virt-api, virt-controller,
> virt-exportproxy, CDI, HCO and the operators) sits in the cluster scope, and
> Red Hat's per-node figure is kept as a *consumption* line for cross-checking
> rather than as a request (§ 7a.6a).
>
> The per-control-plane-node scope survives for what genuinely is per node:
> OpenShift's three masters. Harvester does not use it.

Terms A, B and E reduce each host's usable capacity. B′, C and D are added to
fleet demand. The split matters: `capOf()` is per *host type*, so a cost carried
by only some hosts cannot be expressed as a per-host subtraction. For auto mode
the two forms are equivalent —

```
N × (cap − uniform) − lump ≥ demand
  ⟺  N ≥ (demand + lump) / (cap − uniform)
```

— and the demand form is the only correct one in pool mode, where positional
capacity is unrepresentable.

**Per-VM overhead is added outside the overcommit divide.** It is real host
memory backing the guest process; it cannot be overcommitted away.

### 7a.3 Term A — kubelet reserve (Harvester)

Harvester derives its kubelet CPU reservation from the GKE node-allocatable
formula, then applies **twice** the result, split `system:kube = 2:3`:

```
gke(threads) = 6%   of the 1st core
             + 1%   of the 2nd core
             + 0.5% of the next 2 cores
             + 0.25% of every core above 4
reserved     = gke(threads) + (maxPods > 110 ? 0.400 : 0)
harvester    = 2 × reserved
```

Source: `harvester/harvester pkg/installer/config/config.go:565`
(`calculateCPUReservedInMilliCPU`), applied in
`pkg/installer/config/config.go` (`GetSystemReserved`) and re-applied on upgrade
by `package/upgrade/upgrade_node.sh:446`.

**Verification.** Harvester's docs give a worked example: a 16-core node
reserves `systemReserved 408m + kubeReserved 612m = 1020m`, leaving ~15 cores.
Our formula: `gke(16) = 0.06 + 0.01 + 0.01 + 12×0.0025 = 0.11`; Harvester ships
`maxPods > 110`, so `reserved = 0.51`; doubled = `1.02 core = 1020m`, split
`2/5 = 408m` and `3/5 = 612m`. **Exact match** — this is asserted as a
regression test.

| Host | Reserve |
|---|---|
| 16 threads | 1020 m (6.4%) |
| 96 threads | 1420 m (1.5%) |

Tier: **Verified**. Sources: [Harvester CPU Pinning — Calculation of Shared CPU Pool](https://docs.harvesterhci.io/v1.8/vm/cpu-pinning), [GKE node resource reservations](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/plan-node-sizes).

vSphere, AHV and Proxmox have no kubelet layer, so Term A is zero for them and
their node reserve is folded into Term B. OpenShift Virtualization has its own
Term A — a different formula, and the only one that reserves memory (§ 7a.3a).

### 7a.3a Term A — OpenShift Virtualization kubelet reserve

Every OpenShift worker runs a node auto-sizing script at boot which computes
`systemReserved` from the node's own size and writes it into a kubelet drop-in.
The docs state that clusters upgraded from earlier than 4.21 have it disabled
by default (re-enabled by deleting the `50-worker-auto-sizing-disabled` machine
config), and that `autoSizingReserved: false` is how you opt out — so the model
assumes auto-sizing is active, which is the documented default behaviour. Unlike Harvester's, it reserves **memory as well as
CPU** — and on a large host the memory half is the single biggest per-node term
in the whole model.

```
cpu(threads)  = threads > 1 ? 0.06 + 0.012 × (threads − 1) : 0.06
                floored at 0.5                                   (auto-sizing v2)

ram(GB)       = 1 GiB                        for the first 8 GB
              + 6%  of the next 120 GB
              + 2%  of everything above
                rounded to whole GiB
```

Source: `openshift/machine-config-operator`
`templates/common/_base/files/kubelet-auto-sizing.yaml`
(`dynamic-system-reserved-calc.sh`). The model transcribes the script verbatim,
including two quirks that a tidied-up version would get wrong: the middle memory
tier subtracts **112**, not 120, before the 2% tier begins, and the CPU result is
floored at **0.5 threads** regardless of how small the node is.

| Host | CPU reserve | RAM reserve |
|---|---|---|
| 4 threads / 32 GB | 500 m (floor) | 2 GiB |
| 16 threads / 128 GB | 500 m (floor) | 8 GiB |
| 64 threads / 256 GB | 820 m | 10 GiB |
| 96 threads / 512 GB | 1200 m | 16 GiB |

Tier: **Verified**. This is not a vendor recommendation with headroom in it — it
is the arithmetic the node itself performs.

> **Why this is not double-counted against the pod requests below.**
> `systemReserved` is capacity withheld for processes *outside* pods — kubelet,
> CRI-O, systemd. Pod requests (virt-handler, ovnkube-node, …) are charged
> against what is left. Both are real and both are counted, exactly as the
> kubelet does it.

### 7a.4 Term B — SUSE Virtualization (Harvester) coefficients

**Every node:**

| Coefficient | Value | Tier | Source |
|---|---|---|---|
| Longhorn instance-manager | **12% of node allocatable CPU** | Verified | `pkg/installer/config/cos.go:35-49` (`defaultGuaranteedInstanceManagerCPU = 12 // means percentage 12%`); capped at 12% in `cos.go:336`; synced back to default by `pkg/controller/master/setting/instance_manager_resources.go:71`; agrees with `longhorn-manager types/setting.go:1134` default `{"v1":"12","v2":"12"}` |
| RKE2 agent, containerd, canal/multus, node-exporter | 1.03 thr / 1.83 GB | Measured | [Benchmark](https://gist.github.com/Vicente-Cheng/ae8d5ce743f94c0c9a333574813bc777) (§ 7a.9), [Harvester requirements](https://docs.harvesterhci.io/v1.8/install/requirements/) |
| KubeVirt virt-handler + Harvester node agents | 0.59 thr / 0.73 GB | Measured | [Benchmark](https://gist.github.com/Vicente-Cheng/ae8d5ce743f94c0c9a333574813bc777), [KubeVirt](https://kubevirt.io/user-guide/compute/resources_requests_and_limits/) |
| Longhorn manager, CSI plugin, engine images | 0.26 thr / 0.78 GB | Measured | [Benchmark](https://gist.github.com/Vicente-Cheng/ae8d5ce743f94c0c9a333574813bc777), [Longhorn best practices](https://longhorn.io/docs/1.12.0/best-practices/) |
| *OS, kernel and platform pod RSS* — **physical only** | *6.71 GB* | Measured | [Benchmark](https://gist.github.com/Vicente-Cheng/ae8d5ce743f94c0c9a333574813bc777) — host-consumed fit, § 7a.9 |

The three request rows sum to **1.88 thr / 3.34 GB per node** — the measured
per-node share `P` derived in § 7a.9.

**Once per cluster (singletons — do *not* multiply by node count):**

| Coefficient | Value | Tier | Source |
|---|---|---|---|
| etcd + apiserver / scheduler / controller-manager (**HA replicas**) | 1.50 thr / 2.60 GB | Measured | Live v1.8.1 cluster (§ 7a.10) |
| Harvester controllers, webhooks, UI, CDI, vm-import | 1.30 thr / 3.20 GB | Measured | Live v1.8.1 cluster (§ 7a.10) |
| Embedded Rancher (cattle / fleet / CAPI) | 1.075 thr / 1.335 GB | Measured | Live v1.8.1 cluster (§ 7a.10) |
| *Cluster services RSS beyond requests* — **physical only** | *6.09 GB* | Measured | [Benchmark](https://gist.github.com/Vicente-Cheng/ae8d5ce743f94c0c9a333574813bc777) |

The three request rows sum to **3.875 thr / 7.135 GB, counted once** — measured
directly on a 3-node v1.8.1 cluster by workload kind (§ 7a.10).

> **Why this is much larger than the v1.7.1 benchmark's 2.27 GB.** That figure
> came from a fit anchored on a *single-node* cluster, where none of the HA
> replication exists: coredns, virt-api, virt-controller and the CNI operator
> each run **2 replicas** once there is more than one node. v1.8.1 also adds CDI
> and the kube-ovn stack. Since this tool sizes production HA clusters, the
> multi-node measurement is the relevant one — and the model consequently no
> longer reproduces the single-node benchmark, by design.

**Add-ons** (toggleable; default state in brackets). The v1.7.1 benchmark ran
with neither monitoring nor logging installed, so it validates neither. They are
instead **measured on the live v1.8.1 cluster** (§ 7a.10), decomposed by workload
kind: the DaemonSet component is per-node, the Deployments and StatefulSets are
cluster-wide. The previous per-node RAM estimates were **20–50× too high**.

| Add-on | Every node | Once per cluster | Tier | Source |
|---|---|---|---|---|
| rancher-monitoring **[on]** | 0.10 thr / 0.03 GB | 1.05 thr / 2.0 GB | **Measured** | Live v1.8.1 cluster (§ 7a.10) |
| rancher-logging **[off]** | 0.05 thr / 0.05 GB | 0.22 thr / 0.41 GB | **Measured** | Live v1.8.1 cluster (§ 7a.10) |
| Longhorn V2 data engine **[off]** | **+12% CPU** / 2 GB huge pages | — | Verified | `longhorn-manager types/setting.go:1134` (setting is data-engine specific), [Longhorn best practices](https://longhorn.io/docs/1.12.0/best-practices/) |
| pcidevices + NVIDIA driver toolkit **[auto]** | 0.5 thr / 1.5 GB | — | Estimate | [Harvester requirements](https://docs.harvesterhci.io/v1.8/install/requirements/) |
| Imported into an **external** Rancher **[on]** | 0.05 thr / 0.3 GB | 0.2 thr / 1 GB | Estimate | [Harvester requirements](https://docs.harvesterhci.io/v1.8/install/requirements/) |

> **Do not confuse the two Ranchers.** Harvester's *embedded* Rancher is in the
> cluster table above and is always present. The add-on is the *additional*
> agent stack when the cluster is also imported into an external Rancher. The
> benchmark measured a standalone cluster, so its figures include the embedded
> Rancher and exclude the add-on.

> **The Longhorn line dominates.** At 12% of allocatable, a 96-thread host pays
> ~11.5 threads to the instance-manager — more than every other CPU term
> combined. Because the setting is *data-engine specific* and, since Longhorn
> 1.5, there is one instance-manager pod **per node per data engine**, enabling
> the V2 engine charges it **twice**. This is why the term is modelled as a
> percentage of allocatable rather than a flat number, and why it is shown as
> its own line rather than folded into a lump sum.

### 7a.5 Term C — per-VM overhead

#### KubeVirt platforms: the vendor's own formula

Harvester and OpenShift Virtualization run each guest in a `virt-launcher` pod,
and KubeVirt computes that pod's memory overhead in
[`GetMemoryOverhead()`](https://github.com/kubevirt/kubevirt/blob/main/pkg/virt-controller/services/renderresources.go).
The model implements it directly rather than approximating it:

```
fixed        = 25 MiB virt-launcher-monitor
             + 100 MiB virt-launcher
             +  25 MiB virtlogd
             +  40 MiB virtqemud
             +  30 MiB qemu                        = 220 MiB
page tables  = memory REQUEST / 512      (not the guest size — see below)
per vCPU     = 8 MiB
IOThread     = 8 MiB
graphics     = 32 MiB   (auto-attached by default)

overhead     = (fixed + page tables + per-vCPU + IOThread + graphics)
               x AdditionalGuestMemoryOverheadRatio
```

Constants from `kubevirt/kubevirt pkg/virt-controller/services/template.go:115-119`,
**verified identical in v1.6.3** (the release the benchmark ran) **and in `main`**.

> **Page tables follow `spec.domain.resources.requests.memory`, not the guest
> size.** With memory overcommit active — Harvester ships 150% — the request is
> the guest size divided by that ratio, so the page-table term is smaller than a
> naive reading suggests. Using the guest size instead overstates a 32 GiB guest's
> overhead by ~20 MiB. The model uses the request.

The ratio is a cluster setting. **Harvester defaults it to 1.5**
(`harvester/harvester pkg/settings/settings_helper.go`,
`AdditionalGuestMemoryOverheadRatioDefault = "1.5"`, valid range 1.0–10.0);
KubeVirt and OpenShift leave it at **1**. That single setting is the entire
reason a guest costs ~1.5× more on Harvester than on OpenShift — it is a
configuration choice, not an architectural difference, and it is editable here.

| Platform | fixed | per vCPU | IOThread | graphics | page tables | ratio | Tier |
|---|---|---|---|---|---|---|---|
| Harvester | 220 MiB | 8 MiB | 8 MiB | 32 MiB | RAM/512 | **1.5** | **Verified** |
| OpenShift Virtualization | 220 MiB | 8 MiB | 8 MiB | 32 MiB | RAM/512 | **1** | **Verified** |

> **This supersedes Red Hat's published `(1.002 × RAM) + 146 MiB + 8 MiB/vCPU`.**
> That form is the same calculation, coarser and dated: `1.002 × RAM` *is* the
> page-table term (`RAM/512` = 0.195% of RAM), and 146 MiB is an older snapshot
> of the fixed components, which now total 220 MiB. v2.6.0 used the published
> form and consequently under-counted.

**Cross-check against measurement.** For the benchmark's 2 vCPU / 2 GiB guest:

```
(220 + 8 + 32) + 8x2 + 2048/512 = 280 MiB       x 1.5 = 420 MiB
measured (§ 7a.9):                                      421 MiB
```

Two independent lines of evidence — vendor source code and a running cluster —
agreeing to **0.25%**, with neither fitted to the other. Neither is exact: the
residual is plausibly rounding in the reported figure, or a detail of how
Harvester sets `requests.memory`. `test/benchmark.js` asserts both.

**Terms the model does not apply**, because they depend on per-VM configuration
the tool does not capture. Add them through a coefficient override if they apply
to your fleet:

| Condition | Overhead |
|---|---|
| arm64 with UEFI/pflash | +128 MiB |
| TPM device | +53 MiB |
| SEV / SEV-ES / SEV-SNP | +256 MiB |
| Exec liveness/readiness probes | +10 MiB each, +100 MiB once |
| Dedicated CPU, or Guaranteed QoS | +100 MiB |
| DownwardMetrics disk | +1 MiB |

**VFIO/GPU passthrough is modelled inside this term, at +1 GiB per passthrough
*VM*** — not per device. KubeVirt's branch is `if HasVFIO(vmi)`, a boolean, so a
guest with four GPUs pays the same 1 GiB as a guest with one. Confirmed on a live
VM with two host devices, which paid exactly 1 GiB × the 1.5 ratio = 1536 MiB.
The non-KubeVirt platforms keep a genuinely per-device term (Term D).

#### The other platforms

They have no pod layer, and their vendors publish only a coarse form:

```
per-VM RAM = (factor − 1) × guest RAM + fixed MiB + per-vCPU MiB × vCPUs
```

| Platform | factor | fixed | per vCPU | Tier | Source |
|---|---|---|---|---|---|
| vSphere / ESXi | 1.005 | 100 MiB | 20 MiB | Estimate | [VMware memory resource management](https://www.vmware.com/docs/perf-vsphere-memory_management) |
| Proxmox VE | 1.015 | 80 MiB | 8 MiB | Estimate | [Proxmox hardware requirements](https://www.cherryservers.com/blog/proxmox-hardware-requirements) |
| Nutanix AHV | 1.000 | 100 MiB | 8 MiB | Estimate | [AHV memory overcommit](https://www.nutanix.com/tech-center/blog/ahv-internals-memory-overcommit) — AHV's overhead is largely in the CVM (Term B) |

#### Per-VM CPU

`80 m` per VM on both KubeVirt platforms, on top of `vCPU ÷ overcommit`. Derived
from the benchmark (205 m measured per VM, less 125 m for a 2-vCPU guest at
Harvester's default 1600% CPU allocation ratio). Tier **Measured**; Red Hat
publishes no equivalent, so the figure is carried across to OpenShift.

### 7a.5a Term C′ — storage-engine memory (physical, not a request)

Longhorn runs **one replica engine per VM disk** inside the per-node
instance-manager pod. Measured: instance-manager memory grew from 111 MiB at
idle to **60 273 MiB across 148 VMs** — `60273 / (148 × 3 replicas)` =
**136 MiB per replica**, ≈ 20 GiB per node at 49 VMs/node.

```
storage-engine RAM = 136 MiB × replicas × VM disks
```

This is **consumption, not a request**: it does not reduce schedulable capacity
and never enters the sizing totals. It is nevertheless real RAM, so it drives its
own design rule (§ 7 rule 8). It is **zero** on external or LVM-backed storage —
the benchmark's LVM single-node run used ~49 MiB against Longhorn's 60 273 MiB.

Ignoring this term is how a sizing tool recommends a host that OOMs: at 100 VMs
with 3 replicas it is ~40 GiB of physical RAM.

### 7a.6 Terms D and E, and the other platforms

**Term D — passthrough devices:** `+1 GiB per GPU or SR-IOV VF` on every
platform. Tier *Verified* for OpenShift Virt (Red Hat publishes it), *Estimate*
elsewhere. Harvester additionally runs pcidevices-controller and the NVIDIA
driver toolkit on GPU nodes — that is the `gpuStack` add-on, auto-enabled when
the fleet contains GPUs.

**Term E — storage reserve:** Harvester sets
`defaultStorageReservedPercentageForDefaultDisk = 0 // means percentage 0%`
(`cos.go:35-49`), deliberately overriding Longhorn's own default of 30%
(`longhorn-manager types/setting.go:649`), with a ceiling of
`maxStorageReservedPercentageForDefaultDisk = 30`. The tool therefore defaults
this term to **0%** and exposes it as an editable 0–30% field. It is independent
of, and multiplies alongside, the storage replication factor from § 4.
Tier: **Verified**.

### 7a.6a The other platforms in full

Storage services scale with the disks in a host, but the tool knows host
*capacity*, not device count — so those terms are expressed **per TB of raw local
disk**, converted from the vendor's per-device figure assuming ~4 TB devices.
Every one is editable, and every one **drops to zero when external storage is
selected**, since a hyperconverged storage service does not exist then.

**vSphere / ESXi**

| Scope | Coefficient | Tier | Source |
|---|---|---|---|
| Every node | VMkernel, drivers, host daemons — 0.5 thr / 6 GB | Estimate | [VMware memory management](https://www.vmware.com/docs/perf-vsphere-memory_management) |
| Once per cluster | **vCenter Server Appliance**, sized from the published step table: Tiny 2 vCPU/14 GB (≤10 hosts, ≤100 VMs) → X-Large 24/58 (≤2000 hosts, ≤35000 VMs) | **Verified** | [VCSA hardware requirements](https://techdocs.broadcom.com/us/en/vmware-cis/vsphere/vsphere/8-0/vcenter-installation-and-setup/deploying-the-vcenter-server-appliance/vcenter-server-appliance-requirements/vcenter-server-appliance-hardware-requirements.html) |
| Every node *(add-on, on by default)* | **vSAN** — 10% of host CPU, 4 GB base + 0.7 GB/TB raw | Estimate | [vSAN memory KB](https://knowledge.broadcom.com/external/article?legacyId=2113954), [sizing vSAN hosts](https://techdocs.broadcom.com/us/en/vmware-cis/vsan/vsan/8-0/planning-and-deployment/designing-and-sizing-a-virtual-san-cluster/designing-and-sizing-virtual-san-hosts.html) |

**There is no published per-VM overhead table, and there has not been one since
ESXi 5.1.** Current Broadcom documentation states that overhead "depends on a
large number of factors, including the number of vCPUs and memory size, the
number and types of devices, the execution mode that the monitor is using and
the hardware version" and tells you to power the VM on and search `vmware.log`
for **`VMMEM`**. The model's `1.005 × RAM + 100 MiB + 20 MiB/vCPU` is therefore
an explicit **linear approximation with no vendor arithmetic behind it** — not a
transcription of anything — and it is tiered *Estimate* accordingly. The honest
improvement is not a better curve fit but a measurement: read `VMMEM` from a
handful of representative VMs and override the coefficient.

vCenter is modelled as a cluster service because it is normally a VM on the
cluster it manages. Its row is resolved from the published step table at
sizing time, so the panel labels those controls as auto-sized: the numbers in
the coefficient table are placeholders the engine replaces, and only an
explicit override displaces the resolved row. The vSAN RAM figure derives from the documented formula
`3 GB base + 500 MB/disk group + 7 MB per GB of cache tier`, with cache taken at
the conventional ~10% of capacity — hence ~0.7 GB per TB of raw capacity. The
published constants are from vSAN 6.x and the vendor notes they have grown, so
the base is set to 4 GB rather than 3.

**Nutanix AHV**

| Scope | Coefficient | Tier | Source |
|---|---|---|---|
| Every node | Controller VM (CVM) **base allocation** — 8 thr / 32 GB | Estimate | [AHV memory overcommit](https://www.nutanix.com/tech-center/blog/ahv-internals-memory-overcommit) |
| Every node *(add-on, off)* | **Redundancy Factor 3** — CVM floor rises ~8 GB | Estimate | CVM Specifications — Cluster Feature Based (portal login) |
| Every node *(add-on, off)* | **Capacity-tier deduplication** — CVM floor rises ~8 GB | Estimate | CVM Specifications — Cluster Feature Based (portal login) |
| Every node | AHV hypervisor — ~1% of host CPU / 2 GB | Estimate | [AHV CPU management](https://www.nutanix.com/tech-center/blog/understanding-cpu-resource-management-in-nutanix-ahv) |
| Once per cluster | **Prism Central** (small, single VM) — 6 vCPU / 26 GB; an add-on models the 3-VM scale-out at 12 thr / 52 GB | Estimate | [Prism sizing](https://portal.nutanix.com/page/documents/details?targetId=Web-Console-Guide-Prism-v6_8:wc-cvm-memory-configuration-c.html) |

AHV needs no separate storage-service term: the CVM **is** the storage service.

**The CVM is not a constant.** Nutanix sizes it as *recommended platform memory
plus memory for each enabled feature*, capped at **+16 GB** of feature
additions. The model reproduces the shape of that rule — a base plus capped
increments — rather than transcribing the table, because the authoritative
"CVM Specifications — Cluster Feature Based" page sits behind a Nutanix portal
login. The two increments modelled are the ones consistently attested outside
the portal (RF3 and capacity-tier dedupe, ~8 GB each, together hitting the cap
exactly). Both default to **off**: a plain RF2 cluster without dedupe genuinely
does not pay them. Everything here stays **Estimate** — this is the platform
with no accessible primary source and no measurement, and it will remain so
until someone runs a capture against a real cluster.

**Proxmox VE**

| Scope | Coefficient | Tier | Source |
|---|---|---|---|
| Every node | Host OS + services — 0.5 thr / 4 GB | Estimate | [Proxmox requirements](https://www.cherryservers.com/blog/proxmox-hardware-requirements) |
| Once per cluster | corosync, pve-cluster, pvedaemon — 0.5 thr / 1 GB | Estimate | [Proxmox requirements](https://www.cherryservers.com/blog/proxmox-hardware-requirements) |
| Every node *(add-on, on by default)* | **Ceph OSDs** — 0.5 thr / 1 GB base, +0.25 thr and +1 GB per TB raw; MON/MGR 0.5 thr / 4 GB once per cluster | Estimate | [Ceph hardware recommendations](https://docs.ceph.com/en/reef/start/hardware-recommendations/) |
| Every node *(add-on, off)* | ZFS ARC — 10% of host RAM | Estimate | [Proxmox requirements](https://www.cherryservers.com/blog/proxmox-hardware-requirements) |

Ceph's `osd_memory_target` defaults to **4 GiB per OSD**, and the hardware guide
advises provisioning ~8 GiB per BlueStore OSD once recovery headroom is allowed
for. At ~4 TB per OSD that is ~1 GiB per TB.

**OpenShift Virtualization**

Every request below is read off the manifest that ships it, at the component's
declared replica count. Nothing here is a sizing recommendation restated as a
request.

| Scope | Coefficient | Tier | Source |
|---|---|---|---|
| Every node *(Term A)* | **Kubelet `systemReserved`** — auto-sized from node size, CPU **and** RAM (§ 7a.3a) | **Verified** | `machine-config-operator` `kubelet-auto-sizing.yaml` |
| Every node | **virt-handler** (the only KubeVirt DaemonSet) — 10 m / 325 MiB | **Verified** | `kubevirt` `components/daemonsets.go:374` |
| Every node | **ovnkube-node** — 125 m / 1650 MiB summed across its 9 containers | **Verified** | `cluster-network-operator` `ovnkube-node.yaml` |
| Every node | Other node DaemonSets (multus, MCD, node-exporter, DNS, CSI) — 0.08 thr / 0.33 GB | Estimate | varies by platform and storage driver |
| **Once per cluster** | **virt-api + virt-controller + virt-exportproxy**, 2 replicas each — 0.04 thr / 1.81 GB | **Verified** | `kubevirt` `components/deployments.go` |
| **Once per cluster** | **HCO and the CNV operators** (virt, CDI, SSP, CNAO, HPP, AAQ, migration, autopilot) — 635 m / 2450 MiB | **Verified** | `hyperconverged-cluster-operator` `deploy/operator.yaml` |
| **Once per cluster** | **CDI** apiserver + controller + upload proxy — 300 m / 450 MiB | **Verified** | `containerized-data-importer` `pkg/operator/resources` |
| **Once per cluster** | **OpenShift cluster monitoring** — prometheus-k8s ×2, alertmanager-main ×2, thanos-querier ×2, kube-state-metrics, metrics-server and the operators: 240 m / 3179 MiB | **Verified** | `cluster-monitoring-operator` `assets/` |
| First 3 nodes | **Control plane** — 4 vCPU / 16 GB per master (published minimum) | **Verified** | [Master node sizing](https://github.com/openshift/openshift-docs/blob/main/modules/master-node-sizing.adoc) |
| Every node *(add-on, on by default)* | **ODF / Ceph** — Red Hat's published *2 CPU and 5 GiB per storage device*, converted to 0.5 thr and 1.25 GB per TB | Estimate | [ODF infrastructure requirements](https://docs.redhat.com/en/documentation/red_hat_openshift_data_foundation/4.20/html/planning_your_deployment/infrastructure-requirements_rhodf) |

**Red Hat's published "+2 cores and ~4 GB per node" is deliberately not a row
above.** It is a consumption-basis recommendation that amortises the control
plane across the workers; charged as a scheduler request it would double-count
the cluster scope. It is not carried as a *physical* line either — OpenShift
Virtualization has no measured per-VM resident figure, so the physical-capacity
design rule (§ 7a.5a) cannot fire for it, and a coefficient the engine never
reads would be an editable control that moves no number. Use the figure as a
sanity check on the itemised total, not as an input.

User-workload monitoring is excluded from the monitoring line: it is opt-in.
The node-exporter DaemonSet is excluded too — it is counted in the per-node row.

OpenShift uses **both** control-plane scopes, and they are not the same thing:
the three masters are genuinely per-node hardware (per-control-plane-node scope),
while the CNV control plane is a set of Deployments that exist once no matter how
many workers there are (cluster scope). Cluster monitoring is not an add-on
toggle because OpenShift does not ship without it.

#### Per-VM CPU: applicable only to the KubeVirt platforms

Harvester and OpenShift Virtualization run each guest in a pod, so the launcher
has a CPU **request** on top of the guest's own vCPU — 80 m/VM (§ 7a.5).

vSphere, AHV and Proxmox have no scheduler-request layer. Their per-VM CPU cost
is the hypervisor's scheduling overhead, which is already accounted for by the
vCPU:pCPU overcommit ratio the user sets in § 3. Modelling it again would
double-count, so those platforms carry no per-VM CPU term. For the same reason
they have no request-vs-physical split: on those platforms the two are the same
quantity.

### 7a.7 What is deliberately *not* applied

Harvester documents default allocation ratios of **1600% CPU / 150% RAM /
200% storage** ([Resource Overcommit](https://docs.harvesterhci.io/v1.8/vm/resource-overcommit/)).
These are **platform limits, not sizing recommendations** — nobody sizes a
production cluster at 16:1 CPU. The tool therefore **never** writes them into
your overcommit ratios, and selecting a platform leaves whatever you have set
untouched. Where a platform genuinely constrains overcommit (AHV cannot
overcommit memory), it is surfaced as a design-rule check so the decision stays
yours.

### 7a.8 Worked example

Exact fixture, so every figure below is reproducible:
`2 × 24 cores × 2 threads = 96 threads / 512 GB` hosts; uniform 4 vCPU / 16 GB
guests; **no GPUs**; host-local Longhorn storage at the default **3 replicas**;
rancher-monitoring on and every other add-on at its default (logging off,
Longhorn V2 off, GPU stack off since there are no devices); no coefficient
overrides.

| Term | 3 nodes / 50 VMs | 5 nodes / 100 VMs |
|---|---|---|
| A. kubelet reserve (1.42 thr/node) | 4.26 thr | 7.10 thr |
| B. every-node pods, excl. A (13.38 thr / 3.67 GB per node) | 40.14 thr / 11.0 GB | 66.90 thr / 18.3 GB |
| B′. cluster services (**counted once**) | 5.13 thr / 10.1 GB | 5.13 thr / 10.1 GB |
| C. per-VM overhead | 4.00 thr / 23.7 GB | 8.00 thr / 47.5 GB |
| D. per-device (no GPUs here) | — | — |
| E. storage reserve (0% default) | — | — |
| **Total (schedulable capacity removed)** | **53.52 thr / 44.9 GB** | **87.12 thr / 75.9 GB** |
| C′. storage engines — *physical RAM only* | *19.9 GB* | *39.8 GB* |

Row B's per-node figure is Longhorn 11.35 (12% of allocatable = 12% × 94.58) +
RKE2 agent 1.03 + virt 0.59 + Longhorn manager 0.26 + monitoring 0.10 + Rancher
agent 0.05 = 13.38 thr. Add row A's 1.42 for the 14.80 thr/node the tool reports
as "per node (every host)".

**Where the non-linearity now lives.** Row B′ is flat: identical at 3 nodes and
at 5. Holding VM count fixed and going 3 → 5 nodes costs **1.16× RAM**, not
1.667× — that is the singleton effect, and `test/e2e.js` asserts it. The
3n/50vm → 5n/100vm columns above grow faster (1.63× CPU, 1.69× RAM) because
they *also* double the VM count, and the per-VM terms scale with VMs. Two
different effects; do not read the column ratio as the node-scaling ratio.

Note row C′: at 100 VMs the storage engines alone want ~40 GB of physical RAM
that never appears in the schedulable-capacity total. v2.5.0 omitted it entirely.

Add GPUs and two further terms appear: Term D at 1 GiB per device, and the
`gpuStack` add-on (0.5 thr / 1.5 GB per node), which auto-enables.

The tool renders this table for your own configuration in the Virtualization
tab ("Overhead by Cluster Size") and in the PDF report.

### 7a.9 Calibration against a measured cluster

Every **Measured** coefficient above comes from
[Vicente Cheng's Harvester resource-footprint benchmark](https://gist.github.com/Vicente-Cheng/ae8d5ce743f94c0c9a333574813bc777):
a single-node vs 3-node comparison across idle, 2-VM and maximum-density phases,
reporting scheduler requests, pod usage and host consumption separately.

**Test bed:** Harvester v1.7.1 (kernel 6.4.0), KubeVirt 1.6.3, CDI 1.62.0,
Longhorn v1.10.2, LVM addon v1.8.0-rc5. Nodes: 2 sockets × 24 cores / 48 threads,
~128 GiB RAM, 2 TB SSD. Density VMs: openSUSE Tumbleweed, 2 vCPU / 2 GiB, one
disk. No rancher-monitoring, no rancher-logging. Standalone cluster (embedded
Rancher present; not imported into an external Rancher).

#### Memory — a two-point fit that lands on the measured skew

Measured Phase 1 requests: single-node **5745 Mi**; 3-node
**5745 / 3767 / 3075 Mi** (total 12 587 Mi). With `P` the per-node share and `S`
the singleton share:

```
S +  P =  5745        single node carries the singletons and its own share
S + 3P = 12587
      → P = 3421 Mi/node,   S = 2324 Mi once
```

This is more than algebra. The 3-node cluster's *leader* measured exactly
`P + S` = 5745 Mi, and the mean of the two non-leader nodes is
`(3767 + 3075) / 2` = **3421 Mi = P**. The decomposition reproduces the observed
node skew without having been fitted to it.

#### CPU — cross-checked across three independent nodes

Longhorn's guaranteed instance-manager CPU is 12% of **allocatable**
(`longhorn-manager/datastore/longhorn.go` reads `Status.Allocatable.Cpu()`), so
on a 48-thread node with a 1180 m kubelet reserve it is `0.12 × 46 820` =
5618 m. Single-node: `8488 − 5618` = **2870 m** of platform pods.

> That 2870 m is `Pc + Sc`, **not** `Pc`. `kubectl describe node` reports
> requests against *allocatable*, so the kubelet reserve is excluded — but the
> singleton is not, because on a one-node cluster the singletons live on that
> node. Charging 2870 m per node *and* a cluster lump would double-count `Sc`.

| Node | Requests | Longhorn (12% of allocatable) | Remainder |
|---|---|---|---|
| node1 (leader) | 5623 m | 2811 m | 2812 m = `Pc + Sc` |
| node2 | 4698 m | 2819 m | **1879 m = `Pc`** |
| node3 | 7448 m | 5958 m | 1490 m = `Pc` |

Taking `Pc` = 1879 m from node2 (a non-leader, so singleton-free) and solving
`Sc = 2870 − 1879` = **991 m**. Node1's independently measured remainder,
2812 m, reproduces `Pc + Sc` = 2870 m to within 2%.

Closing the loop at one node — all four CPU terms:

```
1180 (kubelet) + 5618 (Longhorn) + 1880 (Pc) + 990 (Sc) = 9668 m
measured ceiling: 8488 (requests) + 1180 (kubelet reserve) = 9668 m
```

#### Physical consumption

Host-consumed (`MemTotal − MemAvailable`) was 12.8 GiB at one node and
`13 399 + 6689 + 6774` = 26.2 GiB at three. The same two-point fit gives
**6.71 GiB per node** and **6.09 GiB once** — the two *physical only* rows in
§ 7a.4. Reassembled at maximum density (49 VMs/node, 128 GiB hosts) the model
predicts **48%** physical consumption against the benchmark's reported ~49%.

#### What this validated, and what it corrected

| | Before (v2.5.0) | Measured | Outcome |
|---|---|---|---|
| `MAX_PODS` (drives the +400 m tier) | 200, assumed | `MAX_PODS=200` in `upgrade_node.sh` | Confirmed → **Verified** |
| 1-node CPU requests | 9210 m | 8488 m | +8%, kept the structure |
| 3-node : 1-node RAM | **3.00×** | **2.19×** | **Corrected** — added the cluster scope |
| per-VM RAM (2c/2GiB) | 166 MiB | **421 MiB** | **Corrected** — fixed term 146 → 400 MiB |
| per-VM CPU | 0 | ~80 m | **Corrected** — term added |
| storage-engine RAM | 0 | ~136 MiB/replica | **Corrected** — term added |
| Longhorn 12% base | of capacity | of allocatable | **Corrected** |

#### Caveats — read these before trusting the figures

- **One benchmark, one hardware configuration, one Harvester version** (v1.7.1).
  It is a strong signal, not a specification.
- **No monitoring or logging add-ons were installed**, so those coefficients
  remain Estimate and are *not* validated by this data.
- **The 3-node cluster was probably not homogeneous.** Its reported CPU
  percentages imply nodes 1–2 had ~24 allocatable threads and node3 ~48,
  contradicting the document's statement that all nodes were identical. The
  memory fit is unaffected (it does not depend on thread count); the CPU
  decomposition leans on this inference and is correspondingly weaker.
- **Single-disk VMs.** Multi-disk guests multiply the storage-engine term.
- **The single-node run used LVM, not Longhorn**, for VM storage — which is why
  its storage-engine figure is ~49 MiB rather than tens of gigabytes.
- Requests, pod usage and host consumption differ by up to 2×. The tool sizes on
  requests (§ 7a.1a); physical consumption is tracked separately.

`test/benchmark.js` asserts that the shipped model reproduces every headline
figure in this section, so a future coefficient change that breaks the
calibration fails the build.

### 7a.10 Validation against a live cluster

A second, independent check against a running **Harvester v1.8.1** lab —
a different version, a different topology (2 compute + 1 witness) and different
host sizes from the v1.7.1 benchmark. All measurements were read-only
(`kubectl get`/`describe`, `/proc`, kubelet config); nothing was modified.

**Term A — kubelet reserve, against the real kubelet configuration.** The model
reproduces `/etc/rancher/rke2/config.yaml.d/99-z00-harvester-reserved-resources.yaml`
exactly, at three different core counts including the boundary case at exactly
4 cores:

| Node | Threads | Model (system / kube) | On the host |
|---|---|---|---|
| harv01lab | 24 | 424m / 636m | **424m / 636m** |
| harv02lab | 32 | 440m / 660m | **440m / 660m** |
| harvlab-witness | 4 | 384m / 576m | **384m / 576m** |

`capacity − reserve = allocatable` also matches to the millicore on all three,
and every node reports `allocatable.pods = 200`, confirming the `maxPods > 110`
tier that adds 400 mCPU.

**No kubelet memory reservation.** `capacity.memory == allocatable.memory` on all
three nodes — previously an inference from the upgrade script, now observed.

**Longhorn is 12% of allocatable, and CPU-only.** `longhorn-system` requests
2.753 threads on the 24-thread node (0.12 × 22.94 allocatable) and 3.708 on the
32-thread node (0.12 × 30.90) — exact on both, and *not* 12% of capacity. Its
memory requests are **zero**, confirming that instance-manager memory is
consumption rather than a request, which is why the model tracks it on the
physical basis.

**Settings.** `additional-guest-memory-overhead-ratio` default **1.5**,
`guaranteed-instance-manager-cpu` **{"v1":"12","v2":"12"}**,
`storage-reserved-percentage-for-default-disk` **0** — every value the model
hard-codes, confirmed on a newer release than the one they were read from.

**Term C — against 10 live virt-launcher pods.** Guests from 2 to 8 vCPU and
5.3 to 21.3 GiB of requested memory, one with GPU passthrough. Worst error
**0.0004%**; most rows match to the byte.

#### Two corrections it produced

The lab did not merely confirm the model — it falsified two details of it:

1. **VFIO was charged per device; it is per VM.** The `gpu-node` guest has *two*
   passthrough host devices and pays exactly **1 GiB** (× 1.5 = 1536 MiB), because
   KubeVirt's branch is `if HasVFIO(vmi)` — a boolean. The model previously
   multiplied by device count, over-stating any guest with more than one device.
2. **Page tables were computed on the guest size; they use the memory request.**
   The `rancher-host` guests are 32 GiB with 150% memory overcommit, so their
   request is 21.33 GiB and their overhead is 550 MiB, not the 570 MiB the guest
   size would imply.

Both are fixed, and `test/benchmark.js` asserts the corrected behaviour against
the live figures.

#### The core terms, decomposed directly

Because every workload declares its kind, the per-node and cluster-wide shares
can be separated **by observation** rather than by the two-point algebraic fit
§ 7a.9 relied on: a DaemonSet is per-node, a Deployment or StatefulSet is
cluster-wide. Excluding the Longhorn instance-manager, which is modelled
separately:

| | Model before | Live v1.8.1 | |
|---|---|---|---|
| per compute node | 1.88 thr / **3.34 GB** | 2.00 thr / **3.339 GB** | agrees to 0.03% |
| cluster-wide singletons | 0.99 thr / 2.27 GB | **3.875 thr / 7.135 GB** | 3–4× larger |

The per-node term is confirmed by two independent clusters. The cluster term was
**substantially under-modelled**, and the model now uses the measured multi-node
figures. See the note in § 7a.4 for why the single-node fit was so much smaller.

After this recalibration, the model predicts this cluster's total platform
requests to **+5% on CPU and +12% on RAM** (previously −19% / +23%). The residual
is the witness node: it is tainted, so most DaemonSets skip it, while the model
charges every node the same per-node cost.

#### CNI and version affect these figures

This lab runs **kube-ovn**; the v1.7.1 benchmark almost certainly ran canal,
which is lighter. Together with the version difference, that is the main reason
the two clusters disagree on the cluster term. The shipped coefficients reflect
**v1.8.1 with kube-ovn**. A canal-based cluster will cost less, and the model
will over-predict it — by roughly 40% on cluster RAM, judging by the v1.7.1
figures. This is not modelled as a toggle because only one measurement per CNI
exists, and a selector would imply precision that is not there. Adjust the
`cluster.*` coefficients if your CNI differs.

#### What this does *not* validate

The lab carries third-party workloads in namespaces that are not part of a
stock Harvester installation (`forklift`, `cloudcasa-io`, `techday`,
`cloudflare`, `cattle-turtles-system`) — confirmed as such by the cluster's
owner. Those were **excluded** from the platform comparison below; only
`kube-system`, `harvester-system`, `longhorn-system` and the
`cattle-monitoring`/`cattle-logging` add-ons were counted.

Even so, this is **not** a clean second data point for the per-node/singleton
(P/S) decomposition of § 7a.9: the witness topology differs from the
3-identical-node benchmark, and a witness node runs neither Longhorn nor the
virt stack. Comparing platform-only requests, the model under-predicts CPU by
~19% and over-predicts RAM by ~23% on this cluster — driven mostly by the
monitoring add-on, whose coefficients remain **Estimate** and which this cluster
runs more of than the model assumes. Those coefficients are still the weakest
part of the model, and a stock installation measured across varying node counts
remains the most valuable thing that could be added.

---

## 8. Host-count calculation

Let `ft` = fault tolerance, and define per-host physical capacity (after
**both** the automatic platform overhead of § 7a and the manual per-host
reserve):

```
host.cpu     = threads − reserve_threads − platform_overhead_cpu
host.ram     = ram − reserve_ram − platform_overhead_ram
host.storage = local storage × (1 − platform_storage_reserve_pct)
host.gpu     = GPUs
```

With no platform selected every platform term is zero and these collapse to the
original definitions — which is exactly what a configuration saved before this
feature loads with.

### Auto mode (size N identical hosts)

A single host type is chosen as the **building block**. For each resource:

```
min_by_vms     = ceil(total_vms        / max_vms_per_host)
min_by_cpu     = ceil(cpu_thread_demand / host.cpu)
min_by_ram     = ceil(ram_demand        / host.ram)
min_by_storage = ceil(storage_demand    / host.storage)     (0 if external)
min_by_gpu     = ceil(total_gpu         / host.gpu)          (0 if host has no GPUs)

min_hosts      = max(1, min_by_vms, min_by_cpu, min_by_ram, min_by_storage, min_by_gpu)
required_hosts = min_hosts + ft
decided_hosts  = manual override, else required_hosts
```

The **binding resource** is whichever `min_by_*` term dominates. Per-host
utilisation is then reported for two states:

```
normal   per-host demand = ceil(resource_demand / decided_hosts)
degraded per-host demand = ceil(resource_demand / (decided_hosts − ft))
```

The degraded column confirms the surviving hosts can still carry the full load
after `ft` failures.

### Pool mode (check a mixed inventory)

Each host type has a **quantity**. Aggregate capacity is summed across all
hosts, then the **`ft` largest hosts are removed** (worst-case failure) to get
*surviving* capacity, evaluated per resource independently:

```
surviving(R) = Σ capacity_R(all hosts) − Σ capacity_R(ft largest hosts for R)
feasible(R)  = demand(R) ≤ surviving(R)
```

The inventory is **sufficient** when every resource (vCPU threads, RAM, storage,
GPU, VM slots) passes and there are more hosts than `ft`. This is an
aggregate-capacity check with a failure reserve — appropriate for capacity
planning. It is **not** a bin-packing placement solver: it assumes the scheduler
can balance VMs across heterogeneous hosts, so always confirm that the largest
individual VM still fits the largest individual host (Rule 1).

---

## 9. Disaster recovery (sites)

Each additional site is sized as a **full symmetric copy** of the primary
cluster, so all provisioned hardware (hosts, cores, RAM, storage, GPUs) and the
external-array usable capacity are multiplied by the number of sites. The DR
strategy field (active/active, active/passive, async replication, RPO/RTO) is
captured for documentation but does not yet model replication bandwidth or
asymmetric DR sites — see Limitations.

---

## 10. Best-practice alignment and deliberate choices

| Topic | This tool | Best-practice basis |
| --- | --- | --- |
| SMT counted as schedulable threads | Yes, by default | Standard consolidation practice; offset by adjustable overcommit and the note that SMT ≠ 2× throughput. |
| Default CPU overcommit | 1.0× on threads (conservative) | Production-safe starting point; raise per workload class (§3). |
| GPU/AI overcommit | Pinned 1:1 (enforced) | NVIDIA vGPU/MIG & passthrough guidance; accelerated VMs are not oversubscribed. |
| Memory overcommit | 1.0× default | Memory overcommit risks OOM; discouraged for production/AI. |
| Storage replication | ×3 default | SUSE Storage / Longhorn documented default. |
| Volume placement | Largest volume must fit one host | Longhorn replicas are per-node, not striped. |
| Failure reserve | N+2 default (failure + maintenance spare) | VMware HA admission control; general HA spare-capacity principle. |
| Host OS / hypervisor overhead | Optional reservation, default 0 | Reference parity by default; reservation recommended for production. |
| VM density ceiling | 40 VMs/host default | Conservative; analogous to kubelet's 110-pod default. |

---

## 11. Limitations

- Aggregate capacity checks, **not** an optimal bin-packing/placement solver.
- NUMA, CPU pinning topology, huge pages and PCIe/NUMA locality are not modelled
  beyond the 1:1 GPU pin.
- Network throughput/latency (e.g. Longhorn's 10 GbE recommendation, storage
  fabric bandwidth, DR replication links) is not sized.
- DR is symmetric only; no async-replication overhead or asymmetric site sizing.
- Licensing (per-core / per-socket) is not computed.
- Platform overhead RAM coefficients are **measured, not specified** — Harvester
  configures no kubelet memory reservation, so there is no vendor formula to
  cite (§ 7a.1). They come from a single benchmark on one hardware
  configuration (§ 7a.9). Every coefficient is editable; measurements from your
  own clusters beat these defaults.
- Overhead is denominated in **scheduler requests** (§ 7a.1a). Memory that is
  consumed but not requested is tracked separately and does not affect the
  recommended host count — only the physical-capacity design rule.
- The model spreads the cluster-singleton overhead across the fleet, then flags
  that one node actually carries it. It does not size that node individually,
  so a deliberately heterogeneous control plane is not modelled.
- Dedicated-witness and other asymmetric-role topologies are not modelled.
- Anyone with cluster access can produce a calibration point without knowing
  anything about this model: `test/measurements/capture/` holds read-only
  capture scripts for all five platforms, and `validate.js` scores the result
  against the coefficients term by term. For vSphere and AHV this is now the
  *only* route to better numbers, since neither vendor publishes them
  (§ 7a.6a).
- **Only the Harvester model is calibrated.** vSphere, Proxmox, AHV and
  OpenShift Virtualization now model every significant category, but from vendor
  documentation and shipped manifests rather than measurement (§ 7a.1b), so
  their coefficients are less precise. Cross-platform comparison is indicative
  of shape, not a benchmark. The error does **not** run consistently in one
  direction: OpenShift Virtualization is sourced from declared requests and a
  transcribed reserve formula, so it may sit close or high, whereas vSphere,
  AHV and Proxmox are doc-sketch coefficients that more likely understate.
  Do not assume an uncalibrated total is a floor.
- Storage-service terms are expressed per TB of raw disk, converted from
  per-device vendor figures assuming ~4 TB devices. A cluster built from many
  small devices will cost more than the model predicts, and one built from few
  large devices less. Adjust the per-TB coefficient if your device size differs
  materially.
- All numbers are planning estimates — verify against current SUSE documentation.

---

## 12. References

These informed the methodology. URLs may change; search the vendor docs for the
current page.

- **SUSE Virtualization (Harvester)** — hardware & sizing requirements:
  <https://docs.harvesterhci.io/v1.8/install/requirements/>
- **KubeVirt** (VM engine under Harvester) — CPU allocation ratio / overcommit:
  <https://kubevirt.io/user-guide/compute/node_overcommit/>
- **SUSE Storage / Longhorn** — best practices & default 3 replicas:
  <https://longhorn.io/docs/latest/best-practices/>
- **Kubernetes** — large-cluster considerations, default 110 pods/node:
  <https://kubernetes.io/docs/setup/best-practices/cluster-large/>
- **VMware vSphere** — CPU overcommit / Hyper-Threading performance guidance and
  HA *admission control* (failover capacity reservation):
  <https://docs.vmware.com/en/VMware-vSphere/index.html>
- **Red Hat OpenShift Virtualization / Virtualization** — overcommit and
  resource-reservation guidance for KubeVirt-based platforms:
  <https://docs.redhat.com/en/documentation/openshift_container_platform/latest/html/virtualization/>
- **NVIDIA vGPU / MIG** — GPU partitioning and passthrough (no oversubscription
  of a physical GPU partition):
  <https://docs.nvidia.com/vgpu/>
- **SUSE AI** — product overview and deployment guidance:
  <https://documentation.suse.com/suse-ai/>

### Platform-overhead sources (§ 7a)

Cited per coefficient in § 7a. Grouped here by tier.

**Measured — independent benchmark of a real cluster (see § 7a.9 for caveats):**

- Harvester resource-footprint benchmark, Vicente Cheng — single-node vs 3-node
  Harvester v1.7.1 across idle, 2-VM and maximum-density phases, reporting
  scheduler requests, pod usage and host consumption separately:
  <https://gist.github.com/Vicente-Cheng/ae8d5ce743f94c0c9a333574813bc777>

**Verified — vendor source code or a reproduced worked example:**

- Harvester, kubelet CPU reservation formula —
  `harvester/harvester pkg/installer/config/config.go:565`
  (`calculateCPUReservedInMilliCPU`), `GetSystemReserved` in the same file, and
  `package/upgrade/upgrade_node.sh:446` (`set_reserved_resource`). Note it emits
  **CPU only** — there is no kubelet memory reservation.
- Harvester, published worked example the formula reproduces (16 cores →
  408 m + 612 m = 1020 m): <https://docs.harvesterhci.io/v1.8/vm/cpu-pinning>
  (§ Calculation of Shared CPU Pool)
- GKE node resource reservations (the tier table Harvester derives from):
  <https://docs.cloud.google.com/kubernetes-engine/docs/concepts/plan-node-sizes>
- Harvester, Longhorn defaults — `pkg/installer/config/cos.go:35-49`
  (`defaultGuaranteedInstanceManagerCPU = 12`,
  `defaultStorageReservedPercentageForDefaultDisk = 0`,
  `maxStorageReservedPercentageForDefaultDisk = 30`), the 12% cap in
  `cos.go:336`, and `pkg/controller/master/setting/instance_manager_resources.go:71`
  (`syncLHIMResourcesToLonghornDefault`)
- Longhorn setting definitions — `longhorn/longhorn-manager types/setting.go:1134`
  (Guaranteed Instance Manager CPU, default `{"v1":"12","v2":"12"}`, range 0–40,
  data-engine specific) and `types/setting.go:649` (Storage Reserved Percentage,
  default 30%)
- Longhorn guaranteed instance-manager CPU is a percentage of **allocatable**,
  not capacity — `longhorn/longhorn-manager datastore/longhorn.go` multiplies
  `kubeNode.Status.Allocatable.Cpu().MilliValue()`
- Harvester kubelet max-pods — `package/upgrade/upgrade_node.sh`, `MAX_PODS=200`,
  which is what triggers the +400 mCPU tier of the reservation formula
- Longhorn instance-manager consolidation (one pod per node **per data engine**):
  `longhorn/longhorn` enhancement `20230303-consolidate-instance-managers.md`
- OpenShift Virtualization per-VM memory formula and +1 GiB per GPU/SR-IOV
  device: <https://developers.redhat.com/blog/2025/01/31/memory-management-openshift-virtualization>

**Estimate — vendor documentation, blog or community measurement:**

- Harvester hardware requirements (production 16 c / 64 GB / 500 GB per node):
  <https://docs.harvesterhci.io/v1.8/install/requirements/>
- Harvester resource overcommit — the 1600% / 150% / 200% *limits* that this
  tool deliberately does **not** apply as sizing targets:
  <https://docs.harvesterhci.io/v1.8/vm/resource-overcommit/>
- KubeVirt virt-launcher overhead components (75 Mi + 30 Mi qemu + 8 Mi/vCPU):
  <https://kubevirt.io/user-guide/compute/resources_requests_and_limits/>
- Longhorn best practices: <https://longhorn.io/docs/1.12.0/best-practices/>
- VMware ESX/ESXi memory resource management (per-VM overhead):
  <https://www.vmware.com/docs/perf-vsphere-memory_management>
- Nutanix AHV memory overcommit and CPU resource management (CVM footprint):
  <https://www.nutanix.com/tech-center/blog/ahv-internals-memory-overcommit>,
  <https://www.nutanix.com/tech-center/blog/understanding-cpu-resource-management-in-nutanix-ahv>
- Proxmox VE hardware requirements:
  <https://www.cherryservers.com/blog/proxmox-hardware-requirements>

---

*Generated for the SUSE AI Sizing Architect (`index.html`). The authoritative
implementation of these formulas is the `virtSummary` computation in that file.*
