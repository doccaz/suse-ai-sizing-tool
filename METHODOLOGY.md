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
cpu_thread_demand = gpu_vcpu  +  nongpu_vcpu / vcpu_ratio
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
ram_demand = gpu_ram  +  nongpu_ram / ram_ratio
```

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
5. **Host-OS overhead** — the spreadsheet ignored hypervisor/OS CPU and RAM. As
   a best-practice refinement, each host type has optional **reserve threads**
   and **reserve RAM** fields to set aside capacity for the hypervisor, KubeVirt,
   Longhorn and the OS. They default to **0** to match the reference baseline;
   reserving a few threads and ~16–64 GB RAM per host is recommended for
   production.

---

## 8. Host-count calculation

Let `ft` = fault tolerance, and define per-host physical capacity (after
reservation):

```
host.cpu     = threads − reserve_threads
host.ram     = ram − reserve_ram
host.storage = local storage
host.gpu     = GPUs
```

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
- All numbers are planning estimates — verify against current SUSE documentation.

---

## 12. References

These informed the methodology. URLs may change; search the vendor docs for the
current page.

- **SUSE Virtualization (Harvester)** — hardware & sizing requirements:
  <https://docs.harvesterhci.io/latest/install/requirements>
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

---

*Generated for the SUSE AI Sizing Architect (`index.html`). The authoritative
implementation of these formulas is the `virtSummary` computation in that file.*
