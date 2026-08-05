# Cluster measurements

Only **Harvester** is calibrated against real clusters. Every other platform's
coefficients come from vendor documentation and shipped manifests — and for
vSphere and AHV, the vendor no longer publishes the numbers at all (METHODOLOGY
§ 7a.6a). Measurement is not the expensive option for those platforms any more;
it is the only one.

These scripts let anyone with access to a cluster produce a calibration point
without knowing anything about the model.

```
capture/capture-kubevirt.sh     Harvester, OpenShift Virtualization   (kubectl / oc)
capture/capture-vsphere.sh      ESXi host                             (esxcli / vim-cmd)
capture/capture-proxmox.sh      Proxmox VE node                       (pvesh / ps)
capture/capture-ahv.sh          Nutanix CVM                           (ncli / acli)
```

Each writes one JSON file to stdout. Send it back, or run it through the
validator yourself:

```bash
./capture/capture-kubevirt.sh > mycluster.json
node validate.js mycluster.json
```

`validate.js` checks the file against the schema and then prints the model's
prediction beside every measured figure, with the error. That is the whole
point: a capture is not data collection, it is a check on the coefficients.

## They are read-only, and the tests enforce it

Every script uses `get`/`list`/`show` verbs only. Nothing is created, patched,
deleted or powered on. `test/capture.js` greps the scripts for mutating verbs
and fails the suite if one appears, so "read-only" is a property of the repo
rather than a promise in a comment. Read the script before running it against
production anyway — that is the correct habit and they are short.

## Names are stripped by default

The scripts run on customer clusters. By default every node, VM, cluster and
namespace name is replaced with `node-1`, `vm-3`, `ns-2`; nothing else is
collected — no IPs, no labels, no annotations, no serial numbers. Pass
`--names` if you are capturing your own lab and want them kept for your own
reference.

## The schema

One shape for every platform. Version it if you change it.

```jsonc
{
  "schema": "suse-ai-sizing-tool/measurement/v1",
  "platform": "harvester",          // matches a HYPERVISORS key
  "capturedAt": "2026-08-05T10:00:00Z",
  "anonymized": true,
  "versions": { "platform": "v1.8.1", "kubernetes": "v1.35.6+rke2r1" },

  "nodes": [
    { "name": "node-1", "threads": 24, "ramGiB": 91.9, "storageTiB": 2.0, "role": "worker" }
  ],

  // Every measured figure carries the BASIS it was measured on, because that
  // is what decides whether it is comparable to a given model term:
  //   reserve  — withheld from capacity before the scheduler (kubelet)
  //   request  — a scheduler request; blocks VM placement
  //   physical — actually-consumed memory; never blocks placement
  // Platforms without a scheduler (ESXi, AHV, KVM) emit "physical" only.
  "terms": [
    { "key": "kubelet", "modelKey": "kubelet",
      "scope": "per-node", "basis": "reserve", "node": "node-1",
      "cpuThreads": 1.06, "ramGiB": 0 },
    { "key": "longhorn-system", "modelKey": "lhim",
      "scope": "per-node", "basis": "request", "node": "node-1",
      "cpuThreads": 2.753, "ramGiB": 0 },
    { "key": "all-cluster-workloads", "scope": "cluster", "basis": "request",
      "complete": true, "cpuThreads": 3.875, "ramGiB": 7.135 }
  ],

  // Which add-ons the cluster actually runs. Without this the validator scores
  // against the model's defaults — the v1.8.1 lab ran no monitoring, so
  // comparing it to a model with Prometheus on charges it 1.05 threads that
  // were never installed.
  "addons": { "monitoring": false, "logging": false },

  "vms": [
    { "name": "vm-1", "vcpu": 8, "reqMemGiB": 8, "vfio": 0, "overheadMiB": 510 }
  ],

  "notes": ["free text — anything the numbers do not say"]
}
```

`scope` is `per-node` (measured on one node, charged on every node) or
`cluster` (exists once no matter how many nodes). On Kubernetes the scripts
decide this by **workload kind** — `DaemonSet` is per-node, `Deployment` and
`StatefulSet` are cluster-wide — which is how the Harvester v1.8.1 lab was
decomposed (§ 7a.10). It measures the split rather than inferring it.

Two optional fields decide how a term is scored, and getting them wrong is the
one way a capture can mislead:

| Field | Effect |
|---|---|
| `modelKey` | Names the model line this term corresponds to (`kubelet`, `lhim`, `vmk`, `cvm`, `addon.zfsArc`, …). The validator then compares **that line only** — precise, and safe on a partial capture. |
| `complete` | Asserts "this is *everything* in this scope". Only then will the validator compare scope **totals**. |

Without either, a scope is reported as partial and left unscored — deliberately.
Summing two of six per-node terms and comparing against the model's six reads as
"the model is 66% high" when it means "the capture measured a third of it". A
delta that looks authoritative and is wrong is worse than no delta.

**Partial captures are fine and useful.** Nothing is mandatory except `schema`,
`platform` and `nodes`. The validator compares what is present and reports the
rest as not captured — a file with nothing but ten VMs still validates the
per-VM term, which is the one that needs it most on vSphere.

## Existing files

| File | What it is |
|---|---|
| `lab-harvester-v1.8.1.json` | The original v1.8.1 lab capture, in its **pre-schema shape**. Left exactly as it is because `benchmark.js` reads it directly and it is the only calibration guard the model has. |
| `example-harvester-v1.8.1.json` | The same lab, expressed in the schema above. Used by `validate.js`'s self-test, and the worked example to copy. |

## What happens to a capture

Send the JSON. The coefficients that move are the ones where the measurement
disagrees with the model by more than the tier of the coefficient justifies — a
`verified` line traced to a manifest should not move because one cluster
disagrees (find out why first), whereas an `estimate` line should move readily.
See METHODOLOGY § 7a.9 for how the Harvester numbers were derived from exactly
this kind of file.

Captures are not imported by the tool itself: there is no "load a measurement"
path in `index.html`, and coefficients are updated by hand after someone has
looked at the delta. Every coefficient is editable in the UI, so a user who
just wants their own numbers can type them in without any of this.
