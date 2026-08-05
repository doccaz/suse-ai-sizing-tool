/* Golden-baseline harness for the Virtualization tab.
   Extracts the REAL virtSummary body (plus the module-level helpers it closes
   over) straight out of index.html and evaluates it against a fixed fixture.
   Run before and after the change; platform:'none' must reproduce the baseline
   byte-for-byte. */
const fs = require('fs');
const path = require('path');

/* argv[2] is only the source when this file IS the program. When it is
   required as a module the caller owns argv — validate.js passes a capture
   file there, and picking that up made the harness try to parse JSON as the
   app. Env var still wins, so callers can point at another build. */
const SRC = process.env.SIZING_HTML ||
            (require.main === module ? process.argv[2] : null) ||
            path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(SRC, 'utf8');

/* ---- slice helpers -------------------------------------------------- */
function block(startRe, endRe) {
  const lines = src.split('\n');
  const s = lines.findIndex(l => startRe.test(l));
  if (s < 0) return null;
  for (let i = s; i < lines.length; i++) {
    if (endRe.test(lines[i]) && i > s) return lines.slice(s, i + 1).join('\n');
  }
  return null;
}
function need(name, re, endRe) {
  const b = block(re, endRe);
  if (!b) throw new Error(`could not extract ${name} from ${SRC}`);
  return b;
}

const baseOrder    = need('baseOrder',    /^\s*const baseOrder =/,          /;\s*$/);
const effNodes     = need('effNodes',     /^\s*const effNodes = \(g\) => \{/, /^\s{6}\};\s*$/);
const line1        = (re) => (src.split('\n').find(l => re.test(l)) || '');
// Optional: only present after the change.
const hvDocs       = line1(/^\s*const HARVESTER_DOCS =/);
const vcsaTbl      = block(/^\s*const VCSA_SIZES = \[/,                     /^\s{6}\];\s*$/) || '';
const vcsaFn       = block(/^\s*const vcsaSize = /,                          /VCSA_SIZES\.length - 1\];\s*$/) || '';
const ohSrc        = block(/^\s*const OVERHEAD_SRC = \{/,                   /^\s{6}\};\s*$/) || '';
const maxPods      = line1(/^\s*const HARVESTER_MAX_PODS =/);
const gkeFn        = block(/^\s*const gkeReservedCpu = /,                   /^\s{6}\};\s*$/) || '';
const hvKubelet    = line1(/^\s*const harvesterKubeletCpu = /);
// OpenShift's node auto-sizing reserve (added with the OCP-V control-plane split).
const ocpCpuFn     = block(/^\s*const openshiftReservedCpu = /,             /^\s{6}\};\s*$/) || '';
const ocpRamFn     = block(/^\s*const openshiftReservedRam = /,             /^\s{6}\};\s*$/) || '';
const hypervisors  = block(/^\s*const HYPERVISORS = \{/,                    /^\s{6}\};\s*$/) || '';
// UI prose that names platform components — asserted in step with HYPERVISORS.
const platWords    = block(/^\s*const PLATFORM_WORDS = \{/,                 /^\s{6}\};\s*$/) || '';
const hvKey        = block(/^\s*const hypervisorKey = /, /'none';\s*$/) || '';
const schemaFn     = block(/^\s*const overrideSchema = \(P\) => \{/,      /^\s{6}\};\s*$/) || '';
const numFn        = line1(/^\s*const num = \(x, fallback/);
const overheadFn   = block(/^\s*const computePlatformOverhead = /,          /^\s{6}\};\s*$/) || '';

// virtSummary: strip the useMemo wrapper, keep the body verbatim.
const vsRaw = need('virtSummary', /^\s*const virtSummary = useMemo\(\(\) => \{/, /^\s{8}\}, \[state\]\);\s*$/);
const vsBody = vsRaw
  .replace(/^\s*const virtSummary = useMemo\(\(\) => \{/, '')
  .replace(/\}, \[state\]\);\s*$/, '');

const mod = `
${baseOrder}
${effNodes}
${hvDocs}
${ohSrc}
${vcsaTbl}
${vcsaFn}
${maxPods}
${gkeFn}
${hvKubelet}
${ocpCpuFn}
${ocpRamFn}
${hypervisors}
${platWords}
${hvKey}
${schemaFn}
${numFn}
${overheadFn}
function virtSummary(state) {
${vsBody}
}
module.exports = { virtSummary,
  gkeReservedCpu:      typeof gkeReservedCpu      !== 'undefined' ? gkeReservedCpu      : null,
  harvesterKubeletCpu: typeof harvesterKubeletCpu !== 'undefined' ? harvesterKubeletCpu : null,
  openshiftReservedCpu: typeof openshiftReservedCpu !== 'undefined' ? openshiftReservedCpu : null,
  openshiftReservedRam: typeof openshiftReservedRam !== 'undefined' ? openshiftReservedRam : null,
  computePlatformOverhead: typeof computePlatformOverhead !== 'undefined' ? computePlatformOverhead : null,
  HYPERVISORS:         typeof HYPERVISORS         !== 'undefined' ? HYPERVISORS         : null,
  PLATFORM_WORDS:      typeof PLATFORM_WORDS      !== 'undefined' ? PLATFORM_WORDS      : null,
  overrideSchema:      typeof overrideSchema      !== 'undefined' ? overrideSchema      : null };
`;

const tmp = path.join(require('os').tmpdir(), `vs-harness-${process.pid}.js`);
fs.writeFileSync(tmp, mod);
const api = require(tmp);
const { virtSummary } = api;
fs.unlinkSync(tmp);
module.exports = api;

/* ---- fixture: a deliberately non-trivial fleet ----------------------- */
const grp = (nodes, ft = 0, enabled = true) => ({ enabled, custom: true, faultTolerance: ft, nodes });
const n = (cpu, ram, storage, gpus = 0) => ({ id: `n${cpu}${ram}${storage}${gpus}`, cpu, ram, storage, gpus });

const fixture = {
  clusters: [
    { id: 'c1', name: 'Rancher Mgmt', role: 'management', enabled: true,
      base: { controlPlane: grp([n(4,16,100), n(4,16,100), n(4,16,100)], 1),
              gpuWorkerNodes: grp([], 0, false),
              generalWorkerNodes: grp([], 0, false) } },
    { id: 'c2', name: 'SUSE AI #1', role: 'workload', enabled: true,
      base: { controlPlane: grp([n(4,8,100), n(4,8,100), n(4,8,100)]),
              gpuWorkerNodes: grp([n(16,32,250,1), n(16,32,250,1)], 1),
              generalWorkerNodes: grp([n(8,32,200), n(8,32,200), n(8,32,200)], 1) } },
    { id: 'c3', name: 'Disabled', role: 'workload', enabled: false,
      base: { controlPlane: grp([n(99,99,999)]), gpuWorkerNodes: grp([]), generalWorkerNodes: grp([]) } },
  ],
  virtualization: {
    mode: 'auto',
    hosts: [
      { id: 'h1', name: 'Host Type 1', count: 1, primary: true,  sockets: 2, coresPerSocket: 24, threadsPerCore: 2, ram: 512, storage: 7680, gpus: 1, reserveRam: 0, reserveThreads: 0 },
      { id: 'h2', name: 'Host Type 2', count: 4, primary: false, sockets: 2, coresPerSocket: 16, threadsPerCore: 2, ram: 256, storage: 3840, gpus: 0, reserveRam: 8, reserveThreads: 2 },
    ],
    overcommit: { vcpu: 4, ram: 1.2 },
    cluster: { maxVmsPerNode: 40, faultTolerance: 2, replication: 3, decidedNodes: 0 },
    storage: { external: false, connection: 'iscsi', capacityNote: '' },
    dr: { sites: 2, note: '' },
    customVms: [ { id: 'v1', name: 'Bastion', count: 3, cpu: 2, ram: 4, storage: 50, gpu: 0 } ],
  },
};

/* ---- run both modes, and the external-storage variant ---------------- */
const scenarios = {
  auto:        JSON.parse(JSON.stringify(fixture)),
  pool:        (() => { const f = JSON.parse(JSON.stringify(fixture)); f.virtualization.mode = 'pool'; return f; })(),
  autoExtStor: (() => { const f = JSON.parse(JSON.stringify(fixture)); f.virtualization.storage.external = true; return f; })(),
};

// Only these fields are compared: the numbers a customer reads off the report.
const pick = (r) => ({
  mode: r.mode,
  agg: r.agg, demand: r.demand,
  maxVmThreads: r.maxVmThreads, maxVmRam: r.maxVmRam,
  totals: r.totals, externalStorageNeeded: r.externalStorageNeeded,
  checks: r.checks.map(c => `${c.ok ? 'PASS' : 'FAIL'} ${c.label}`),
  hostCaps: r.hostCaps,
  min: r.min, minNodes: r.minNodes, requiredNodes: r.requiredNodes, decided: r.decided,
  failDenom: r.failDenom, normal: r.normal, failure: r.failure, util: r.util,
  totalHosts: r.totalHosts, cap: r.cap, checksPool: r.checksPool, feasible: r.feasible,
});

module.exports.scenarios = scenarios;
module.exports.pick = pick;

if (require.main === module) {
  const out = {};
  for (const [name, st] of Object.entries(scenarios)) {
    // platform:'none' is what an imported pre-change config migrates to.
    if (process.env.PLATFORM) st.virtualization.platform = process.env.PLATFORM;
    out[name] = pick(virtSummary(st));
  }
  console.log(JSON.stringify(out, null, 2));
}
