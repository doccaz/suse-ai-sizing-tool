#!/usr/bin/env bash
# Capture a calibration point from a Proxmox VE node.
#
#   ./capture-proxmox.sh > mycluster.json          (run as root on any PVE node)
#   ./capture-proxmox.sh --names > mylab.json
#
# READ-ONLY: `pvesh get`, `ps`, and reads under /proc and /sys. Nothing is
# created, set, started or stopped.
#
# NOT YET VERIFIED against a real Proxmox cluster — the command set is from the
# documentation, not from a run. If it breaks, the fix is probably in one of
# the three parsers below and the numbers it prints are worth more than the
# script is. Report what it did.
#
# Proxmox is the platform most worth measuring: every one of its coefficients
# currently traces to a third-party blog (METHODOLOGY § 7a.6a), and it is free
# to install nested, so a 1-node and then 3-node capture gives the same
# per-node/cluster decomposition that calibrated Harvester.
#
# Needs: pvesh, jq.
set -euo pipefail

ANON=1
for a in "$@"; do
  case "$a" in
    --names) ANON=0 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done
command -v jq >/dev/null 2>&1 || { echo "need jq on PATH" >&2; exit 2; }

pget() {   # $1 = fixture name, $2 = API path
  if [ -n "${CAPTURE_FIXTURES:-}" ]; then cat "$CAPTURE_FIXTURES/$1.json"; return; fi
  pvesh get "$2" --output-format json
}

NODES_JSON=$(pget pve-nodes /nodes)
RES_JSON=$(pget pve-resources /cluster/resources)
PVEVER=$( { pveversion 2>/dev/null || echo ""; } | head -1)

# Per-VM overhead, the one figure no vendor publishes: a running guest's RSS
# minus what the guest itself was given. The qemu process RSS includes the
# emulator, device models and page tables — the same thing KubeVirt calls
# overhead and ESXi calls VMMEM.
VM_OVERHEAD="[]"
if [ -z "${CAPTURE_FIXTURES:-}" ]; then
  rows=""
  for pidfile in /var/run/qemu-server/*.pid; do
    [ -e "$pidfile" ] || continue
    vmid=$(basename "$pidfile" .pid)
    pid=$(cat "$pidfile" 2>/dev/null) || continue
    rssKb=$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ') || continue
    [ -n "$rssKb" ] || continue
    # qm config is a read; parse the configured memory and core count.
    cfg=$(qm config "$vmid" 2>/dev/null || true)
    memMb=$(echo "$cfg" | awk -F': *' '/^memory:/{print $2; exit}')
    cores=$(echo "$cfg" | awk -F': *' '/^cores:/{print $2; exit}')
    sockets=$(echo "$cfg" | awk -F': *' '/^sockets:/{print $2; exit}')
    hostpci=$(echo "$cfg" | grep -c '^hostpci' || true)
    [ -n "$memMb" ] || continue
    vcpu=$(( ${cores:-1} * ${sockets:-1} ))
    rows="$rows{\"vmid\":$vmid,\"vcpu\":$vcpu,\"memMb\":$memMb,\"rssKb\":$rssKb,\"vfio\":$((hostpci > 0 ? 1 : 0))},"
  done
  VM_OVERHEAD="[${rows%,}]"
else
  VM_OVERHEAD=$(cat "$CAPTURE_FIXTURES/pve-vms.json")
fi

# ZFS ARC is the dominant term when ZFS is in use, and it is invisible to the
# process accounting above because it lives in the kernel.
ARC_GIB=0
[ -r /proc/spl/kstat/zfs/arcstats ] && \
  ARC_GIB=$(awk '/^size /{printf "%.3f", $3/1073741824}' /proc/spl/kstat/zfs/arcstats)

# Host consumption: what the hypervisor and its services actually use, with the
# guests subtracted. MemAvailable is the honest denominator (free + reclaimable).
MEM_TOTAL_GIB=$(awk '/^MemTotal:/{printf "%.3f", $2/1048576}' /proc/meminfo)
MEM_AVAIL_GIB=$(awk '/^MemAvailable:/{printf "%.3f", $2/1048576}' /proc/meminfo)
THREADS=$(getconf _NPROCESSORS_ONLN)

jq -n \
  --argjson nodes "$NODES_JSON" --argjson res "$RES_JSON" --argjson vms "$VM_OVERHEAD" \
  --arg anon "$ANON" --arg ver "$PVEVER" --arg arc "$ARC_GIB" \
  --arg total "$MEM_TOTAL_GIB" --arg avail "$MEM_AVAIL_GIB" --arg threads "$THREADS" '
def r3: . * 1000 | round / 1000;
($anon == "1") as $anonymize |
($vms | map(.rssKb / 1048576) | add // 0) as $guestRssGiB |
(($total | tonumber) - ($avail | tonumber) - $guestRssGiB) as $hostGiB |

{ schema: "suse-ai-sizing-tool/measurement/v1",
  platform: "proxmox",
  capturedAt: (now | todateiso8601),
  anonymized: $anonymize,
  versions: { platform: $ver },
  nodes: ($nodes | to_entries | map({
    name: (if $anonymize then "node-\(.key + 1)" else .value.node end),
    threads: (.value.maxcpu // ($threads | tonumber)),
    ramGiB: ((.value.maxmem // 0) / 1073741824 | r3),
    role: "worker" })),

  # Everything here is basis "physical": KVM has no scheduler-request layer, so
  # what is reserved and what is used are the same number. The validator
  # rejects a "request" figure from this platform for exactly that reason.
  terms: ([
    { key: "host-services", scope: "per-node", basis: "physical",
      cpuThreads: null, ramGiB: ($hostGiB | r3),
      detail: "MemTotal - MemAvailable - sum(guest RSS): the PVE host OS, its services and the qemu emulators" }
  ] + (if ($arc | tonumber) > 0 then
    [{ key: "zfsArc", modelKey: "addon.zfsArc", scope: "per-node", basis: "physical",
       ramGiB: ($arc | tonumber | r3),
       detail: "ZFS ARC (kernel; not visible in process accounting)" }] else [] end)
    | map(with_entries(select(.value != null)))),

  vms: ($vms | to_entries | map({
    name: (if $anonymize then "vm-\(.key + 1)" else "vm-\(.value.vmid)" end),
    vcpu: .value.vcpu,
    reqMemGiB: (.value.memMb / 1024 | r3),
    vfio: .value.vfio,
    overheadMiB: ((.value.rssKb / 1024) - .value.memMb | round) })),

  notes: [
    "Per-VM overhead is qemu process RSS minus configured guest memory. A guest that has not touched all its memory reports LESS than its full footprint, so capture from VMs that have been running under load.",
    "Ballooning distorts the same figure — note whether it is enabled.",
    "Cluster-scope services (corosync, pve-cluster, pvedaemon) are inside host-services here; capture a 1-node and a 3-node cluster to separate them."
  ] }
'
