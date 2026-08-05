const { gkeReservedCpu, harvesterKubeletCpu, openshiftReservedCpu, openshiftReservedRam,
        computePlatformOverhead, HYPERVISORS, overrideSchema } = require('./harness.js');

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

/* ---------------------------------------------------------------------
   OpenShift Virtualization. Until v2.9 this platform charged its whole
   control plane per node, which overstated a large cluster badly. These
   assertions pin BOTH halves of the fix: the singletons must be flat, and
   the per-node terms must be the small DaemonSet figures plus OpenShift's
   own auto-sized reserve. Nothing else guards this platform.
   ------------------------------------------------------------------ */
console.log('\n--- OpenShift Virtualization: Term A (node auto-sizing) ---');
// Transcribed from dynamic-system-reserved-calc.sh; see METHODOLOGY § 7a.3a.
eq('CPU: 60m + 12m per extra thread (96 threads)', openshiftReservedCpu(96), 1.2, 1e-9);
eq('CPU: floored at 500m on a small node', openshiftReservedCpu(4), 0.5);
eq('CPU: 0 threads is safe', openshiftReservedCpu(0), 0);
eq('RAM: 1 GiB flat below 8 GB', openshiftReservedRam(8), 1);
eq('RAM: 1 + 6% of the next 120 GB (128 GB host)', openshiftReservedRam(128), 8);
// The script subtracts 112, not 120, before the 2% tier — reproduce it.
eq('RAM: the 112-not-120 quirk (512 GB host)', openshiftReservedRam(512), 16);
eq('RAM: 0 GB is safe', openshiftReservedRam(0), 0);

console.log('\n--- OpenShift Virtualization: singletons do not scale ---');
const ocpCtx = { hostThreads: 96, hostRam: 512, hostStorage: 7680, vmCount: 100, vmRam: 1600,
                 vmRamRequested: 1600, vmVcpu: 400, devices: 0 };
const ocp3  = computePlatformOverhead('ocpvirt', {}, { ...ocpCtx, nodeCount: 3 });
const ocp20 = computePlatformOverhead('ocpvirt', {}, { ...ocpCtx, nodeCount: 20 });
eq('cluster RAM identical at 3 and 20 nodes', ocp3.clusterRam, ocp20.clusterRam);
eq('cluster CPU identical at 3 and 20 nodes', ocp3.clusterCpu, ocp20.clusterCpu);
is('the CNV control plane is in the cluster scope, not per-node',
   ocp3.lines.some(l => l.scope === 'cluster' && l.key === 'cluster.virtcp'));
is('only virt-handler is charged per node for KubeVirt',
   ocp3.lines.filter(l => l.scope === 'per-node' && /virt/i.test(l.label) && l.basis === 'request')
      .every(l => l.cpu <= 0.05));
// The regression this whole change exists to prevent.
is('per-node request RAM is DaemonSet-sized, not control-plane-sized',
   ocp3.lines.filter(l => l.scope === 'per-node' && l.basis === 'request'
                          && !l.key.startsWith('addon.'))
      .reduce((s, l) => s + l.ram, 0) < 3);
console.log('\n--- OpenShift Virtualization: Term A enters the per-node total ---');
{
  const kube = ocp3.lines.find(l => l.key === 'kubelet');
  is('the kubelet line exists and is a reserve', !!kube && kube.basis === 'reserve');
  eq('  ... and reserves RAM as well as CPU (Harvester does not)', kube.ram, 16);
  const perNodeReq = ocp3.lines.filter(l => l.scope === 'per-node' && l.basis === 'request')
                               .reduce((s, l) => s + l.ram, 0);
  eq('uniformRam = kubelet reserve + per-node requests', ocp3.uniformRam, 16 + perNodeReq, 1e-9);
  /* Red Hat's "+2 cores/node" is documentation, not a coefficient. Modelling it
     as a physical line would ship an editable control that moves no number:
     ocpvirt has no measured per-VM resident figure, so the physical-capacity
     design rule cannot fire — the dead-knob failure overrideSchema exists to
     prevent. It lives in METHODOLOGY § 7a.6a instead. */
  is('Red Hat’s +2 cores/node guidance is not charged as a coefficient',
     !ocp3.lines.some(l => l.basis === 'physical'));
  is('  ... and ocpvirt declares no physical term it cannot enforce',
     ocp3.physPerNodeRam === 0 && !HYPERVISORS.ocpvirt.perVmPhysicalRamMiB);
  is('the three masters still use the per-control-plane-node scope', ocp3.infraCount === 3);
}

/* ---------------------------------------------------------------------
   vSphere / AHV / Proxmox. These had NO test coverage at all: any
   coefficient edit landed silently. These assertions pin the totals and
   the platform-specific mechanisms, so a change has to be deliberate.
   ------------------------------------------------------------------ */
console.log('\n--- vSphere: vCenter is sized from the published table ---');
{
  const c = { hostThreads: 96, hostRam: 512, hostStorage: 7680, vmRam: 1600, vmRamRequested: 1600,
              vmVcpu: 400, devices: 0 };
  const small = computePlatformOverhead('vsphere', {}, { ...c, nodeCount: 5,  vmCount: 100 });
  const large = computePlatformOverhead('vsphere', {}, { ...c, nodeCount: 500, vmCount: 9000 });
  const row = (o) => o.lines.find(l => l.key === 'cluster.vcsa');
  is('a 5-node/100-VM cluster resolves to Tiny', /Tiny/.test(row(small).label));
  is('a 500-node/9000-VM cluster resolves to Large', /Large/.test(row(large).label));
  is('  ... and the resolved row is bigger than the small one', row(large).ram > row(small).ram);
  // The placeholder in the table must never be presented as the default.
  const vcsaGroup = overrideSchema(HYPERVISORS.vsphere)
    .find(g => /vCenter Server Appliance/.test(g.title));
  is('the panel flags vCenter as auto-sized rather than advertising a default',
     /auto-sized from the published table/.test(vcsaGroup.title));
  // An override must still beat the resolved row, or the control is a lie.
  const forced = computePlatformOverhead('vsphere', { overrides: { 'cluster.vcsa.ram': 99 } },
                                         { ...c, nodeCount: 5, vmCount: 100 });
  eq('an explicit override beats the table row', row(forced).ram, 99);
}

console.log('\n--- AHV: the CVM grows with enabled features ---');
{
  const c = { nodeCount: 5, hostThreads: 96, hostRam: 512, hostStorage: 7680, vmCount: 100,
              vmRam: 1600, vmRamRequested: 1600, vmVcpu: 400, devices: 0 };
  const base = computePlatformOverhead('ahv', {}, c);
  const rf3  = computePlatformOverhead('ahv', { addons: { cvmRf3: true } }, c);
  const both = computePlatformOverhead('ahv', { addons: { cvmRf3: true, cvmDedupe: true } }, c);
  eq('RF3 adds 8 GB per node to the CVM', rf3.uniformRam - base.uniformRam, 8, 1e-9);
  eq('RF3 + capacity dedupe add 16 GB, Nutanix’s stated cap', both.uniformRam - base.uniformRam, 16, 1e-9);
  is('both feature toggles default to OFF (a plain RF2 cluster does not pay them)',
     base.uniformRam === HYPERVISORS.ahv.perNode[0].ram + HYPERVISORS.ahv.perNode[1].ram);
  is('AHV still refuses memory overcommit', base.noRamOvercommit === true);
}

console.log('\n--- Doc-sourced platforms: totals are pinned ---');
{
  // 5 nodes / 100 VMs on 96-thread / 512 GB / 7.68 TB hosts — the same
  // configuration METHODOLOGY § 7a.1b tabulates. If these move, that table
  // is stale and the change was probably not deliberate.
  const c = { nodeCount: 5, hostThreads: 96, hostRam: 512, hostStorage: 7680, vmCount: 100,
              vmRam: 1600, vmRamRequested: 1600, vmVcpu: 400, devices: 0 };
  const total = (p) => {
    const o = computePlatformOverhead(p, {}, c);
    return { cpu: o.uniformCpu * 5 + o.lumpCpu, ram: o.uniformRam * 5 + o.lumpRam };
  };
  const want = { harvester: [87, 76], ocpvirt: [52, 236], vsphere: [53, 115],
                 ahv: [51, 209], proxmox: [15, 102] };
  for (const [p, [cpu, ram]] of Object.entries(want)) {
    const t = total(p);
    eq(`${p}: CPU at 5 nodes / 100 VMs`, Math.round(t.cpu), cpu, 1);
    eq(`${p}: RAM at 5 nodes / 100 VMs`, Math.round(t.ram), ram, 1);
  }
}

console.log('\n--- Platform prose stays in step with the model ---');
{
  const { PLATFORM_WORDS } = require('./harness.js');
  // A sentence that names a component must name the RIGHT one: the panel used
  // to tell every platform its storage was Longhorn and its cluster services
  // were Rancher and CDI.
  for (const k of Object.keys(HYPERVISORS)) {
    is(`${k}: has UI prose for its storage and cluster services`,
       !!(PLATFORM_WORDS[k] && PLATFORM_WORDS[k].storage && PLATFORM_WORDS[k].clusterSvc));
  }
  is('no platform is described with another platform’s storage engine',
     !/Longhorn/.test(PLATFORM_WORDS.vsphere.storage + PLATFORM_WORDS.ahv.storage
                      + PLATFORM_WORDS.proxmox.storage + PLATFORM_WORDS.ocpvirt.storage));
  is('nor with another platform’s cluster services',
     !/Rancher|Harvester/.test(PLATFORM_WORDS.vsphere.clusterSvc + PLATFORM_WORDS.ahv.clusterSvc
                               + PLATFORM_WORDS.proxmox.clusterSvc + PLATFORM_WORDS.ocpvirt.clusterSvc));
  is('every prose entry corresponds to a real platform',
     Object.keys(PLATFORM_WORDS).every(k => k in HYPERVISORS));
}

console.log('\n--- Overrides ---');
const ovr = computePlatformOverhead('harvester', { overrides: { 'agent.cpu': 3 } }, ctx);
eq('override replaces the table coefficient', ovr.uniformCpu - oh.uniformCpu, 3 - 1.03, 1e-9);
const ovrC = computePlatformOverhead('harvester', { overrides: { 'cluster.cp.ram': 5 } }, ctx);
eq('cluster-scope coefficients are overridable', ovrC.clusterRam - oh.clusterRam, 5 - 2.60, 1e-9);
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
