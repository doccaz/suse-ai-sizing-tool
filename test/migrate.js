/* Import compatibility. Extracts the REAL isValidConfig + migrateState from
   index.html and feeds them configs in every historical shape. */
const fs = require('fs');
const path = require('path');
const os = require('os');

const SRC = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(SRC, 'utf8');
const lines = src.split('\n');

function block(startRe, endRe) {
  const s = lines.findIndex(l => startRe.test(l));
  if (s < 0) throw new Error('not found: ' + startRe);
  for (let i = s + 1; i < lines.length; i++) if (endRe.test(lines[i])) return lines.slice(s, i + 1).join('\n');
  throw new Error('no end for ' + startRe);
}
const one = (re) => lines.find(l => re.test(l));

const mod = `
const uid = () => Math.random().toString(36).slice(2, 9);
const Server = null, Layers = null, Cpu = null;   // icon refs, irrelevant here
${block(/^\s*const baseComponentData = \{/, /^\s{6}\};\s*$/)}
${one(/^\s*const baseOrder =/)}
${block(/^\s*const effNodes = \(g\) => \{/, /^\s{6}\};\s*$/)}
${block(/^\s*const defaultHostType = /, /^\s{6}\}\);\s*$/)}
${block(/^\s*const defaultVirt = /, /^\s{6}\}\);\s*$/)}
${one(/^\s*const HARVESTER_DOCS =/)}
${block(/^\s*const VCSA_SIZES = \[/, /^\s{6}\];\s*$/)}
${block(/^\s*const vcsaSize = /, /VCSA_SIZES\.length - 1\];\s*$/)}
${block(/^\s*const OVERHEAD_SRC = \{/, /^\s{6}\};\s*$/)}
${one(/^\s*const HARVESTER_MAX_PODS =/)}
${block(/^\s*const gkeReservedCpu = /, /^\s{6}\};\s*$/)}
${one(/^\s*const harvesterKubeletCpu = /)}
${block(/^\s*const HYPERVISORS = \{/, /^\s{6}\};\s*$/)}
${block(/^\s*const hypervisorKey = /, /'none';\s*$/)}
${block(/^\s*const defaultProfiles = /, /^\s{6}\]\);\s*$/)}
${block(/^\s*const buildGroup = /, /^\s{6}\};\s*$/)}
${block(/^\s*const defaultServices = /, /^\s{6}\}\);\s*$/)}
${block(/^\s*const makeWorkloadCluster = /, /^\s{6}\}\);\s*$/)}
${block(/^\s*const makeManagementCluster = /, /^\s{6}\}\);\s*$/)}
${one(/^\s*const num = \(x, fallback/)}
${block(/^\s*const computePlatformOverhead = /, /^\s{6}\};\s*$/)}
${block(/^\s*const migrateState = /, /^\s{6}\};\s*$/)}
${block(/^\s*function isValidConfig\(/, /^\s{6}\}\s*$/)}
module.exports = { migrateState, isValidConfig, defaultVirt, computePlatformOverhead, HYPERVISORS };
`;
const tmp = path.join(os.tmpdir(), `mig-${process.pid}.js`);
fs.writeFileSync(tmp, mod);
const { migrateState, isValidConfig, defaultVirt, computePlatformOverhead } = require(tmp);
fs.unlinkSync(tmp);

let fails = 0;
const is = (n, c) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) fails++; };

const grp = (nodes) => ({ enabled: true, custom: true, faultTolerance: 0, nodes });
const n = (cpu, ram, storage, gpus = 0) => ({ id: 'x', cpu, ram, storage, gpus });
const svc = {};

console.log('--- A v2.4.0 export (fleet shape, no platform key) ---');
const v24 = {
  nodeProfiles: [], selectedClusterId: 'c1',
  clusters: [{ id: 'c1', name: 'AI', role: 'workload', enabled: true, services: svc, customApps: [],
               base: { controlPlane: grp([n(4, 8, 100)]), gpuWorkerNodes: grp([]), generalWorkerNodes: grp([]) } }],
  virtualization: {
    mode: 'auto', hosts: [{ id: 'h1', name: 'H', count: 1, primary: true, sockets: 2, coresPerSocket: 24,
                            threadsPerCore: 2, ram: 512, storage: 7680, gpus: 1, reserveRam: 0, reserveThreads: 0 }],
    overcommit: { vcpu: 4, ram: 1.2 }, cluster: { maxVmsPerNode: 40, faultTolerance: 2, replication: 3, decidedNodes: 0 },
    storage: { external: false, connection: 'iscsi', capacityNote: '' }, dr: { sites: 1, note: '' }, customVms: [],
  },
};
is('isValidConfig accepts it', isValidConfig(JSON.parse(JSON.stringify(v24))));
const m24 = migrateState(JSON.parse(JSON.stringify(v24)));
is('platform migrates to none (numbers unchanged)', m24.virtualization.platform === 'none');
is('overhead object is created', !!m24.virtualization.overhead && typeof m24.virtualization.overhead === 'object');
is('overcommit preserved exactly', m24.virtualization.overcommit.vcpu === 4 && m24.virtualization.overcommit.ram === 1.2);
is('cluster policy preserved', m24.virtualization.cluster.faultTolerance === 2 && m24.virtualization.cluster.replication === 3);
is('host preserved', m24.virtualization.hosts[0].ram === 512 && m24.virtualization.hosts[0].coresPerSocket === 24);

console.log('\n--- A brand-new config defaults to Harvester ---');
is('defaultVirt() is harvester', defaultVirt().platform === 'harvester');
is('defaultVirt() has an overhead object', defaultVirt().overhead.auto === true);

console.log('\n--- Pre-2.3 single-cluster shape (base + services, no clusters[]) ---');
const v22 = { base: { controlPlane: grp([n(4, 8, 100)]), gpuWorkerNodes: grp([]), generalWorkerNodes: grp([]) },
              services: svc, customApps: [] };
is('isValidConfig accepts it', isValidConfig(JSON.parse(JSON.stringify(v22))));
const m22 = migrateState(JSON.parse(JSON.stringify(v22)));
is('upgraded to fleet shape', Array.isArray(m22.clusters) && m22.clusters.length >= 1);
is('platform is none', m22.virtualization.platform === 'none');

console.log('\n--- Pre-2.1 single-host shape (virtualization.host object) ---');
const v20 = { ...JSON.parse(JSON.stringify(v22)),
              virtualization: { host: { sockets: 2, coresPerSocket: 16, threadsPerCore: 2, ram: 256, storage: 4000, gpus: 0 } } };
const m20 = migrateState(JSON.parse(JSON.stringify(v20)));
is('single host wrapped into hosts[]', Array.isArray(m20.virtualization.hosts) && m20.virtualization.hosts.length === 1);
is('host values carried over', m20.virtualization.hosts[0].coresPerSocket === 16 && m20.virtualization.hosts[0].ram === 256);
is('exactly one primary host', m20.virtualization.hosts.filter(h => h.primary).length === 1);
is('platform is none', m20.virtualization.platform === 'none');

console.log('\n--- Malformed / hostile overhead objects ---');
for (const bad of [null, undefined, {}, 'nope', 42, [], { auto: false }, { addons: null }, { overrides: 'x' }]) {
  const s = JSON.parse(JSON.stringify(v24));
  s.virtualization.overhead = bad;
  const m = migrateState(s);
  const ov = m.virtualization.overhead;
  is(`overhead=${JSON.stringify(bad)} -> usable object`,
     !!ov && typeof ov === 'object' && typeof ov.addons === 'object' && ov.addons !== null
     && typeof ov.overrides === 'object' && ov.overrides !== null);
}

console.log('\n--- Unknown / hostile platform keys fall back safely ---');
for (const bad of ['bogus', '', null, 42, {}, '__proto__', 'constructor']) {
  const s = JSON.parse(JSON.stringify(v24));
  s.virtualization.platform = bad;
  is(`platform=${JSON.stringify(bad)} -> none`, migrateState(s).virtualization.platform === 'none');
}

console.log('\n--- A valid platform survives a round trip ---');
const sH = JSON.parse(JSON.stringify(v24));
sH.virtualization.platform = 'harvester';
sH.virtualization.overhead = { auto: true, addons: { lhV2: true }, overrides: { 'agent.cpu': 3 }, dismissed: true };
const mH = migrateState(sH);
is('platform kept', mH.virtualization.platform === 'harvester');
is('addon kept', mH.virtualization.overhead.addons.lhV2 === true);
is('override kept', mH.virtualization.overhead.overrides['agent.cpu'] === 3);
is('partial overhead does not blank addon defaults',
   Object.keys(migrateState({ ...JSON.parse(JSON.stringify(v24)),
     virtualization: { ...v24.virtualization, overhead: { auto: false } } }).virtualization.overhead)
     .includes('addons'));

/* ---- exports from the platform-overhead releases -------------------------
   v2.5.0 introduced virtualization.platform + .overhead. v2.6.0 and v2.7.0 kept
   that shape but changed coefficients, retired scopes (Harvester's infraNode ->
   cluster) and added add-ons (vSAN, Ceph, ODF, Prism scale-out). A saved config
   can therefore carry override and add-on keys that no longer exist. */
console.log('\n--- v2.5.0 / v2.6.0 / v2.7.0 exports ---');
const withVirt = (extra) => {
  const c = JSON.parse(JSON.stringify(v24));
  c.virtualization = { ...c.virtualization, ...extra };
  return c;
};

for (const plat of ['harvester', 'ocpvirt', 'vsphere', 'ahv', 'proxmox', 'none']) {
  const m = migrateState(withVirt({ platform: plat,
    overhead: { auto: true, addons: {}, overrides: {}, dismissed: true } }));
  is(`v2.5.0+ export with platform="${plat}" keeps its platform`, m.virtualization.platform === plat);
}

// v2.5.0 Harvester overrides referenced an infraNode scope that v2.6.0 retired,
// and add-ons that may since have been renamed. Stale keys must be inert, not fatal.
{
  const stale = migrateState(withVirt({ platform: 'harvester', overhead: { auto: true,
    addons: { monitoring: true, logging: false, retiredAddon: true },
    overrides: { 'infra.etcd.cpu': 3, 'infra.hvctl.ram': 9, 'agent.cpu': 2, 'gone.away': 5 } } }));
  is('stale override keys survive the migration without error',
     stale.virtualization.overhead.overrides['infra.etcd.cpu'] === 3);
  is('live override keys are preserved', stale.virtualization.overhead.overrides['agent.cpu'] === 2);
  is('unknown add-on keys are preserved (harmless, and may return)',
     stale.virtualization.overhead.addons.retiredAddon === true);
  // The real test: the sizing engine must tolerate them.
  const oh = computePlatformOverhead('harvester', stale.virtualization.overhead, {
    nodeCount: 5, hostThreads: 96, hostRam: 512, hostStorage: 7680,
    vmCount: 100, vmRam: 1600, vmVcpu: 400, devices: 0, replicas: 3, externalStorage: false });
  is('a stale-key config still computes finite overhead',
     [oh.uniformCpu, oh.uniformRam, oh.lumpCpu, oh.lumpRam, oh.clusterCpu, oh.clusterRam]
       .every(Number.isFinite));
  is('the live override still applies', Math.abs(oh.lines.find(l => l.key === 'agent').cpu - 2) < 1e-9);
}

// v2.7.0 added add-ons that default ON. A saved config that predates them has no
// entry, so the default applies — which is intended, and must not produce NaN.
for (const [plat, addon] of [['vsphere', 'vsan'], ['proxmox', 'ceph'], ['ocpvirt', 'odf']]) {
  const old = migrateState(withVirt({ platform: plat,
    overhead: { auto: true, addons: {}, overrides: {} } }));
  const oh = computePlatformOverhead(plat, old.virtualization.overhead, {
    nodeCount: 5, hostThreads: 96, hostRam: 512, hostStorage: 7680,
    vmCount: 100, vmRam: 1600, vmVcpu: 400, devices: 0, replicas: 3, externalStorage: false });
  is(`${plat}: pre-v2.7.0 export picks up the new ${addon} default cleanly`,
     oh.lines.some(l => l.key === `addon.${addon}`) && Number.isFinite(oh.uniformRam));
}

console.log('\n--- round trip: export -> import -> identical sizing ---');
/* The export button writes JSON.stringify(state) verbatim, so a round trip must
   be a fixed point. If it is not, a customer who saves and reloads gets a
   different answer than the one they signed off. */
{
  for (const plat of ['harvester', 'vsphere', 'proxmox', 'ahv', 'ocpvirt', 'none']) {
    const cfg = migrateState(withVirt({ platform: plat,
      overhead: { auto: true, addons: { monitoring: false }, overrides: { 'agent.cpu': 1.5 } } }));
    const exported = JSON.parse(JSON.stringify(cfg));      // what the file contains
    is(`${plat}: import(export(x)) === x`,
       isValidConfig(exported) &&
       JSON.stringify(migrateState(exported)) === JSON.stringify(cfg));
  }
}

console.log('\n--- migrateState is idempotent ---');
is('running twice is stable', JSON.stringify(migrateState(migrateState(JSON.parse(JSON.stringify(v24)))))
   === JSON.stringify(migrateState(JSON.parse(JSON.stringify(v24)))));

console.log('\n--- isValidConfig was NOT tightened ---');
is('rejects junk', !isValidConfig(null) && !isValidConfig({}) && !isValidConfig({ foo: 1 }));
is('accepts fleet shape with nothing else', isValidConfig({ clusters: [] }));
is('accepts pre-2.3 shape with nothing else', isValidConfig({ base: {}, services: {} }));
is('does NOT require a platform key', isValidConfig({ clusters: [] }));
is('does NOT require a version field', isValidConfig({ clusters: [] }));

console.log(`\n${fails === 0 ? 'ALL MIGRATION CHECKS PASSED' : fails + ' CHECK(S) FAILED'}`);
process.exit(fails === 0 ? 0 : 1);
