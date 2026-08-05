#!/usr/bin/env bash
# Capture a calibration point from Harvester or OpenShift Virtualization.
#
#   ./capture-kubevirt.sh > mycluster.json
#   ./capture-kubevirt.sh --names > mylab.json     # keep real names (your own lab)
#
# READ-ONLY: every call is `get`. Nothing is created, patched, deleted, scaled
# or powered on. The script is short on purpose — read it before running it
# against production.
#
# Needs: kubectl (or oc) with cluster-wide read, and jq.
#
# What it measures, and why that shape:
#   - the kubelet reserve, as capacity minus allocatable (both CPU and memory,
#     because OpenShift reserves memory and Harvester does not);
#   - per-node terms from DaemonSet pods only, grouped by namespace;
#   - cluster terms from everything else, summed ONCE across all namespaces.
# The DaemonSet/Deployment split is the whole game: charging a control plane
# per node overstates a 20-node cluster badly, and this measures the split
# directly instead of inferring it.
set -euo pipefail

ANON=1
for a in "$@"; do
  case "$a" in
    --names) ANON=0 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

KUBECTL="${KUBECTL:-}"
if [ -z "$KUBECTL" ]; then
  if command -v kubectl >/dev/null 2>&1; then KUBECTL=kubectl
  elif command -v oc  >/dev/null 2>&1; then KUBECTL=oc
  else echo "need kubectl or oc on PATH" >&2; exit 2; fi
fi
command -v jq >/dev/null 2>&1 || { echo "need jq on PATH" >&2; exit 2; }

# Fixture hook: the test suite runs this script against recorded JSON so the
# jq below is actually exercised rather than trusted. Unset in real use.
kget() {
  local name="$1"; shift
  if [ -n "${CAPTURE_FIXTURES:-}" ]; then cat "$CAPTURE_FIXTURES/$name.json"; return; fi
  "$KUBECTL" get "$@" -o json
}

NODES_JSON=$(kget nodes nodes)
PODS_JSON=$(kget pods pods -A --field-selector=status.phase=Running)

# Platform: Harvester ships its own settings CRD; OpenShift Virt ships HCO.
PLATFORM=ocpvirt
if [ -n "${CAPTURE_PLATFORM:-}" ]; then PLATFORM="$CAPTURE_PLATFORM"
elif "$KUBECTL" get settings.harvesterhci.io >/dev/null 2>&1; then PLATFORM=harvester
fi

PLATVER=$( { "$KUBECTL" get settings.harvesterhci.io server-version -o jsonpath='{.value}' 2>/dev/null \
          || "$KUBECTL" get csv -n openshift-cnv -o jsonpath='{.items[0].spec.version}' 2>/dev/null; } || true)
KUBEVER=$(echo "$NODES_JSON" | jq -r '.items[0].status.nodeInfo.kubeletVersion // ""')

# VMs are optional: a cluster with none still calibrates the node terms.
VMI_JSON=$(kget vmis vmi -A 2>/dev/null || echo '{"items":[]}')

export ANON PLATFORM PLATVER KUBEVER
jq -n \
  --argjson nodes "$NODES_JSON" \
  --argjson pods  "$PODS_JSON" \
  --argjson vmis  "$VMI_JSON" \
  --arg anon "$ANON" --arg platform "$PLATFORM" \
  --arg platver "$PLATVER" --arg kubever "$KUBEVER" '

# ---- helpers ---------------------------------------------------------------
# Kubernetes quantities: CPU in cores (may be "500m"), memory in bytes with
# binary suffixes. Parse both to a number rather than trusting a regex.
def cpu2thr: if . == null then 0
  elif type == "string" and endswith("m") then (.[:-1] | tonumber) / 1000
  else tonumber end;
def mem2gib: if . == null then 0 else (
    tostring
    | if   endswith("Ki") then (.[:-2] | tonumber) / 1048576
      elif endswith("Mi") then (.[:-2] | tonumber) / 1024
      elif endswith("Gi") then (.[:-2] | tonumber)
      elif endswith("Ti") then (.[:-2] | tonumber) * 1024
      elif endswith("k")  then (.[:-1] | tonumber) / 1073741824 * 1000
      elif endswith("M")  then (.[:-1] | tonumber) / 1073741824 * 1000000
      elif endswith("G")  then (.[:-1] | tonumber) / 1073741824 * 1000000000
      else (tonumber / 1073741824) end) end;
def r3: . * 1000 | round / 1000;

($anon == "1") as $anonymize |

# Stable pseudonyms, assigned in the order things appear.
($nodes.items | map(.metadata.name)) as $nodeNames |
def nodeAlias($n): if $anonymize then
    ($nodeNames | index($n)) as $i | if $i == null then "node-?" else "node-\($i + 1)" end
  else $n end;
($pods.items | map(.metadata.namespace) | unique) as $nsList |
def nsAlias($n): if $anonymize then "ns-\(($nsList | index($n)) + 1)" else $n end;

# A pod is per-node if a DaemonSet owns it. Static pods (owner kind "Node",
# how RKE2 and OpenShift run etcd/apiserver) live only on control-plane nodes,
# so they are a cluster cost, not a per-node one.
def scopeOf: (.metadata.ownerReferences // [] | .[0].kind // "none")
  | if . == "DaemonSet" then "per-node" else "cluster" end;

# A virt-launcher pod IS a virtual machine, not platform overhead. It is owned
# by a VirtualMachineInstance, so the ownerReferences test above happily filed
# it as a cluster workload and added the whole guest to the control-plane
# figure. Exclude launchers from both scopes; they are measured as VMs below.
def isLauncher: ((.metadata.labels // {})["kubevirt.io"] == "virt-launcher")
  or ((.metadata.annotations // {}) | has("kubevirt.io/domain"));
def isPlatform: (isLauncher | not);

# Effective pod request: init containers run before the rest, so the pod needs
# the MAX of (largest init, sum of the others) — the same arithmetic the
# scheduler does. Getting this wrong inflates any pod with a heavy init.
def podCpu: ([.spec.containers[]?.resources.requests.cpu // "0" | cpu2thr] | add // 0) as $c
  | ([.spec.initContainers[]?.resources.requests.cpu // "0" | cpu2thr] | max // 0) as $i
  | if $i > $c then $i else $c end;
def podRam: ([.spec.containers[]?.resources.requests.memory // "0" | mem2gib] | add // 0) as $c
  | ([.spec.initContainers[]?.resources.requests.memory // "0" | mem2gib] | max // 0) as $i
  | if $i > $c then $i else $c end;

# ---- nodes -----------------------------------------------------------------
($nodes.items | map({
    name: nodeAlias(.metadata.name),
    threads: (.status.capacity.cpu | tonumber),
    ramGiB: (.status.capacity.memory | mem2gib | r3),
    role: (if (.metadata.labels // {}) | has("node-role.kubernetes.io/control-plane")
           then "control-plane" else "worker" end),
    _capCpu: (.status.capacity.cpu | cpu2thr),
    _allocCpu: (.status.allocatable.cpu | cpu2thr),
    _capMem: (.status.capacity.memory | mem2gib),
    _allocMem: (.status.allocatable.memory | mem2gib),
  })) as $n |

# Reference node: the biggest worker, since per-node terms are quoted per host
# type and the model recomputes them for each host anyway.
(($n | map(select(.role == "worker")) | sort_by(-.threads) | .[0])
 // ($n | sort_by(-.threads) | .[0])) as $ref |

# ---- terms -----------------------------------------------------------------
# Kubelet reserve = capacity - allocatable. Reported for the reference node.
[{ key: "kubelet", modelKey: "kubelet", scope: "per-node", basis: "reserve",
   node: $ref.name,
   cpuThreads: (($ref._capCpu - $ref._allocCpu) | r3),
   ramGiB: (($ref._capMem - $ref._allocMem) | r3),
   detail: "capacity minus allocatable" }]

# Per-node: DaemonSet pods on the reference node, grouped by namespace.
+ ([ $pods.items[]
     | select(isPlatform)
     | select(scopeOf == "per-node")
     | select(if $anonymize then nodeAlias(.spec.nodeName) else .spec.nodeName end == $ref.name)
   ] | group_by(.metadata.namespace)
     | map({ key: nsAlias(.[0].metadata.namespace), scope: "per-node", basis: "request",
             node: $ref.name,
             cpuThreads: ([.[] | podCpu] | add | r3),
             ramGiB: ([.[] | podRam] | add | r3),
             detail: "\(length) DaemonSet pod(s)" })
     | map(select(.cpuThreads > 0 or .ramGiB > 0)))

# Cluster: everything that is not a DaemonSet, counted once. This is complete
# by construction, so the validator may compare the total.
+ [ { key: "all-cluster-workloads", scope: "cluster", basis: "request", complete: true,
      cpuThreads: ([ $pods.items[] | select(isPlatform) | select(scopeOf == "cluster") | podCpu ] | add // 0 | r3),
      ramGiB:     ([ $pods.items[] | select(isPlatform) | select(scopeOf == "cluster") | podRam ] | add // 0 | r3),
      detail: "every non-DaemonSet platform pod in every namespace, counted once (virt-launcher pods excluded — they are VMs)" } ]
  as $terms |

# ---- VMs -------------------------------------------------------------------
# overheadMiB is the compute-container memory request of the launcher, minus
# the guest request — the same subtraction the per-VM model term predicts.
([ $vmis.items[]? ] | to_entries | map(
   .key as $i | .value as $v
   | ($v.spec.domain.cpu // {}) as $c
   | (($c.sockets // 1) * ($c.cores // 1) * ($c.threads // 1)) as $topo
   | (if $v.spec.domain.resources.requests.cpu
        then ($v.spec.domain.resources.requests.cpu | cpu2thr) else $topo end) as $vcpu
   | (($v.spec.domain.resources.requests.memory // $v.spec.domain.memory.guest) | mem2gib) as $req
   | ([ $pods.items[]
        | select((.metadata.annotations // {})["kubevirt.io/domain"] == $v.metadata.name)
        | .spec.containers[] | select(.name == "compute")
        | .resources.requests.memory | mem2gib ] | first) as $launcher
   | { name: (if $anonymize then "vm-\($i + 1)" else $v.metadata.name end),
       vcpu: $vcpu,
       reqMemGiB: ($req | r3),
       vfio: (if (($v.spec.domain.devices.hostDevices // []) + ($v.spec.domain.devices.gpus // []) | length) > 0
              then 1 else 0 end) }
   + (if $launcher == null then { overheadMiB: null,
        note: "no running virt-launcher found; overhead not measured" }
      else { overheadMiB: (($launcher - $req) * 1024 | round) } end)
 ) | map(select(.overheadMiB != null))) as $vms |

# ---- output ----------------------------------------------------------------
{ schema: "suse-ai-sizing-tool/measurement/v1",
  platform: $platform,
  capturedAt: (now | todateiso8601),
  anonymized: $anonymize,
  versions: { platform: (if $platver == "" then null else $platver end),
              kubernetes: (if $kubever == "" then null else $kubever end) },
  nodes: ($n | map(del(._capCpu, ._allocCpu, ._capMem, ._allocMem))),
  terms: $terms,
  vms: $vms,
  notes: [
    "Per-node terms are quoted for \($ref.name) (\($ref.threads) threads).",
    "Scope comes from workload kind: DaemonSet is per-node, everything else is counted once.",
    "Pod requests use max(largest init container, sum of containers), as the scheduler does.",
    ("Add-ons installed are NOT detected — set \"addons\" by hand if the cluster runs " +
     "monitoring or logging, or the validator will score against the wrong configuration.")
  ] }
'
