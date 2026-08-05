const { gkeReservedCpu, harvesterKubeletCpu, computePlatformOverhead, HYPERVISORS, overrideSchema } =
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
/* 100 VMs, 16 GB / 4 vCPU each, via KubeVirt's GetMemoryOverhead():
     per VM   fixed 220 + IOThread 8 + graphics 32 = 260 MiB
     per vCPU 8 MiB
     pagetables guest RAM / 512
   then x Harvester's AdditionalGuestMemoryOverheadRatio (1.5). */
const want = (((220 + 8 + 32) * 100 + 8 * 400 + (1600 * 1024) / 512) / 1024) * 1.5;
eq('per-VM lump (GB)', oh.perVmRam, want, 1e-6);
eq('  ... which is 1.5x the un-ratioed KubeVirt figure', oh.perVmRam / 1.5,
   ((220 + 8 + 32) * 100 + 8 * 400 + (1600 * 1024) / 512) / 1024, 1e-6);
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
/* VFIO is now inside the per-VM term and charged per passthrough VM, not per
   device — verified against a live 2-device VM that paid exactly 1 GiB. */
is('no separate per-device line on KubeVirt platforms',
   !gpuOh.lines.some(l => l.key === 'perDevice'));
{
  const vf = (gpuVms) => computePlatformOverhead('harvester', {}, { ...gpuCtx, vmCount: 4,
    vmRam: 64, vmRamRequested: 64, vmVcpu: 16, devices: 8, gpuVms }).perVmRam;
  eq('VFIO adds 1 GiB x 1.5 per passthrough VM', vf(2) - vf(0), 2 * 1.5, 1e-9);
  eq('  ... and does not scale with device count', vf(1) - vf(0), 1.5, 1e-9);
}

console.log('\n--- Overrides ---');
const ovr = computePlatformOverhead('harvester', { overrides: { 'agent.cpu': 3 } }, ctx);
eq('override replaces the table coefficient', ovr.uniformCpu - oh.uniformCpu, 3 - 1.03, 1e-9);
const ovrC = computePlatformOverhead('harvester', { overrides: { 'cluster.cp.ram': 5 } }, ctx);
eq('cluster-scope coefficients are overridable', ovrC.clusterRam - oh.clusterRam, 5 - 1.19, 1e-9);
// AdditionalGuestMemoryOverheadRatio is a cluster setting (range 1.0-10.0).
const ovrR = computePlatformOverhead('harvester', { overrides: { 'perVm.overheadRatio': 3 } }, ctx);
eq('the guest-memory overhead ratio is overridable', ovrR.perVmRam / oh.perVmRam, 3 / 1.5, 1e-9);
const ovrR1 = computePlatformOverhead('harvester', { overrides: { 'perVm.overheadRatio': 0.5 } }, ctx);
eq('  ... and clamped at the documented minimum of 1.0', ovrR1.perVmRam / oh.perVmRam, 1 / 1.5, 1e-9);

console.log('\n--- KubeVirt formula: Harvester vs OpenShift differ only by the ratio ---');
{
  const c = { addons: { monitoring: false, logging: false, gpuStack: false, rancher: false, lhV2: false, odf: false } };
  const k = (p) => computePlatformOverhead(p, c, { ...ctx, externalStorage: true });
  eq('OpenShift per-VM = Harvester per-VM / 1.5', k('ocpvirt').perVmRam, k('harvester').perVmRam / 1.5, 1e-9);
  is('both are tier verified',
     ['harvester', 'ocpvirt'].every(p => HYPERVISORS[p].perVm.tier === 'verified'));
  is('both cite the KubeVirt source',
     ['harvester', 'ocpvirt'].every(p => /kubevirt\/kubevirt/.test(HYPERVISORS[p].perVm.src)));
  is('VFIO is 1 GiB per passthrough VM, inside the per-VM term',
     ['harvester', 'ocpvirt'].every(p => HYPERVISORS[p].perVm.vfioGiB === 1 &&
        HYPERVISORS[p].perDevice === null));
  is('non-KubeVirt platforms keep a per-device term',
     ['vsphere', 'ahv', 'proxmox'].every(p => HYPERVISORS[p].perDevice &&
        HYPERVISORS[p].perDevice.ramGiB === 1));
  // Non-KubeVirt platforms keep the simpler published form.
  is('vSphere/AHV/Proxmox still use the factor form',
     ['vsphere', 'ahv', 'proxmox'].every(p => HYPERVISORS[p].perVm.kind !== 'kubevirt'));
}

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

console.log('\n--- Every editable control actually does something ---');
/* v2.8.0 shipped a panel offering three per-VM fields that the KubeVirt code
   path ignored. The panel is now generated from overrideSchema(); this asserts
   every key it advertises genuinely moves the numbers, for every platform. */
{
  // A context that exercises every term: GPUs present, local storage, VMs,
  // and every add-on switched on.
  const full = (k) => {
    const addons = {};
    Object.keys(HYPERVISORS[k].addons || {}).forEach(a => { addons[a] = true; });
    return addons;
  };
  const CTX = { nodeCount: 5, hostThreads: 96, hostRam: 512, hostStorage: 7680,
                vmCount: 100, vmRam: 1600, vmVcpu: 400, devices: 4,
                replicas: 3, externalStorage: false };
  const fingerprint = (o) => [o.uniformCpu, o.uniformRam, o.uniformStoragePct, o.lumpCpu, o.lumpRam,
                              o.clusterCpu, o.clusterRam, o.physPerNodeRam, o.physLumpRam,
                              o.perVmRam].map(x => x.toFixed(9)).join('|');
  let dead = 0, total = 0;
  for (const k of Object.keys(HYPERVISORS)) {
    if (k === 'none') continue;
    const cfg = { auto: true, addons: full(k), overrides: {} };
    const base = fingerprint(computePlatformOverhead(k, cfg, CTX));
    for (const g of overrideSchema(HYPERVISORS[k])) {
      for (const f of g.items) {
        total++;
        // Nudge the coefficient well away from its default and require movement.
        const probe = (Number(f.dflt) || 0) + (f.key.endsWith('Divisor') ? 512 : 7);
        const moved = fingerprint(computePlatformOverhead(k,
          { ...cfg, overrides: { [f.key]: probe } }, CTX)) !== base;
        if (!moved) { console.log(`FAIL  ${k}: control "${f.label}" (${f.key}) has NO EFFECT`); dead++; fails++; }
      }
    }
  }
  is(`all ${total} advertised controls across every platform are live (${dead} dead)`, dead === 0);

  // ... and the reverse: the panel must not omit a coefficient the table declares.
  for (const k of Object.keys(HYPERVISORS)) {
    if (k === 'none') continue;
    const keys = new Set(overrideSchema(HYPERVISORS[k]).flatMap(g => g.items.map(i => i.key)));
    const P = HYPERVISORS[k];
    const want = [];
    // Physical lines are RAM-only in the engine, so no CPU control is expected.
    const fieldsFor = (i) => (i.basis === 'physical'
      ? ['ram', 'ramPct', 'ramPerTb'] : ['cpu', 'ram', 'cpuPct', 'ramPct', 'cpuPerTb', 'ramPerTb']);
    (P.perNode || []).forEach(i => fieldsFor(i)
      .forEach(f => { if (i[f] != null) want.push(`${i.key}.${f}`); }));
    (P.cluster || []).forEach(i => fieldsFor(i)
      .forEach(f => { if (i[f] != null) want.push(`cluster.${i.key}.${f}`); }));
    (P.infraNode || []).forEach(i => ['cpu','ram']
      .forEach(f => { if (i[f] != null) want.push(`infra.${i.key}.${f}`); }));
    const missing = want.filter(w => !keys.has(w));
    is(`${k}: panel exposes every declared coefficient${missing.length ? ' — missing ' + missing.join(', ') : ''}`,
       missing.length === 0);
  }
  // The two biggest levers must be reachable by name.
  const hKeys = new Set(overrideSchema(HYPERVISORS.harvester).flatMap(g => g.items.map(i => i.key)));
  is('Longhorn 12% is editable (lhim.cpuPct)', hKeys.has('lhim.cpuPct'));
  is('the KubeVirt overhead ratio is editable (perVm.overheadRatio)', hKeys.has('perVm.overheadRatio'));
  is('cluster-scope services are editable', [...hKeys].some(k => k.startsWith('cluster.')));
}

console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECK(S) FAILED'}`);
process.exit(fails === 0 ? 0 : 1);
