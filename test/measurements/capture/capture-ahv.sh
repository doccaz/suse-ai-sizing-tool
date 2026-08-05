#!/usr/bin/env bash
# Capture a calibration point from a Nutanix AHV cluster.
#
#   ./capture-ahv.sh > mycluster.json      (run on a CVM as the nutanix user)
#   ./capture-ahv.sh --names > mylab.json
#
# READ-ONLY: `ncli ... list/info` and `acli ... list/get` only. Nothing is
# created, updated, deleted, powered on or migrated.
#
# NOT YET VERIFIED against a real cluster — written from documented ncli/acli
# output. The field labels these parsers look for are the fragile part; if the
# output format differs, the numbers are still worth sending by hand.
#
# AHV is the platform with no accessible primary source at all: the CVM sizing
# table is behind a Nutanix portal login and there is no free nested install to
# measure (METHODOLOGY § 7a.6a). Every AHV coefficient in the model is an
# Estimate, and it will stay that way until a capture like this one exists.
# This is the highest-value file in the set.
set -euo pipefail

ANON=1
for a in "$@"; do
  case "$a" in
    --names) ANON=0 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

if [ -n "${CAPTURE_FIXTURES:-}" ]; then
  ncli_() { cat "$CAPTURE_FIXTURES/ncli-$1.txt"; }
  acli_() { cat "$CAPTURE_FIXTURES/acli-$1.txt"; }
else
  command -v ncli >/dev/null 2>&1 || { echo "run this on a Nutanix CVM (ncli not found)" >&2; exit 2; }
  ncli_() { case "$1" in cluster) ncli cluster info ;; hosts) ncli host list ;; esac; }
  acli_() { case "$1" in vms) acli vm.list ;; *) acli vm.get "$1" ;; esac; }
fi

# ncli prints "Label : value" with variable padding.
field() { awk -F' *: *' -v k="$1" '$0 ~ k {print $2; exit}'; }

CLUSTER_INFO=$(ncli_ cluster)
HOSTS=$(ncli_ hosts)
VERSION=$(echo "$CLUSTER_INFO" | field 'Cluster Version|AOS Version' | tr -d '\r')
RF=$(echo "$CLUSTER_INFO" | field 'Redundancy Factor' | tr -d '\r')

# Host records are separated by blank lines; pull the three fields the model
# needs from each. "Controller VM memory" is the coefficient that matters —
# the model currently guesses a flat 32 GB for it.
HOST_ROWS=$(echo "$HOSTS" | awk '
  BEGIN { RS = ""; FS = "\n" }
  {
    cores = ""; mem = ""; cvm = ""
    for (i = 1; i <= NF; i++) {
      if ($i ~ /Number of CPU Cores|No of CPU Cores/) { split($i, a, /: */); cores = a[2] }
      if ($i ~ /Memory[^:]*:/ && $i !~ /Controller/)  { split($i, a, /: */); mem = a[2] }
      if ($i ~ /Controller VM Memory|CVM Memory/)     { split($i, a, /: */); cvm = a[2] }
    }
    gsub(/[^0-9.]/, "", cores); gsub(/[^0-9.]/, "", mem); gsub(/[^0-9.]/, "", cvm)
    if (cores != "" && mem != "") print cores "|" mem "|" cvm
  }')

nodes_json=""; terms_cvm=""; i=0; cvm_gib=0
while IFS='|' read -r cores mem cvm; do
  [ -n "${cores:-}" ] || continue
  i=$((i + 1))
  [ -n "$nodes_json" ] && nodes_json="$nodes_json,"
  # ncli reports host memory in GiB or bytes depending on release; normalise on
  # the assumption that anything over a million is bytes.
  memGib=$(awk "BEGIN{m=$mem; if (m > 1000000) m = m/1073741824; printf \"%.3f\", m}")
  nodes_json="$nodes_json
    {\"name\":\"node-$i\",\"threads\":$cores,\"ramGiB\":$memGib,\"role\":\"worker\"}"
  [ -n "${cvm:-}" ] && cvm_gib=$(awk "BEGIN{c=$cvm; if (c > 1000000) c = c/1073741824; printf \"%.3f\", c}")
done <<< "$HOST_ROWS"

[ "$i" -gt 0 ] || { echo "parsed no hosts out of 'ncli host list' — send the raw output instead" >&2; exit 1; }

# VMs: acli vm.list gives "name  uuid"; vm.get gives memory and vCPU.
vm_json=""; j=0
while read -r vname _rest; do
  [ -n "$vname" ] || continue
  case "$vname" in VM*|Name*) continue ;; esac          # header
  g=$(acli_ "$vname" 2>/dev/null) || continue
  mem=$(echo "$g" | awk -F': *' '/memory_mb/ {gsub(/[^0-9]/,"",$2); print $2; exit}')
  vcpu=$(echo "$g" | awk -F': *' '/num_vcpus/ {gsub(/[^0-9]/,"",$2); print $2; exit}')
  [ -n "${mem:-}" ] && [ -n "${vcpu:-}" ] || continue
  j=$((j + 1))
  name="vm-$j"; [ "$ANON" = "0" ] && name="$vname"
  [ -n "$vm_json" ] && vm_json="$vm_json,"
  vm_json="$vm_json
    {\"name\":\"$name\",\"vcpu\":$vcpu,\"reqMemGiB\":$(awk "BEGIN{printf \"%.3f\", $mem/1024}"),\"vfio\":0}"
done <<< "$(acli_ vms)"

cat <<EOF
{
  "schema": "suse-ai-sizing-tool/measurement/v1",
  "platform": "ahv",
  "capturedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "anonymized": $([ "$ANON" = "1" ] && echo true || echo false),
  "versions": { "platform": "${VERSION:-unknown}" },
  "nodes": [$nodes_json
  ],
  "terms": [
    { "key": "cvm", "modelKey": "cvm", "scope": "per-node", "basis": "physical",
      "ramGiB": ${cvm_gib:-0},
      "detail": "Controller VM memory as configured on the host (redundancy factor ${RF:-unknown})" }
  ],
  "vms": [$vm_json
  ],
  "notes": [
    "AHV has no scheduler-request layer, so every figure here is basis physical.",
    "The CVM figure is what makes this capture worth sending: the model guesses a flat 32 GB, and Nutanix sizes it as a base plus per-feature increments that are documented only behind a portal login.",
    "Record which features are enabled - capacity-tier deduplication and RF3 each raise the CVM floor, and the model has toggles for both.",
    "Per-VM overhead is NOT captured: AHV exposes no equivalent of KubeVirt's launcher request or ESXi's memoryOverhead. If you can get one, send it separately.",
    "Prism Central runs outside the cluster it manages - size it from its own VM, not from here."
  ]
}
EOF
