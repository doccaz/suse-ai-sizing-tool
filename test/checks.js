const { gkeReservedCpu, harvesterKubeletCpu, computePlatformOverhead, HYPERVISORS } =
  require('./harness.js');

let fails = 0;
const eq = (name, got, want, tol = 1e-9) => {
  const ok = Math.abs(got - want) <= tol;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: got ${got}, want ${want}`);
  if (!ok) fails++;
};
const is = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) fails++; };

console.log('--- Term A: Harvester kubelet reserve ---');
// The published Harvester worked example: a 16-core node reserves
// systemReserved 408m + kubeReserved 612m = 1020m.
const r16 = harvesterKubeletCpu(16);
eq('16-core node total reserve (mCPU)', Math.round(r16 * 1000), 1020);
eq('  -> systemReserved 2/5 (mCPU)', Math.round(r16 * 1000 * 2 / 5), 408);
eq('  -> kubeReserved  3/5 (mCPU)', Math.round(r16 * 1000 * 3 / 5), 612);
eq('GKE base for 16 cores, maxPods<=110 (mCPU)', Math.round(gkeReservedCpu(16, 110) * 1000), 110);
eq('96-thread host reserve (mCPU)', Math.round(harvesterKubeletCpu(96) * 1000), 1420);
eq('0 threads is safe', harvesterKubeletCpu(0), 0);

console.log('\n--- Term B/E: Harvester per-node, 96-thread / 512 GB host ---');
const ctx = { nodeCount: 5, hostThreads: 96, hostRam: 512, vmCount: 100, vmRam: 1600, vmVcpu: 400, devices: 0 };
const oh = computePlatformOverhead('harvester', { auto: true, addons: {}, overrides: {} }, ctx);
const lh = oh.lines.find(l => l.key === 'lhim');
// 12% of ALLOCATABLE (capacity minus the kubelet reserve), not of capacity —
// Longhorn reads Status.Allocatable.Cpu().
const alloc96 = 96 - harvesterKubeletCpu(96);
eq('Longhorn instance-manager = 12% of allocatable, not capacity', lh.cpu, 0.12 * alloc96);
eq('  ... which is less than 12% of raw capacity', lh.cpu < 0.12 * 96 ? 1 : 0, 1);
is('Longhorn line is tier verified', lh.tier === 'verified');
is('Longhorn line cites Harvester + Longhorn source', /cos\.go/.test(lh.src) && /setting\.go/.test(lh.src));
eq('Harvester storage reserve default is 0%', oh.uniformStoragePct, 0);
is('every line carries a source', oh.lines.every(l => l.src && l.src.length > 10));
is('every line carries a known tier',
   oh.lines.every(l => ['verified', 'measured', 'estimate'].includes(l.tier)));
is('every line declares its basis',
   oh.lines.every(l => ['request', 'physical', 'reserve'].includes(l.basis)));

console.log('\n--- Term C: per-VM overhead ---');
// 100 VMs, 16 GB / 4 vCPU each. Fixed term recalibrated 146 -> 400 MiB from the
// measured 421 MiB request overhead of a 2 vCPU / 2 GiB guest.
const want = 0.002 * 1600 + (400 * 100 + 8 * 400) / 1024;
eq('per-VM lump (GB)', oh.perVmRam, want, 1e-6);
eq('per-VM CPU (80m each)', oh.lines.find(l => l.key === 'perVm').cpu, 0.08 * 100, 1e-9);

console.log('\n--- Node-count non-linearity: cluster term is flat ---');
const o3 = computePlatformOverhead('harvester', {}, { ...ctx, nodeCount: 3, vmCount: 50, vmRam: 800, vmVcpu: 200 });
const o5 = computePlatformOverhead('harvester', {}, { ...ctx, nodeCount: 5, vmCount: 100, vmRam: 1600, vmVcpu: 400 });
const clus = (o) => o.lines.filter(l => l.scope === 'cluster').reduce((s, l) => s + l.cpu, 0);
eq('cluster CPU is identical at 3 and 5 nodes', clus(o3), clus(o5));
eq('cluster RAM is identical at 3 and 5 nodes', o3.clusterRam, o5.clusterRam);
is('Harvester no longer uses the per-infra-node scope', o5.infraCount === 0);
is('... and emits no infra-node lines', !o5.lines.some(l => l.scope === 'infra-node'));
const o1 = computePlatformOverhead('harvester', {}, { ...ctx, nodeCount: 1 });
eq('cluster term does not shrink at 1 node', o1.clusterRam, o5.clusterRam);
is('per-node CPU is per-node; cluster does not scale',
   Math.abs(o5.uniformCpu - o3.uniformCpu) < 1e-9 && clus(o5) === clus(o3));

console.log('\n--- Add-ons ---');
const onV2 = computePlatformOverhead('harvester', { addons: { lhV2: true } }, ctx);
eq('V2 data engine doubles the Longhorn CPU term', onV2.uniformCpu - oh.uniformCpu, 0.12 * alloc96, 1e-9);
const v2line = onV2.lines.find(l => l.key === 'addon.lhV2');
eq('V2 adds 2 GiB huge pages per node', v2line.ram, 2);
const noMon = computePlatformOverhead('harvester', { addons: { monitoring: false } }, ctx);
is('monitoring is on by default and can be turned off', noMon.uniformCpu < oh.uniformCpu);
const gpuCtx = { ...ctx, devices: 8 };
const gpuOh = computePlatformOverhead('harvester', {}, gpuCtx);
is('GPU stack auto-enables when devices are present', !!gpuOh.lines.find(l => l.key === 'addon.gpuStack'));
eq('per-device RAM = 1 GiB x 8', gpuOh.lines.find(l => l.key === 'perDevice').ram, 8);

console.log('\n--- Overrides ---');
const ovr = computePlatformOverhead('harvester', { overrides: { 'agent.cpu': 3 } }, ctx);
eq('override replaces the table coefficient', ovr.uniformCpu - oh.uniformCpu, 3 - 1.03, 1e-9);
const ovrC = computePlatformOverhead('harvester', { overrides: { 'cluster.cp.ram': 5 } }, ctx);
eq('cluster-scope coefficients are overridable', ovrC.clusterRam - oh.clusterRam, 5 - 1.19, 1e-9);

console.log('\n--- Robustness: malformed imported config ---');
for (const bad of [null, undefined, {}, { auto: false }, { addons: null, overrides: null }]) {
  const o = computePlatformOverhead('harvester', bad, ctx);
  is(`no NaN for cfg=${JSON.stringify(bad)}`,
     [o.uniformCpu, o.uniformRam, o.lumpCpu, o.lumpRam, o.uniformStoragePct].every(Number.isFinite));
}
for (const badCtx of [{}, { nodeCount: 'x', hostThreads: null, hostRam: NaN, vmCount: undefined }]) {
  const o = computePlatformOverhead('harvester', {}, badCtx);
  is('no NaN for malformed ctx', [o.uniformCpu, o.uniformRam, o.lumpCpu, o.lumpRam].every(Number.isFinite));
}
is("unknown platform key falls back to zero overhead",
   computePlatformOverhead('bogus', {}, ctx).uniformCpu === 0);
is("'none' yields zero overhead and no lines",
   computePlatformOverhead('none', {}, ctx).uniformCpu === 0 &&
   computePlatformOverhead('none', {}, ctx).lines.length === 0);
is("auto:false disables the model", computePlatformOverhead('harvester', { auto: false }, ctx).uniformCpu === 0);

console.log('\n--- Model-completeness metadata ---');
{
  const d = (k) => computePlatformOverhead(k, {}, ctx);
  is('Harvester is marked calibrated with no gaps',
     d('harvester').depth === 'calibrated' && d('harvester').depthGaps.length === 0);
  for (const k of ['ocpvirt', 'vsphere', 'ahv', 'proxmox']) {
    const o = d(k);
    is(`${k}: declares a depth`, ['modelled', 'partial', 'indicative'].includes(o.depth));
    is(`${k}: explains itself (note or named gaps)`, !!o.depthNote || o.depthGaps.length > 0);
  }
  is('none carries no depth claim', d('none').depth === null);
  /* A "modelled" claim must be backed by the terms actually existing —
     otherwise the marker is decoration rather than disclosure. */
  for (const k of ['ocpvirt', 'vsphere', 'ahv', 'proxmox']) {
    const P = HYPERVISORS[k];
    is(`${k}: modelled => has a cluster-wide management term`,
       P.depth !== 'modelled' || ((P.cluster || []).length > 0 || (P.infraNode || []).length > 0));
    const hasStorage = Object.values(P.addons || {}).some(a => a.requiresLocalStorage)
      || (P.perNode || []).some(i => i.ramPerTb || i.cpuPerTb)
      || k === 'ahv';   // the CVM already is the storage service
    is(`${k}: modelled => storage service is accounted for`, P.depth !== 'modelled' || hasStorage);
  }
  // Storage services must vanish on external arrays.
  for (const k of ['vsphere', 'proxmox', 'ocpvirt']) {
    const local = computePlatformOverhead(k, {}, { ...ctx, externalStorage: false });
    const ext = computePlatformOverhead(k, {}, { ...ctx, externalStorage: true });
    is(`${k}: storage service drops out on external storage`, ext.uniformRam < local.uniformRam);
  }
  // vCenter is a step function of cluster size, from the published table.
  {
    const vc = (n, v) => (computePlatformOverhead('vsphere', {}, { ...ctx, nodeCount: n, vmCount: v })
      .lines.find(l => /vCenter/.test(l.label)) || {});
    is('vCenter is Tiny for a small cluster', /Tiny/.test(vc(5, 100).label));
    is('vCenter steps up to Small past 100 VMs', /Small/.test(vc(20, 900).label));
    is('vCenter steps up to Medium past 1000 VMs', /Medium/.test(vc(200, 3000).label));
    is('vCenter grows with the step', vc(200, 3000).ram > vc(5, 100).ram);
  }
}

console.log('\n--- All platforms are well-formed ---');
for (const k of Object.keys(HYPERVISORS)) {
  const o = computePlatformOverhead(k, {}, ctx);
  is(`${k}: finite, sourced, tiered`,
     [o.uniformCpu, o.uniformRam, o.lumpCpu, o.lumpRam, o.clusterCpu, o.clusterRam,
      o.physPerNodeRam, o.physLumpRam].every(Number.isFinite) &&
     o.lines.every(l => l.src && ['verified', 'measured', 'estimate'].includes(l.tier)));
}
is('AHV is flagged as unable to overcommit RAM', computePlatformOverhead('ahv', {}, ctx).noRamOvercommit === true);
is('Harvester is not so flagged', computePlatformOverhead('harvester', {}, ctx).noRamOvercommit === false);

console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECK(S) FAILED'}`);
process.exit(fails === 0 ? 0 : 1);
