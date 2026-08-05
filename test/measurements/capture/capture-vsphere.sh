#!/usr/bin/env sh
# Capture a calibration point from an ESXi host.
#
#   ./capture-vsphere.sh > myhost.json         (run in the ESXi shell, or over SSH)
#   ./capture-vsphere.sh --names > mylab.json
#
# READ-ONLY: `esxcli ... get/list` and `vim-cmd ... get/getallvms` only. Nothing
# is set, powered on, powered off, migrated or reconfigured.
#
# NOT YET VERIFIED against a real ESXi host — written from the documented
# command output, not from a run. The vim-cmd parsers are the fragile part.
#
# POSIX sh + awk only: the ESXi shell has no bash and no jq, so the JSON is
# assembled by hand below. That is why this script looks the way it does.
#
# Why this capture matters more than the others: Broadcom publishes NO per-VM
# overhead table or formula for any supported release (METHODOLOGY § 7a.6a) —
# the docs tell you to power a VM on and read VMMEM from its log. The model's
# per-VM line is therefore an unbacked linear approximation. The
# `runtime.memoryOverhead` field read below IS that number. A handful of
# differently-sized VMs from one host is enough to fit or refute the line.
set -eu

ANON=1
for a in "$@"; do
  case "$a" in
    --names) ANON=0 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

if [ -n "${CAPTURE_FIXTURES:-}" ]; then
  vimcmd() { cat "$CAPTURE_FIXTURES/vim-$1.txt"; }
  esxc()   { cat "$CAPTURE_FIXTURES/esxcli-$1.txt"; }
else
  command -v vim-cmd >/dev/null 2>&1 || { echo "run this on an ESXi host (vim-cmd not found)" >&2; exit 2; }
  vimcmd() {
    case "$1" in
      allvms)  vim-cmd vmsvc/getallvms ;;
      host)    vim-cmd hostsvc/hostsummary ;;
      *)       vim-cmd vmsvc/get.summary "$1" ;;
    esac
  }
  esxc() {
    case "$1" in
      mem) esxcli hardware memory get ;;
      cpu) esxcli hardware cpu global get ;;
      ver) esxcli system version get ;;
    esac
  }
fi

# ---- host ------------------------------------------------------------------
# "Physical Memory: 549755813888 Bytes"
HOST_MEM_GIB=$(esxc mem | awk '/Physical Memory/ {printf "%.3f", $3/1073741824; exit}')
THREADS=$(esxc cpu | awk -F': *' '/CPU Threads/ {print $2; exit}')
VERSION=$(esxc ver | awk -F': *' '/^ *Version/ {print $2; exit}')

# hostsummary quickStats reports what the host is using, in MB.
HOST_USED_MIB=$(vimcmd host | awk -F'= *' '/overallMemoryUsage/ {gsub(/[^0-9]/,"",$2); print $2; exit}')

# ---- VMs -------------------------------------------------------------------
# getallvms lines start with the numeric vmid; anything else is the header.
VMIDS=$(vimcmd allvms | awk '$1 ~ /^[0-9]+$/ {print $1}')

vm_json=""
guest_mib_total=0
i=0
for id in $VMIDS; do
  s=$(vimcmd "$id" 2>/dev/null) || continue
  # memoryOverhead is in BYTES and is the field the docs point at (== VMMEM).
  # It is only populated while the VM is powered on.
  oh=$(echo "$s"   | awk -F'= *' '/memoryOverhead/    {gsub(/[^0-9]/,"",$2); print $2; exit}')
  mem=$(echo "$s"  | awk -F'= *' '/memorySizeMB/      {gsub(/[^0-9]/,"",$2); print $2; exit}')
  cpu=$(echo "$s"  | awk -F'= *' '/numCpu/            {gsub(/[^0-9]/,"",$2); print $2; exit}')
  pow=$(echo "$s"  | awk           '/powerState/       {print; exit}')
  case "$pow" in *poweredOn*) ;; *) continue ;; esac
  [ -n "${oh:-}" ] && [ -n "${mem:-}" ] && [ -n "${cpu:-}" ] || continue
  [ "$oh" -gt 0 ] 2>/dev/null || continue
  i=$((i + 1))
  name="vm-$i"
  if [ "$ANON" = "0" ]; then
    name=$(echo "$s" | awk -F'= *' '/^ *name = /{gsub(/[",]/,"",$2); print $2; exit}')
  fi
  ohMib=$((oh / 1048576))
  guest_mib_total=$((guest_mib_total + mem + ohMib))
  [ -n "$vm_json" ] && vm_json="$vm_json,"
  vm_json="$vm_json
    {\"name\":\"$name\",\"vcpu\":$cpu,\"reqMemGiB\":$(awk "BEGIN{printf \"%.3f\", $mem/1024}"),\"vfio\":0,\"overheadMiB\":$ohMib}"
done

# VMkernel footprint: what the host reports using, minus what the guests and
# their overheads account for. This is the per-node term the model calls 'vmk'.
VMK_GIB=$(awk "BEGIN{v=($HOST_USED_MIB-$guest_mib_total)/1024; if (v<0) v=0; printf \"%.3f\", v}")

cat <<EOF
{
  "schema": "suse-ai-sizing-tool/measurement/v1",
  "platform": "vsphere",
  "capturedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "anonymized": $([ "$ANON" = "1" ] && echo true || echo false),
  "versions": { "platform": "${VERSION:-unknown}" },
  "nodes": [
    { "name": "node-1", "threads": ${THREADS:-0}, "ramGiB": ${HOST_MEM_GIB:-0}, "role": "worker" }
  ],
  "terms": [
    { "key": "vmk", "modelKey": "vmk", "scope": "per-node", "basis": "physical",
      "ramGiB": $VMK_GIB,
      "detail": "host overallMemoryUsage minus the guests and their overheads: VMkernel, drivers and host daemons" }
  ],
  "vms": [$vm_json
  ],
  "notes": [
    "ESXi has no scheduler-request layer, so every figure here is basis physical.",
    "overheadMiB is runtime.memoryOverhead - the same number VMMEM reports in vmware.log, and the only published route to a per-VM figure.",
    "vSAN, if enabled, is inside the vmk term here. Capture a host with vSAN and one without to separate them.",
    "vCenter is a VM on some cluster, not a host term - size it from the published deployment-size table instead.",
    "One host only. Per-node terms need no more; cluster terms need a second host to separate."
  ]
}
EOF
