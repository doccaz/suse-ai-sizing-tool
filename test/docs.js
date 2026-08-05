/* Docs/code consistency: a coefficient in code with no documented source is a
   bug, and so is a doc claim that no longer matches the code. */
const fs = require('fs');
const { HYPERVISORS } = require('./harness.js');
const METH = fs.readFileSync(require('path').join(__dirname, '..', 'METHODOLOGY.md'), 'utf8');

let fails = 0;
const is = (n, c) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) fails++; };

console.log('--- Every coefficient in code carries a source and a tier ---');
const tierOk = (t) => ['verified', 'measured', 'estimate'].includes(t);
for (const [k, P] of Object.entries(HYPERVISORS)) {
  if (k === 'none') continue;
  const items = [...(P.perNode || []), ...(P.infraNode || []), ...(P.cluster || []),
                 ...Object.values(P.addons || {})];
  for (const i of items) is(`${k}.${i.key || i.label}: src+tier`, !!i.src && tierOk(i.tier));
  if (P.perVm)     is(`${k}.perVm: src+tier`,     !!P.perVm.src && tierOk(P.perVm.tier));
  if (P.perVmDiskPhysical) is(`${k}.perVmDiskPhysical: src+tier`,
      !!P.perVmDiskPhysical.src && tierOk(P.perVmDiskPhysical.tier));
  if (P.perDevice) is(`${k}.perDevice: src+tier`, !!P.perDevice.src && tierOk(P.perDevice.tier));
  is(`${k}.storage: src+tier`, !!P.storageSrc && tierOk(P.storageTier));
  is(`${k}: has a label and a note`, !!P.label && !!P.note);
}

console.log('\n--- METHODOLOGY.md documents the section and its key claims ---');
const has = (s) => METH.includes(s);
/* Markdown hard-wraps prose, so a phrase that spans a line break will not match
   a literal includes(). Compare against a whitespace-collapsed copy for any
   assertion on a sentence rather than a token. */
const METH_FLAT = METH.replace(/\s+/g, ' ');
const hasFlat = (s) => METH_FLAT.includes(s.replace(/\s+/g, ' '));
is('§ 7a section exists', has('## 7a. Hypervisor platform overhead'));
is('provenance tiers are defined', has('**Verified**') && has('**Estimate**'));
is('the 1020m worked example is documented', has('1020 m') || has('1020m'));
is('the derivation is shown', has('calculateCPUReservedInMilliCPU'));
is('the no-kubelet-memory caveat is stated',
   has('no kubelet memory reservation') || has('configures **no kubelet memory reservation**'));
is('the 1600%/150% limits are explicitly NOT applied',
   has('platform limits, not sizing recommendations') || has('**platform limits, not sizing recommendations**'));
is('the 12% Longhorn figure is documented', has('12% of node allocatable CPU'));
is('allocatable-not-capacity is documented', has('12% of **allocatable**'));
is('the 12% is traced to Harvester source', has('defaultGuaranteedInstanceManagerCPU = 12'));
is('the 0% storage default is documented', has('defaultStorageReservedPercentageForDefaultDisk = 0'));
is('the worked 3n/50 vs 5n/100 table is present', has('3 nodes / 50 VMs') && has('5 nodes / 100 VMs'));
is('the singleton finding is documented', has('2.19') && has('do *not* multiply by node count'));
is('the request basis is stated', has('scheduler requests, plus the kubelet reserve') ||
   has('**Overhead is expressed as scheduler requests'));
is('the three currencies are distinguished',
   has('Scheduler requests') && has('Pod usage') && has('Host consumption'));
is('the derivation section exists', has('### 7a.9 Calibration against a measured cluster'));
is('the two-point fit is shown', has('S + 3P = 12587'));
is('the exact-fit check is shown', has('3421 Mi = P'));
is('the CPU cross-check table is present', has('2812 m = `Pc + Sc`'));
is('the no-double-count warning is present', has('would double-count'));
is('the storage-engine term is documented', has('136 MiB per replica'));
is('the benchmark caveats are stated',
   has('One benchmark, one hardware configuration') && has('probably not homogeneous'));
is('the Measured tier is defined', has('| **Measured** |'));
is('add-ons are documented as measured on the lab, not the benchmark',
   hasFlat('benchmark ran with neither monitoring nor logging installed') &&
   hasFlat('measured on the live v1.8.1 cluster'));
is('the two Ranchers are disambiguated', has('Do not confuse the two Ranchers'));
is('model completeness is documented', has('### 7a.1b Model completeness'));
is('the KubeVirt formula is documented from source',
   hasFlat('25 MiB virt-launcher-monitor') && hasFlat('100 MiB virt-launcher') &&
   hasFlat('25 MiB virtlogd') && hasFlat('40 MiB virtqemud') && hasFlat('30 MiB qemu'));
is('the fixed total is stated', hasFlat('= 220 MiB'));
is('the page-table term is documented', hasFlat('memory REQUEST / 512'));
is('the page-table basis is explained',
   hasFlat('Page tables follow') && hasFlat('not the guest') && hasFlat('requests.memory'));
is('VFIO is documented as per-VM, not per-device',
   hasFlat('+1 GiB per passthrough *VM*') && hasFlat('a boolean'));
is('the live-lab validation is documented',
   hasFlat('### 7a.10 Validation against a live cluster'));
is('  the three-node kubelet verification is recorded',
   hasFlat('424m / 636m') && hasFlat('440m / 660m') && hasFlat('384m / 576m'));
is('  the 10-VM per-VM verification is recorded', hasFlat('10 live virt-launcher pods'));
is('  the two corrections it produced are recorded',
   hasFlat('VFIO was charged per device; it is per VM') &&
   hasFlat('Page tables were computed on the guest size; they use the memory request'));
is('the overhead ratio and its default are documented',
   hasFlat('AdditionalGuestMemoryOverheadRatioDefault = "1.5"') && hasFlat('valid range 1.0–10.0'));
is('the Harvester-vs-OpenShift ratio difference is explained',
   hasFlat('configuration choice, not an architectural difference'));
is("Red Hat's older published form is marked superseded",
   hasFlat('This supersedes Red Hat') && hasFlat('146 MiB is an older snapshot'));
is('the source/measurement cross-check is shown',
   hasFlat('x 1.5 = 420 MiB') && hasFlat('agreeing to **0.25%**'));
is('the residual is acknowledged rather than glossed',
   hasFlat('Neither is exact'));
is('the unmodelled KubeVirt terms are listed',
   hasFlat('+128 MiB') && hasFlat('+53 MiB') && hasFlat('+256 MiB'));
is('the version the constants were verified against is stated',
   hasFlat('verified identical in v1.6.3'));
is('the Modelled tier is defined and explained',
   hasFlat('**Modelled** means every significant category is represented'));
is('the residual differences are explained as architectural, not artifacts',
   hasFlat('architectural rather than artifacts'));
is('the Longhorn reservation-vs-consumption point is made',
   has('Same physical cost, different accounting'));
is('cross-platform comparison is still qualified',
   hasFlat('indicative of *shape*, not as a benchmark'));
is('the per-platform tables exist', has('### 7a.6a The other platforms in full'));
is('vCenter step table is documented', has('Tiny 2 vCPU/14 GB'));
is('vSAN derivation is documented', has('7 MB per GB of cache tier'));
is('Ceph per-OSD figure is documented', has('4 GiB per OSD'));
is('ODF per-device figure is documented', has('2 CPU and 5 GiB per storage device'));
is('OpenShift control-plane minimum is documented', has('4 vCPU / 16 GB per master'));
is('per-VM CPU applicability is explained',
   hasFlat('Per-VM CPU: applicable only to the KubeVirt platforms') && hasFlat('would double-count'));
is('storage terms are documented as dropping out on external storage',
   hasFlat('drops to zero when external storage is selected'));
is('limitations repeat the cross-platform caveat',
   hasFlat('Only the Harvester model is calibrated'));
// Every platform with declared gaps must have them documented too.
{
  const { HYPERVISORS: H } = require('./harness.js');
  for (const [k, P] of Object.entries(H)) {
    if (!P.depthGaps || !P.depthGaps.length) continue;
    is(`${k}: model depth appears in METHODOLOGY.md`,
       METH.includes(P.depth === 'partial' ? 'Partial' : 'Indicative'));
  }
}

/* The worked example is the first thing a reader checks, so verify the DOCUMENTED
   numbers against a live computation on the DOCUMENTED fixture — not just that
   the strings exist. A table whose rows do not add up is worse than no table. */
{
  const { computePlatformOverhead } = require('./harness.js');
  const run = (nodes, vms) => computePlatformOverhead('harvester', {}, {
    nodeCount: nodes, hostThreads: 96, hostRam: 512,
    vmCount: vms, vmRam: 16 * vms, vmVcpu: 4 * vms, devices: 0,
    replicas: 3, externalStorage: false });
  for (const [nodes, vms] of [[3, 50], [5, 100]]) {
    const oh = run(nodes, vms);
    const cpu = (oh.uniformCpu * nodes + oh.lumpCpu).toFixed(2);
    const ram = (oh.uniformRam * nodes + oh.lumpRam).toFixed(1);
    is(`documented total for ${nodes}n/${vms}vm (${cpu} thr / ${ram} GB) matches computation`,
       has(`**${cpu} thr / ${ram} GB**`));
    // Physical lines are a separate currency and are not in the request totals.
    const sc = (sco, k) => oh.lines
      .filter(l => l.scope === sco && l.basis !== 'physical')
      .reduce((t, l) => t + (l[k] || 0), 0);
    const kube = oh.lines.find(l => l.key === 'kubelet').cpu;
    is(`  row A for ${nodes}n documented`, has((kube * nodes).toFixed(2) + ' thr'));
    is(`  row B' (cluster, counted once) for ${nodes}n documented`,
       has(`${sc('cluster', 'cpu').toFixed(2)} thr / ${sc('cluster', 'ram').toFixed(1)} GB`));
    is(`  row C (per-VM) for ${nodes}n documented`,
       has(`${sc('per-vm', 'cpu').toFixed(2)} thr / ${sc('per-vm', 'ram').toFixed(1)} GB`));
    const disk = oh.lines.find(l => l.key === 'perVmDisk');
    is(`  row C' (storage engines, physical) for ${nodes}n documented`,
       has(`*${disk.ram.toFixed(1)} GB*`));
  }
  // The cluster term must be identical in both columns — that is the finding.
  is('the cluster row is the same in both columns',
     (() => { const a = run(3, 50), b = run(5, 100);
       return Math.abs(a.clusterRam - b.clusterRam) < 1e-9 &&
              Math.abs(a.clusterCpu - b.clusterCpu) < 1e-9; })());
  const rr = (f) => (f(run(5, 100), 5) / f(run(3, 50), 3));
  const cpuR = rr((o, n) => o.uniformCpu * n + o.lumpCpu).toFixed(2);
  const ramR = rr((o, n) => o.uniformRam * n + o.lumpRam).toFixed(2);
  is(`documented column ratios (${cpuR}x CPU, ${ramR}x RAM) match computation`,
     has(`${cpuR}\u00d7 CPU, ${ramR}\u00d7 RAM`));
  // Node-only scaling at fixed VM count — the actual singleton effect.
  const nodeOnly = (n) => { const o = run(n, 50); return o.uniformRam * n + o.lumpRam; };
  const nr = (nodeOnly(5) / nodeOnly(3)).toFixed(2);
  is(`documented node-scaling ratio (${nr}x) match`, has(`**${nr}\u00d7 RAM**`));
  is('the cluster-term recalibration is documented',
     hasFlat('3.875 thr / 7.135 GB, counted once') && hasFlat('2 replicas'));
  is('the single-node divergence is explained',
     hasFlat('no longer reproduces the single-node benchmark, by design') || hasFlat('longer reproduces the single-node benchmark, by design'));
  is('the direct decomposition is documented',
     hasFlat('by observation') && hasFlat('a DaemonSet is per-node'));
  is('the CNI caveat is documented',
     hasFlat('CNI and version affect these figures') && hasFlat('kube-ovn'));
  is('the residual and its cause are stated',
     hasFlat('+5% on CPU and +12% on RAM') && hasFlat('it is tainted, so most DaemonSets skip it'));
  is('add-on calibration is documented as measured from the lab',
     hasFlat('20-50x too high') || hasFlat('20–50× too high'));
  is('the fixture is stated (no GPUs)', has('**no GPUs**'));
}
is('Rule 5 no longer says reserves default to 0 as the only lever',
   !has('They default to **0** to match the reference baseline;'));
is('Rule 5 points at the new section', has('§ 7a Hypervisor platform overhead'));
is('the manual reserve is described as additional, not duplicate',
   has('*additional* manual reserve layered **on\n   top of**') || has('additional* manual reserve'));
is('host-count formulas mention platform overhead', has('platform_overhead_cpu'));
is('demand formulas mention the lump', has('platform_lump_cpu') && has('platform_lump_ram'));
is('references section has the source-code citations',
   has('pkg/installer/config/cos.go:35-49') && has('upgrade_node.sh:446'));
is('limitations record that RAM coefficients are measured, not specified',
   has('**measured, not specified**'));
is('AHV overcommit constraint is documented', has('cannot\n   overcommit memory') || has('cannot overcommit memory'));

console.log('\n--- README claims match reality ---');
{
  const R = fs.readFileSync(require('path').join(__dirname, '..', 'README.md'), 'utf8');
  const H = fs.readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
  const ver = (H.match(/const APP_VERSION = "([^"]+)"/) || [])[1];
  is(`README changelog covers APP_VERSION ${ver}`, R.includes(`**v${ver}**`));
  is('README documents the platform-overhead feature', /Hypervisor platform overhead/.test(R));
  is('README states old configs are unaffected',
     /numbers are unchanged until you opt in|no platform selected/i.test(R));
  is('README documents the test suite', R.includes('./test/run.sh'));
  is('README does not still claim Harvester-only virtualization sizing',
     !/plan the SUSE Virtualization \(Harvester\) hosts that run SUSE AI\.\s*$/m.test(R));
}

console.log('\n--- Every platform in code is mentioned in the docs ---');
for (const k of Object.keys(HYPERVISORS)) {
  if (k === 'none') continue;
  const names = { harvester: 'Harvester', ocpvirt: 'OpenShift Virtualization',
                  vsphere: 'vSphere', ahv: 'Nutanix AHV', proxmox: 'Proxmox' };
  is(`${k} appears in METHODOLOGY.md`, METH.includes(names[k]));
}

console.log(`\n${fails === 0 ? 'DOCS CONSISTENT' : fails + ' DOC CHECK(S) FAILED'}`);
process.exit(fails === 0 ? 0 : 1);
