const { virtSummary, scenarios } = require('./harness.js');
const clone = (o) => JSON.parse(JSON.stringify(o));

let fails = 0;
const is = (n, c) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) fails++; };

const withPlatform = (base, platform, extra = {}) => {
  const s = clone(base);
  s.virtualization.platform = platform;
  s.virtualization.overhead = { auto: true, addons: {}, overrides: {}, ...extra };
  return s;
};

console.log('--- Selecting a platform costs capacity ---');
const none = virtSummary(withPlatform(scenarios.auto, 'none'));
const harv = virtSummary(withPlatform(scenarios.auto, 'harvester'));
console.log(`  none:      ${none.decided} hosts, primary usable ${none.primary.cpu} thr / ${none.primary.ram} GB`);
console.log(`  harvester: ${harv.decided} hosts, primary usable ${harv.primary.cpu.toFixed(2)} thr / ${harv.primary.ram} GB`);
is('Harvester reduces usable CPU per host', harv.primary.cpu < none.primary.cpu);
is('Harvester reduces usable RAM per host', harv.primary.ram < none.primary.ram);
is('Harvester needs at least as many hosts', harv.decided >= none.decided);
is('overhead is reported', harv.overhead.lines.length > 0);

console.log('\n--- Overcommit is never mutated ---');
const before = clone(scenarios.auto).virtualization.overcommit;
for (const p of ['harvester', 'ahv', 'vsphere', 'proxmox', 'ocpvirt', 'none']) {
  const s = withPlatform(scenarios.auto, p);
  virtSummary(s);
  if (s.virtualization.overcommit.vcpu !== before.vcpu || s.virtualization.overcommit.ram !== before.ram) {
    console.log(`FAIL  ${p} mutated overcommit`); fails++;
  }
}
is('all platforms left overcommit at 4 / 1.2', true);

console.log('\n--- AHV memory-overcommit design rule ---');
const ahv = virtSummary(withPlatform(scenarios.auto, 'ahv'));   // fixture has ram overcommit 1.2
const ahvRule = ahv.checks.find(c => /cannot overcommit memory/.test(c.label));
is('AHV rule is present and FAILS at 1.2:1', !!ahvRule && ahvRule.ok === false);
const s11 = withPlatform(scenarios.auto, 'ahv'); s11.virtualization.overcommit.ram = 1;
const ahv1 = virtSummary(s11);
is('AHV rule PASSES at 1:1', ahv1.checks.find(c => /cannot overcommit memory/.test(c.label)).ok === true);
is('no AHV rule on Harvester', !harv.checks.find(c => /cannot overcommit memory/.test(c.label)));
is('no overhead rules at all on none', !none.checks.find(c => /platform overhead/.test(c.label)));

console.log('\n--- Convergence: tiny hosts, heavy overhead ---');
const tiny = withPlatform(scenarios.auto, 'harvester');
tiny.virtualization.hosts[0] = { ...tiny.virtualization.hosts[0], sockets: 1, coresPerSocket: 8, threadsPerCore: 2, ram: 64, storage: 1000, gpus: 1 };
const t0 = Date.now();
const tr = virtSummary(tiny);
is('terminates quickly', Date.now() - t0 < 1000);
is('produces a finite host count', Number.isFinite(tr.decided) && tr.decided > 0);
console.log(`  tiny host: ${tr.decided} hosts, usable ${tr.primary.cpu.toFixed(2)} thr / ${tr.primary.ram} GB`);
// Idempotence: re-running must land on the same fixed point.
is('fixed point is stable across runs', virtSummary(tiny).decided === tr.decided);

console.log('\n--- Pool mode: single pass, overhead applied ---');
const poolN = virtSummary(withPlatform(scenarios.pool, 'none'));
const poolH = virtSummary(withPlatform(scenarios.pool, 'harvester'));
is('pool surviving CPU shrinks under Harvester', poolH.cap.cpu.surviving < poolN.cap.cpu.surviving);
is('pool still reports feasibility', typeof poolH.feasible === 'boolean');

/* Heterogeneous hosts: each host type must be charged overhead computed against
   its OWN size, not the primary's rescaled. The terms scale differently —
   Longhorn is %-of-allocatable, the kubelet reserve is its own non-linear
   formula, and the pod footprints are flat — so a single scale factor
   overstates usable capacity on every non-primary host. */
const { harvesterKubeletCpu: kube } = require('./harness.js');
const h1 = poolH.hostCaps.find(h => h.id === 'h1');   // 96 threads (primary)
const h2 = poolH.hostCaps.find(h => h.id === 'h2');   // 64 threads
// agent + virt + lhmgr + monitoring + gpuStack (auto-on, fixture has GPUs) + rancher
const flat = 1.03 + 0.59 + 0.26 + 0.10 + 0.5 + 0.05;   // monitoring is 0.10 since v2.10.0
// Longhorn takes 12% of ALLOCATABLE (capacity minus the kubelet reserve).
const expect = (thr) => 0.12 * (thr - kube(thr)) + flat + kube(thr);
is(`h1 (96 thr) overhead = ${expect(96).toFixed(2)}`, Math.abs(h1.ohCpu - expect(96)) < 1e-9);
is(`h2 (64 thr) overhead = ${expect(64).toFixed(2)} (not the primary's rescaled)`,
   Math.abs(h2.ohCpu - expect(64)) < 1e-9);
is('h2 is NOT h1 scaled by thread ratio', Math.abs(h2.ohCpu - h1.ohCpu * 64 / 96) > 0.5);
is('flat terms do not shrink with host size',
   Math.abs((h2.ohCpu - 0.12 * (64 - kube(64)) - kube(64))
          - (h1.ohCpu - 0.12 * (96 - kube(96)) - kube(96))) < 1e-9);
is('RAM overhead is identical across host types (all flat terms)', Math.abs(h1.ohRam - h2.ohRam) < 1e-9);
// ZFS ARC is a % of host RAM: it must follow each host, not the primary.
// Ceph is on by default and also scales per host, so isolate ZFS by disabling it.
const pve = virtSummary(withPlatform(scenarios.pool, 'proxmox', { addons: { zfsArc: true, ceph: false } }));
const p1 = pve.hostCaps.find(h => h.id === 'h1'), p2 = pve.hostCaps.find(h => h.id === 'h2');
is('Proxmox ZFS ARC scales with each host RAM (10% of 512 vs 10% of 256)',
   Math.abs((p1.ohRam - p2.ohRam) - (0.10 * 512 - 0.10 * 256)) < 1e-9);
// Storage services scale per TB of that host's own disk (7680 vs 3840 GB).
const cep = virtSummary(withPlatform(scenarios.pool, 'proxmox', { addons: { zfsArc: false, ceph: true } }));
const c1 = cep.hostCaps.find(h => h.id === 'h1'), c2 = cep.hostCaps.find(h => h.id === 'h2');
is('Proxmox Ceph RAM scales per TB of each host disk (1 GB/TB)',
   Math.abs((c1.ohRam - c2.ohRam) - (7680 - 3840) / 1024 * 1) < 1e-9);
is('Proxmox Ceph CPU scales per TB of each host disk (0.25 thr/TB)',
   Math.abs((c1.ohCpu - c2.ohCpu) - (7680 - 3840) / 1024 * 0.25) < 1e-9);
// vSAN and ODF must disappear entirely on an external array.
for (const [plat, name] of [['vsphere', 'vSAN'], ['proxmox', 'Ceph'], ['ocpvirt', 'ODF']]) {
  const loc = withPlatform(scenarios.auto, plat);
  const ext = withPlatform(scenarios.auto, plat); ext.virtualization.storage.external = true;
  is(`${name} drops out when an external array is used`,
     virtSummary(ext).overhead.uniformRam < virtSummary(loc).overhead.uniformRam);
}
// vCenter is a cluster service sized from the published table.
const vsp = virtSummary(withPlatform(scenarios.auto, 'vsphere'));
is('vCenter appears once per cluster, sized from the table',
   vsp.overhead.lines.some(l => l.scope === 'cluster' && /vCenter Server Appliance —/.test(l.label)));

console.log('\n--- Provisioned totals (BOM) stay raw ---');
is('BOM RAM unchanged by platform choice', harv.totals.ram === none.totals.ram);
is('BOM threads unchanged for equal host counts',
   harv.decided !== none.decided || harv.totals.threads === none.totals.threads);

console.log('\n--- Scenario table: 3n/50vm vs 5n/100vm ---');
const sc = harv.overheadScenarios;
const row = (n, v) => sc.find(r => r.nodes === n && r.vms === v);
const r3 = row(3, 50), r5 = row(5, 100);
console.log(`  3 nodes /  50 VMs: ${r3.cpu.toFixed(1)} thr, ${r3.ram.toFixed(1)} GB`);
console.log(`  5 nodes / 100 VMs: ${r5.cpu.toFixed(1)} thr, ${r5.ram.toFixed(1)} GB`);
console.log(`  7 nodes / 200 VMs: ${row(7,200).cpu.toFixed(1)} thr, ${row(7,200).ram.toFixed(1)} GB`);
is('overhead grows with cluster size', r5.cpu > r3.cpu && r5.ram > r3.ram);
/* The scenario rows vary nodes AND VMs together, so their ratio is dominated by
   the per-VM terms — it is not a test of cluster flatness. Isolate node scaling
   at a fixed VM count, which is where the flat cluster term actually shows. */
const { computePlatformOverhead: cpo } = require('./harness.js');
const nodeOnly = (n) => {
  const oh = cpo('harvester', {}, { nodeCount: n, hostThreads: 96, hostRam: 512,
    vmCount: 50, vmRam: 800, vmVcpu: 200, devices: 0, replicas: 3, externalStorage: false });
  return { cpu: oh.uniformCpu * n + oh.lumpCpu, ram: oh.uniformRam * n + oh.lumpRam };
};
const n3 = nodeOnly(3), n5 = nodeOnly(5);
is(`node scaling is sub-linear: 3->5 nodes costs ${(n5.ram / n3.ram).toFixed(3)}x RAM, not 1.667x`,
   n5.ram / n3.ram < 5 / 3);
is('... and sub-linear on CPU too', n5.cpu / n3.cpu < 5 / 3);
is('cluster overhead is identical at every scenario size',
   new Set([1, 3, 5, 7].map(n => cpo('harvester', {}, { nodeCount: n, hostThreads: 96, hostRam: 512,
     vmCount: 50, vmRam: 800, vmVcpu: 200, devices: 0 }).clusterRam.toFixed(6))).size === 1);
is('current row is marked', sc.some(r => r.current));
is('no scenarios on the none platform', none.overheadScenarios.length === 0);

console.log('\n--- Switching overhead off leaves no residue ---');
/* Selecting a platform but turning "apply automatically" off must behave like
   no platform at all: no breakdown, no what-if table of zeroes, and no
   design-rule checks that cannot fail. */
{
  const off = withPlatform(scenarios.auto, 'harvester', { auto: false });
  const r = virtSummary(off);
  const ohRule = (c) => /platform overhead|Physical RAM holds|carries the cluster services|cannot overcommit memory/.test(c.label);
  is('no overhead line items', r.overhead.lines.length === 0);
  is('no all-zero scenario table', r.overheadScenarios.length === 0);
  is('no overhead design-rule checks', !r.checks.some(ohRule));
  is('host sizing matches the no-platform case',
     r.decided === none.decided && Math.abs(r.primary.cpu - none.primary.cpu) < 1e-9);
  is('totals are zero, not NaN',
     [r.overhead.uniformCpu, r.overhead.uniformRam, r.overhead.lumpCpu, r.overhead.lumpRam,
      r.overhead.clusterCpu, r.overhead.clusterRam].every(x => x === 0));
  // ... and none of it comes back for a platform with no terms selected either.
  is('platform=none is likewise empty',
     none.overhead.lines.length === 0 && none.overheadScenarios.length === 0 &&
     !none.checks.some(ohRule));
}

console.log('\n--- Physical vs request basis ---');
is('storage-engine RAM is physical, not a request',
   (harv.overhead.lines.find(l => l.key === 'perVmDisk') || {}).basis === 'physical');
is('physical RAM is reported separately from the sizing totals',
   harv.overhead.physLumpRam > 0 && harv.overhead.physPerNodeRam > 0);
const physRule = harv.checks.find(c => /Physical RAM holds/.test(c.label));
is('physical-capacity rule is present', !!physRule);
is('physical rule passes on a sanely-sized host', physRule.ok === true);
// External storage removes the Longhorn replica engines entirely.
const extS = withPlatform(scenarios.auto, 'harvester');
extS.virtualization.storage.external = true;
is('external storage pays no storage-engine RAM',
   !virtSummary(extS).overhead.lines.some(l => l.key === 'perVmDisk'));
const leadRule = harv.checks.find(c => /carries the cluster services/.test(c.label));
is('leader-node headroom advisory is present', !!leadRule);
is('no leader advisory on the none platform',
   !none.checks.some(c => /carries the cluster services/.test(c.label)));

console.log('\n--- Storage reserve (Term E) ---');
const stor = virtSummary(withPlatform(scenarios.auto, 'harvester', { overrides: { 'storage.pct': 20 } }));
is('20% storage reserve shrinks usable disk',
   Math.abs(stor.primary.storage - stor.primary.rawStorage * 0.8) < 1e-6);
is('default (0%) leaves disk untouched', harv.primary.storage === harv.primary.rawStorage);

console.log(`\n${fails === 0 ? 'ALL E2E CHECKS PASSED' : fails + ' CHECK(S) FAILED'}`);
process.exit(fails === 0 ? 0 : 1);
