/* Calibration suite: the model must reproduce the measured Harvester footprint.
 *
 * Source: https://gist.github.com/Vicente-Cheng/ae8d5ce743f94c0c9a333574813bc777
 *   Harvester v1.7.1, KubeVirt 1.6.3, CDI 1.62.0, Longhorn v1.10.2.
 *   Nodes: 2 sockets x 24 cores / 48 threads, ~128 GiB RAM.
 *   Add-ons: none (no rancher-monitoring, no rancher-logging).
 *   Standalone cluster — the embedded Rancher is part of the core figures; the
 *   cluster was NOT additionally imported into an external Rancher.
 *   Density VMs: 2 vCPU / 2 GiB, one disk each.
 *
 * Basis: scheduler REQUESTS (what blocks VM placement) plus the kubelet reserve,
 * which comes out of capacity before the scheduler sees it. `kubectl describe
 * node` reports requests against *allocatable*, so the kubelet reserve is NOT
 * part of the measured request figures and is added separately here.
 *
 * This suite is what would have caught the three v2.5.0 errors: the 3x singleton
 * scaling, the 2.5x-low per-VM overhead, and the missing storage-engine memory.
 */
const { computePlatformOverhead, harvesterKubeletCpu } = require('./harness.js');

let fails = 0;
const near = (name, got, want, tolPct, unit = '') => {
  const ok = want === 0 ? got === 0 : Math.abs(got - want) / Math.abs(want) <= tolPct / 100;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${got.toFixed(1)}${unit} vs measured ${want}${unit}` +
              ` (${want === 0 ? '0' : ((got - want) / want * 100).toFixed(1)}%, tol ${tolPct}%)`);
  if (!ok) fails++;
};
const is = (n, c) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) fails++; };

// --- the benchmark's exact configuration -----------------------------------
const HOST_THREADS = 48, HOST_RAM = 128;
const CFG = { addons: { monitoring: false, logging: false, gpuStack: false, rancher: false, lhV2: false } };
const at = (nodes, vms = 0) => computePlatformOverhead('harvester', CFG, {
  nodeCount: nodes, hostThreads: HOST_THREADS, hostRam: HOST_RAM,
  vmCount: vms, vmRam: 2 * vms, vmVcpu: 2 * vms, devices: 0,
  replicas: 3, externalStorage: false,
});
const kubeletOf = (oh, n) => oh.lines.find(l => l.key === 'kubelet').cpu * n;
const totalCpu = (oh, n) => oh.uniformCpu * n + oh.lumpCpu;
const totalRam = (oh, n) => oh.uniformRam * n + oh.lumpRam;
const requestCpu = (oh, n) => totalCpu(oh, n) - kubeletOf(oh, n);

console.log('--- Phase 1 idle: scheduler requests ---');
// Single-node: "cpu 8488m (18%)", "memory 5745 Mi (4%)"
near('1-node CPU requests', requestCpu(at(1), 1) * 1000, 8488, 1, 'm');
near('1-node memory requests', totalRam(at(1), 1) * 1024, 5745, 1, ' MiB');
// 3-node: 5745 + 3767 + 3075 = 12587 Mi
near('3-node memory requests', totalRam(at(3), 3) * 1024, 12587, 1, ' MiB');

console.log('\n--- The structural finding: singletons do not replicate ---');
const r = totalRam(at(3), 3) / totalRam(at(1), 1);
near('3-node : 1-node memory ratio', r, 12587 / 5745, 2);
is('ratio is NOT the 3.00x of the v2.5.0 model', Math.abs(r - 3) > 0.5);
// Guard the exact bug this suite exists for: the cluster lump must be flat.
const lumps = [1, 3, 5, 7].map(n => at(n).clusterRam);
is(`cluster RAM is flat across 1/3/5/7 nodes (${lumps[0].toFixed(3)} GiB)`,
   lumps.every(x => Math.abs(x - lumps[0]) < 1e-9));
const lumpsCpu = [1, 3, 5, 7].map(n => at(n).clusterCpu);
is('cluster CPU is flat across 1/3/5/7 nodes', lumpsCpu.every(x => Math.abs(x - lumpsCpu[0]) < 1e-9));

console.log('\n--- No singleton double-count ---');
/* The measured 2870m (8488 − Longhorn) is `Pc + Sc`, not `Pc`. Charging it per
   node AND as a cluster lump would double-count Sc — the same error class as the
   min(3,N) bug. At N=1 the terms must sum to exactly the measured total. */
const oh1 = at(1);
const alloc = HOST_THREADS - harvesterKubeletCpu(HOST_THREADS);
const longhorn = 0.12 * alloc;
near('Longhorn 12% is of ALLOCATABLE, not capacity',
     oh1.lines.find(l => l.key === 'lhim').cpu * 1000, longhorn * 1000, 0.01, 'm');
const perNodeNoLh = oh1.uniformCpu - longhorn - harvesterKubeletCpu(HOST_THREADS);
near('per-node CPU Pc (singleton excluded)', perNodeNoLh * 1000, 1879, 2, 'm');
near('cluster CPU Sc', oh1.clusterCpu * 1000, 991, 2, 'm');
near('Pc + Sc reproduces the single-node remainder', (perNodeNoLh + oh1.clusterCpu) * 1000, 2870, 1, 'm');
// The memory decomposition, which fits the measured node skew exactly.
near('per-node memory P', oh1.uniformRam * 1024, 3421, 1, ' MiB');
near('cluster memory S', oh1.clusterRam * 1024, 2324, 1, ' MiB');
is('P + S = the single-node measurement',
   Math.abs((oh1.uniformRam + oh1.clusterRam) * 1024 - 5745) < 10);
// At 3 nodes, S must appear once: 3P + S, never 3P + 3S.
near('3 nodes = 3P + S (not 3P + 3S)', totalRam(at(3), 3) * 1024,
     3 * 3421 + 2324, 1, ' MiB');

console.log('\n--- Per-VM overhead: KubeVirt formula vs the measurement ---');
/* This is the strongest evidence in the model: a formula taken from vendor
   source code, and an independent measurement of a running cluster, agreeing
   without either being fitted to the other.

     kubevirt/kubevirt template.go:115-119
       fixed = 25 monitor + 100 launcher + 25 virtlogd + 40 virtqemud + 30 qemu
     renderresources.go GetMemoryOverhead()
       + guest RAM / 512   + 8 MiB/vCPU   + 8 MiB IOThread   + 32 MiB graphics
     harvester settings_helper.go
       x AdditionalGuestMemoryOverheadRatio, default 1.5                        */
{
  const kvBase = (220 + 8 + 32) + 8 * 2 + (2 * 1024) / 512;   // 2 vCPU / 2 GiB
  near('  KubeVirt base overhead, from source', kvBase, 280, 0.01, ' MiB');
  near('  x Harvester ratio 1.5', kvBase * 1.5, 420, 0.01, ' MiB');
  // The model must reproduce that, and it must land on the measurement.
  near('model per-VM overhead (2 vCPU / 2 GiB)', at(3, 1).perVmRam * 1024, kvBase * 1.5, 0.01, ' MiB');
  near('  vs measured 421 MiB (independent evidence)', at(3, 1).perVmRam * 1024, 421, 1, ' MiB');
}
// Total request for the benchmark's guest: 2048 guest + overhead = ~2469 Mi.
near('total per-VM request matches the benchmark', 2048 + at(3, 1).perVmRam * 1024, 2469, 1, ' MiB');
// 205m/VM measured; 2000m/16 = 125m is the guest at Harvester's 1600% ratio.
near('per-VM launcher CPU beyond vCPU/overcommit',
     at(3, 1).lines.find(l => l.key === 'perVm').cpu * 1000, 80, 2, 'm');
is('per-VM overhead is not the v2.5.0 166 MiB', at(3, 1).perVmRam * 1024 > 300);
// Each source-derived component must be individually reachable, not just the sum.
{
  const per = (vcpu, gib, ratio) => computePlatformOverhead('harvester',
    { ...CFG, overrides: ratio ? { 'perVm.overheadRatio': ratio } : {} },
    { nodeCount: 3, hostThreads: HOST_THREADS, hostRam: HOST_RAM,
      vmCount: 1, vmRam: gib, vmVcpu: vcpu, devices: 0, replicas: 3, externalStorage: false })
    .perVmRam * 1024;
  near('  each extra vCPU adds 8 MiB x ratio', per(3, 2) - per(2, 2), 8 * 1.5, 0.01, ' MiB');
  near('  page tables are guest RAM / 512', per(2, 4) - per(2, 2), (2 * 1024 / 512) * 1.5, 0.01, ' MiB');
  near('  ratio 1 gives the raw KubeVirt figure', per(2, 2, 1), 280, 0.01, ' MiB');
}
// It must scale linearly with VM count.
is('per-VM scales linearly', Math.abs(at(3, 100).perVmRam - 100 * at(3, 1).perVmRam) < 1e-6);

console.log('\n--- Storage-engine memory (physical, not a request) ---');
// Read the line itself: physLumpRam also carries the cluster-service RSS.
const diskLine = (oh) => oh.lines.find(l => l.key === 'perVmDisk');
// 60273 Mi across 148 VMs x 3 replicas = 135.8 MiB per replica.
near('Longhorn replica engines at 148 VMs', diskLine(at(3, 148)).ram * 1024, 60273, 1, ' MiB');
is('it does NOT inflate schedulable-capacity totals',
   diskLine(at(3, 148)).basis === 'physical' &&
   Math.abs(totalRam(at(3, 148), 3) - totalRam(at(3, 1), 3) - 147 * at(3, 1).perVmRam) < 1e-6);
is('it is charged per replica', Math.abs(
   diskLine(computePlatformOverhead('harvester', CFG, { nodeCount: 3, hostThreads: 48, hostRam: 128,
     vmCount: 10, vmRam: 20, vmVcpu: 20, devices: 0, replicas: 2, externalStorage: false })).ram
   - 136 * 2 * 10 / 1024) < 1e-6);
is('external / LVM-backed storage pays nothing', !diskLine(computePlatformOverhead('harvester', CFG, {
   nodeCount: 3, hostThreads: 48, hostRam: 128, vmCount: 148, vmRam: 296, vmVcpu: 296,
   devices: 0, replicas: 3, externalStorage: true })));

console.log('\n--- The physical rule must not fire on the benchmark itself ---');
/* 3-node, 148 VMs => ~49 VMs/node on 128 GiB hosts. The gist reports ~49%
   physical RAM consumed. A rule that fired here would be crying wolf on the very
   data that calibrated it. */
const ohD = at(3, 148);
const vmsPerNode = 148 / 3;
const physPerNode = ohD.physPerNodeRam + ohD.physLumpRam / 3 + vmsPerNode * ohD.physPerVmRamMiB / 1024;
console.log(`  physical per node: ${physPerNode.toFixed(1)} GiB of ${HOST_RAM} = ${(100 * physPerNode / HOST_RAM).toFixed(0)}%`);
near('physical consumption at max density', 100 * physPerNode / HOST_RAM, 49, 15, '%');
is('the rule PASSES (does not fire)', physPerNode <= HOST_RAM);
is('per-VM physical (683 MiB RSS) is not used as a request',
   ohD.physPerVmRamMiB === 683 && at(3, 1).perVmRam * 1024 < 500);

console.log('\n--- The vendor anchor survives recalibration ---');
near('16-core kubelet reserve is still exactly 1020m', harvesterKubeletCpu(16) * 1000, 1020, 0.01, 'm');

console.log('\n--- Provenance ---');
const tiers = at(3, 10).lines.map(l => l.tier);
is('the measured tier is in use', tiers.includes('measured'));
is('every line still carries a source', at(3, 10).lines.every(l => l.src && l.src.length > 10));
is('measured lines cite the benchmark',
   at(3, 10).lines.filter(l => l.tier === 'measured').every(l => /gist\.github\.com/.test(l.src)));
is('add-on coefficients stay Estimate (the benchmark ran without them)',
   computePlatformOverhead('harvester', { addons: { monitoring: true } }, {
     nodeCount: 3, hostThreads: 48, hostRam: 128, vmCount: 0, vmRam: 0, vmVcpu: 0, devices: 0 })
     .lines.filter(l => /addon\.monitoring/.test(l.key)).every(l => l.tier === 'estimate'));

/* ===================================================================
   Second, independent calibration point: a live Harvester v1.8.1 lab
   (2 compute + 1 witness, heterogeneous). Read-only measurements.
   The first benchmark was v1.7.1 on 3 identical nodes, so this checks a
   different version, a different topology and different host sizes.
   =================================================================== */
console.log('\n=== Live lab: Harvester v1.8.1 (independent of the v1.7.1 benchmark) ===');
{
  const lab = require('./measurements/lab-harvester-v1.8.1.json');

  console.log('\n--- Term A: kubelet reserve, against real kubelet config ---');
  for (const n of lab.nodes) {
    const total = harvesterKubeletCpu(n.threads) * 1000;
    near(`  ${n.name} (${n.threads} thr) system-reserved`, total * 2 / 5, n.systemReservedCpuMilli, 0.01, 'm');
    near(`  ${n.name} (${n.threads} thr) kube-reserved`,   total * 3 / 5, n.kubeReservedCpuMilli, 0.01, 'm');
    near(`  ${n.name} allocatable = capacity - reserve`,
         n.capacityCpuMilli - total, n.allocatableCpuMilli, 0.01, 'm');
  }
  is('the +400m tier applies (maxPods is 200 on every node)',
     lab.nodes.every(n => n.allocatablePods === 200));

  console.log('\n--- No kubelet MEMORY reservation (the model assumes none) ---');
  is('capacity memory == allocatable memory on every node',
     lab.nodes.every(n => n.capacityMemKi === n.allocatableMemKi));

  console.log('\n--- Longhorn: 12% of ALLOCATABLE, and CPU-only ---');
  for (const n of lab.nodes.filter(n => n.longhornCpuRequestThreads > 0)) {
    near(`  ${n.name} instance-manager CPU request`,
         0.12 * (n.allocatableCpuMilli / 1000), n.longhornCpuRequestThreads, 0.1, ' thr');
  }
  is('12% of allocatable, not of capacity', lab.nodes.every(n =>
     n.longhornCpuRequestThreads === 0 ||
     Math.abs(n.longhornCpuRequestThreads - 0.12 * n.capacityCpuMilli / 1000) > 0.05));

  console.log('\n--- Settings the model hard-codes ---');
  is('overhead ratio default is 1.5',
     lab.settings['additional-guest-memory-overhead-ratio'].default === '1.5');
  is('guaranteed-instance-manager-cpu is 12% for both data engines',
     lab.settings['guaranteed-instance-manager-cpu'].value.v1 === '12' &&
     lab.settings['guaranteed-instance-manager-cpu'].value.v2 === '12');
  is('storage reserved percentage is 0', lab.settings['storage-reserved-percentage-for-default-disk'].value === 0);

  console.log('\n--- Term C: per-VM overhead vs 10 real virt-launcher pods ---');
  let worst = 0;
  for (const v of lab.vms) {
    const oh = computePlatformOverhead('harvester', {}, {
      nodeCount: 2, hostThreads: 24, hostRam: 92, hostStorage: 2000,
      vmCount: 1, vmRam: v.reqMemGiB, vmRamRequested: v.reqMemGiB, vmVcpu: v.vcpu,
      devices: v.vfio, gpuVms: v.vfio, replicas: 3, externalStorage: false });
    const model = oh.perVmRam * 1024;
    worst = Math.max(worst, Math.abs(model - v.overheadMiB) / v.overheadMiB * 100);
    near(`  ${v.name} (${v.vcpu} vCPU, ${v.reqMemGiB.toFixed(1)} GiB${v.vfio ? ', VFIO' : ''})`,
         model, v.overheadMiB, 0.5, ' MiB');
  }
  is(`worst per-VM error across 10 live VMs is under 0.1% (${worst.toFixed(4)}%)`, worst < 0.1);

  console.log('\n--- VFIO is charged per VM, not per device ---');
  {
    const gpu = lab.vms.find(v => v.vfio);
    const base = computePlatformOverhead('harvester', {}, {
      nodeCount: 2, hostThreads: 24, hostRam: 92, hostStorage: 2000, vmCount: 1,
      vmRam: gpu.reqMemGiB, vmRamRequested: gpu.reqMemGiB, vmVcpu: gpu.vcpu,
      devices: 0, gpuVms: 0, replicas: 3, externalStorage: false }).perVmRam * 1024;
    near('  one VFIO VM adds exactly 1 GiB x the 1.5 ratio', gpu.overheadMiB - base, 1536, 0.01, ' MiB');
    // The live VM had TWO host devices and still paid only 1 GiB.
    const two = computePlatformOverhead('harvester', {}, {
      nodeCount: 2, hostThreads: 24, hostRam: 92, hostStorage: 2000, vmCount: 1,
      vmRam: gpu.reqMemGiB, vmRamRequested: gpu.reqMemGiB, vmVcpu: gpu.vcpu,
      devices: 2, gpuVms: 1, replicas: 3, externalStorage: false }).perVmRam * 1024;
    near('  a 2-device VM still pays only 1 GiB (matches the live measurement)',
         two, gpu.overheadMiB, 0.01, ' MiB');
  }

  console.log('\n--- Page tables follow the memory REQUEST, not the guest size ---');
  {
    const mk = (req) => computePlatformOverhead('harvester', {}, {
      nodeCount: 2, hostThreads: 24, hostRam: 92, hostStorage: 2000, vmCount: 1,
      vmRam: 32, vmRamRequested: req, vmVcpu: 8, devices: 0, gpuVms: 0,
      replicas: 3, externalStorage: false }).perVmRam * 1024;
    // 32 GiB guest at 150% overcommit requests 21.33 GiB; that is what the live
    // rancher-host VMs show, and their overhead is 550 MiB not 570 MiB.
    near('  32 GiB guest at 150% overcommit matches the live 550 MiB',
         mk(21.33300781), 550, 0.5, ' MiB');
    is('  using the guest size instead would overstate it', mk(32) > 550);
  }
}

console.log(`\n${fails === 0 ? 'BENCHMARK CALIBRATION PASSED' : fails + ' CHECK(S) FAILED'}`);
process.exit(fails === 0 ? 0 : 1);
