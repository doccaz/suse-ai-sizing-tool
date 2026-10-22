/* Export `summary` block (v2.14). Extracts the REAL buildExportSummary from index.html and
   checks that it only re-labels numbers the app already computed: totals must equal
   virtSummary's, nothing may be NaN/undefined, and the block must survive a JSON
   round trip. Also pins the contract the SUSE PoC Planner reads (schema 1). */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { virtSummary, scenarios } = require('./harness.js');

const lines = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8').split('\n');
const grab = (startRe, endRe) => {
  const s = lines.findIndex(l => startRe.test(l));
  if (s < 0) throw new Error('not found: ' + startRe);
  let e = s; while (!endRe.test(lines[e])) e++;
  return lines.slice(s, e + 1).join('\n');
};
const mod = `
const APP_VERSION = '0.0.0-test';
${grab(/^\s*const EXPORT_SUMMARY_SCHEMA = /, /^\s*const EXPORT_SUMMARY_SCHEMA = /)}
${grab(/^\s*function buildExportSummary\(/, /^\s{6}\}\s*$/)}
module.exports = { buildExportSummary, EXPORT_SUMMARY_SCHEMA };
`;
const tmp = path.join(os.tmpdir(), `exp-${process.pid}.js`);
fs.writeFileSync(tmp, mod);
const { buildExportSummary, EXPORT_SUMMARY_SCHEMA } = require(tmp);
fs.unlinkSync(tmp);

let fails = 0;
const is = (n, c) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) fails++; };

const sum = (cpu, ram, storage, gpu) => ({ cpu, ram, storage, gpu });
const fleet = {
  clusterCount: 1,
  capacity: sum(40, 120, 900, 2), demand: sum(30, 90, 500, 1), deltas: sum(10, 30, 400, 1),
  counts: { controlPlane: 3, gpuWorkerNodes: 2, generalWorkerNodes: 3 },
  per: [{ cluster: { name: 'SUSE AI #1', role: 'workload' },
          summary: { capacity: sum(40, 120, 900, 2), demand: sum(30, 90, 500, 1),
                     counts: { controlPlane: 3, gpuWorkerNodes: 2, generalWorkerNodes: 3 } } }],
  serviceDetails: [{ name: 'Milvus', profile: 'Small', cpu: 4, ram: 8, storage: 100, gpu: 0 },
                   { name: 'vLLM', profile: 'GPU', cpu: 8, ram: 32, storage: 50 }],   // gpu omitted on purpose
};

for (const mode of ['auto', 'pool', 'autoExtStor']) {
  const virt = virtSummary(scenarios[mode]);
  const s = buildExportSummary(fleet, virt);
  const v = s.virtualization;
  console.log(`--- ${mode} ---`);
  is('schema is 1', s.schema === 1 && EXPORT_SUMMARY_SCHEMA === 1);
  is('hostsTotal equals virtSummary', v.hostsTotal === virt.totals.totalHosts && v.hostsPerSite === virt.totals.perSiteHosts);
  is('totals equal virtSummary',
     v.totals.cores === virt.totals.cores && v.totals.threads === virt.totals.threads &&
     v.totals.ram === virt.totals.ram && v.totals.storage === virt.totals.storage && v.totals.gpus === virt.totals.gpus);
  is('external storage / FT / replication / sites carried', v.externalStorageNeeded === virt.externalStorageNeeded &&
     v.faultTolerance === virt.ft && v.replication === virt.repl && v.sites === virt.sites);
  is('every design-rule check carried as {label, ok}', v.checks.length === virt.checks.length && v.checks.every(c => typeof c.label === 'string' && typeof c.ok === 'boolean'));
  is('no NaN / undefined / Infinity anywhere', !/NaN|undefined|Infinity/.test(JSON.stringify(s)) && !JSON.stringify(s, (k, x) => (typeof x === 'number' && !isFinite(x)) ? 'BAD' : x).includes('BAD'));
  is('JSON round trip is lossless', JSON.stringify(JSON.parse(JSON.stringify(s))) === JSON.stringify(s));
}

console.log('--- ai ---');
const s = buildExportSummary(fleet, virtSummary(scenarios.auto));
is('fleet capacity/demand/deltas copied', JSON.stringify(s.ai.capacity) === JSON.stringify(fleet.capacity) && JSON.stringify(s.ai.demand) === JSON.stringify(fleet.demand) && JSON.stringify(s.ai.deltas) === JSON.stringify(fleet.deltas));
is('per-cluster rows carry name and role', s.ai.clusters[0].name === 'SUSE AI #1' && s.ai.clusters[0].role === 'workload');
is('services listed with profile and resources', s.ai.services.length === 2 && s.ai.services[0].name === 'Milvus' && s.ai.services[0].profile === 'Small' && s.ai.services[0].ram === 8);
is('service without gpu defaults to 0', s.ai.services[1].gpu === 0);
is('does not alias fleet objects', s.ai.counts !== fleet.counts && s.ai.capacity !== fleet.capacity);

console.log('--- wiring in index.html ---');
const html = lines.join('\n');
is('downloadJson adds summary to the file only', /const out = \{ \.\.\.state, summary: buildExportSummary\(fleet, virtSummary\) \}/.test(html));
is('importJson strips summary before validation/migration', /const \{ summary: _derived, \.\.\.parsed \} = JSON\.parse\(ev\.target\.result\)/.test(html));
is('share link and localStorage still serialise bare state',
   /btoa\(encodeURIComponent\(JSON\.stringify\(state\)\)\)/.test(html) && /localStorage\.setItem\('suse-ai-sizing', JSON\.stringify\(state\)\)/.test(html));

process.exit(fails ? 1 : 0);
