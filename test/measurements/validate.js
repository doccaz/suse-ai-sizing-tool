#!/usr/bin/env node
/* Validate a capture file and score the model against it.
 *
 *   node validate.js mycluster.json          report
 *   node validate.js mycluster.json --strict  exit 1 if any term is out by >20%
 *
 * Two jobs, in order:
 *   1. Schema — is this a well-formed capture? A file that mislabels the BASIS
 *      of a figure is worse than no file, because the delta it produces looks
 *      authoritative and compares a request against a consumption number.
 *   2. Scoring — put the model's prediction next to every measured figure.
 *      This is the point of the exercise. A capture is not data collection.
 *
 * Partial captures are first-class: whatever is absent is reported as not
 * captured, never assumed to be zero. Ten VMs and nothing else is a useful
 * file — on vSphere it is the file that matters most, since the per-VM
 * coefficient there has no vendor arithmetic behind it at all.
 */
const fs = require('fs');
const path = require('path');
const { computePlatformOverhead, HYPERVISORS } = require(path.join(__dirname, '..', 'harness.js'));

const SCHEMA = 'suse-ai-sizing-tool/measurement/v1';
const BASES = ['reserve', 'request', 'physical'];
const SCOPES = ['per-node', 'cluster', 'per-vm'];

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const file = args.find(a => !a.startsWith('--'));
if (!file) {
  console.error('usage: validate.js <capture.json> [--strict]');
  process.exit(2);
}

let cap;
try { cap = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch (e) { console.error(`not readable as JSON: ${e.message}`); process.exit(2); }

let errors = 0, warnings = 0;
const err  = (m) => { console.log(`  ERROR    ${m}`); errors++; };
const warn = (m) => { console.log(`  WARNING  ${m}`); warnings++; };
const num  = (x) => typeof x === 'number' && isFinite(x);

/* ---- 1. schema ------------------------------------------------------- */
console.log(`\n=== Schema: ${path.basename(file)} ===`);
if (cap.schema !== SCHEMA) err(`schema is "${cap.schema}", expected "${SCHEMA}"`);
if (!Object.prototype.hasOwnProperty.call(HYPERVISORS, cap.platform || '') || cap.platform === 'none')
  err(`platform "${cap.platform}" is not one the model knows (${Object.keys(HYPERVISORS).filter(k => k !== 'none').join(', ')})`);
if (!Array.isArray(cap.nodes) || cap.nodes.length === 0) err('nodes[] is required and must be non-empty');

(cap.nodes || []).forEach((n, i) => {
  if (!num(n.threads) || n.threads <= 0) err(`nodes[${i}].threads must be a positive number`);
  if (!num(n.ramGiB)  || n.ramGiB  <= 0) err(`nodes[${i}].ramGiB must be a positive number`);
});

const P = HYPERVISORS[cap.platform] || HYPERVISORS.none;
/* A platform with no kubelet has no scheduler to request from. Accepting a
   "request" figure from ESXi would silently compare it against terms the
   model denominates differently — the exact confusion the UI was fixed for. */
const schedules = !!P.kubeletCpu;
(cap.terms || []).forEach((t, i) => {
  if (!t.key) err(`terms[${i}] has no key`);
  if (!SCOPES.includes(t.scope)) err(`terms[${i}].scope "${t.scope}" not in ${SCOPES.join('|')}`);
  if (!BASES.includes(t.basis))  err(`terms[${i}].basis "${t.basis}" not in ${BASES.join('|')}`);
  if (!num(t.cpuThreads) && !num(t.ramGiB)) err(`terms[${i}] measures neither CPU nor RAM`);
  if (!schedules && (t.basis === 'request' || t.basis === 'reserve'))
    err(`terms[${i}] is basis "${t.basis}", but ${P.label} has no scheduler-request layer — ` +
        'these figures are host consumption and must be basis "physical"');
});

(cap.vms || []).forEach((v, i) => {
  if (!num(v.vcpu) || v.vcpu <= 0) err(`vms[${i}].vcpu must be a positive number`);
  if (!num(v.reqMemGiB) || v.reqMemGiB <= 0) err(`vms[${i}].reqMemGiB must be a positive number`);
  if (!num(v.overheadMiB)) err(`vms[${i}].overheadMiB is the measurement — it is required`);
});

if (cap.anonymized === false) warn('capture is NOT anonymized — it may carry customer node and VM names');
if (cap.anonymized === undefined) warn('capture does not say whether it is anonymized');
if (!cap.versions || !cap.versions.platform)
  warn('no platform version recorded — a coefficient is only valid for the release it came from');
if (!errors) console.log('  OK       well-formed');
if (errors) {
  console.log(`\n${errors} schema error(s) — not scoring a file the model cannot read.`);
  process.exit(1);
}

/* ---- 2. scoring ------------------------------------------------------ */
console.log(`\n=== Model vs measured: ${P.label} ===`);
const nodes = cap.nodes;
/* The reference node must be the one the per-node terms were measured on, or
   they are silently dropped as belonging to some other node. Harvester labels
   every node control-plane, so "first worker" finds nothing there and the old
   fallback to nodes[0] disagreed with the capture's own choice of the largest
   node. Follow the terms first; only guess when they say nothing. */
const namedByTerms = (cap.terms || []).map(t => t.node).find(Boolean);
const biggest = (list) => list.slice().sort((a, b) => b.threads - a.threads)[0];
const ref = nodes.find(n => n.name === namedByTerms)
         || biggest(nodes.filter(n => (n.role || 'worker') === 'worker'))
         || biggest(nodes);
const vms = cap.vms || [];
const totalVcpu = vms.reduce((s, v) => s + v.vcpu, 0);
const totalVmRam = vms.reduce((s, v) => s + v.reqMemGiB, 0);

/* Add-ons change the answer. The v1.8.1 lab ran with neither rancher-monitoring
   nor rancher-logging installed, so scoring it against a model with monitoring
   on compares against 1.05 threads that were never there. A capture that says
   which add-ons exist is scored against the matching configuration. */
const cfg = cap.addons ? { addons: cap.addons } : {};
const model = computePlatformOverhead(cap.platform, cfg, {
  nodeCount: nodes.length,
  hostThreads: ref.threads,
  hostRam: ref.ramGiB,
  hostStorage: (ref.storageTiB || 0) * 1024,
  vmCount: vms.length, vmRam: totalVmRam, vmRamRequested: totalVmRam, vmVcpu: totalVcpu,
  devices: vms.reduce((s, v) => s + (v.vfio || 0), 0),
  gpuVms: vms.filter(v => v.vfio > 0).length,
});

const rows = [];
const pct = (m, got) => (m === 0 && got === 0) ? 0 : (m - got) / (got || m) * 100;
const cmp = (label, modelled, measured, unit) => {
  if (measured === null || measured === undefined) { rows.push([label, fmt(modelled, unit), 'not captured', '']); return; }
  const e = pct(modelled, measured);
  rows.push([label, fmt(modelled, unit), fmt(measured, unit), `${e >= 0 ? '+' : ''}${e.toFixed(1)}%`]);
  if (Math.abs(e) > 20) warn(`${label}: model is ${e.toFixed(0)}% off the measurement`);
};
const fmt = (v, unit) => `${(+v).toFixed(v < 10 ? 3 : 1)}${unit}`;

/* Scoring a scope has two modes, and picking the wrong one manufactures a
   fake delta. A capture that recorded two of the six per-node terms must NOT
   be summed and compared against the model's six — that reads as "the model
   is 66% high" when it means "the capture measured a third of it".
     - term-by-term  when a capture term names a model line (`modelKey`, or a
                     `key` that happens to match). Always safe, always precise.
     - aggregate     only when the capture declares `"complete": true`, i.e.
                     asserts it measured everything in that scope.
   Anything else is reported as partial and left unscored. */
const scoreScope = (scope, label, modelTotalCpu, modelTotalRam) => {
  const terms = (cap.terms || []).filter(t => t.scope === scope
                                         && (scope !== 'per-node' || !t.node || t.node === ref.name));
  if (!terms.length) { rows.push([`${label} terms`, '', 'not captured', '']); return; }

  const byKey = new Map(model.lines.filter(l => l.scope === scope)
                                   .map(l => [l.key.replace(/^cluster\./, ''), l]));
  let matched = 0;
  for (const t of terms) {
    const line = byKey.get(t.modelKey || t.key);
    if (!line) continue;
    matched++;
    if (num(t.cpuThreads)) cmp(`${label} ${t.modelKey || t.key} CPU`, line.cpu, t.cpuThreads, ' thr');
    if (num(t.ramGiB))     cmp(`${label} ${t.modelKey || t.key} RAM`, line.ram, t.ramGiB, ' GiB');
  }

  const complete = terms.some(t => t.complete === true);
  if (complete) {
    cmp(`${label} CPU (all terms)`, modelTotalCpu,
        terms.reduce((s, t) => s + (t.cpuThreads || 0), 0), ' thr');
    cmp(`${label} RAM (all terms)`, modelTotalRam,
        terms.reduce((s, t) => s + (t.ramGiB || 0), 0), ' GiB');
  } else if (matched < terms.length) {
    rows.push([`${label} total`, '', `partial (${terms.length} term(s))`, '']);
    console.log(`  NOTE     ${label}: ${terms.length - matched} term(s) match no model line and the ` +
                'capture does not claim to be complete, so the totals are not compared. ' +
                'Add "modelKey" to map a term, or "complete": true if it really is everything.');
  }
};
// The model's per-node total is uniform*, which already excludes physical lines.
scoreScope('per-node', 'per-node', model.uniformCpu, model.uniformRam);
scoreScope('cluster',  'cluster',  model.clusterCpu, model.clusterRam);

/* Per-VM is scored one VM at a time: it is the term that varies with the
   guest, so an aggregate would hide exactly the shape we want to see. */
let worst = 0, worstVm = '';
if (vms.length) {
  for (const v of vms) {
    const one = computePlatformOverhead(cap.platform, {}, {
      nodeCount: nodes.length, hostThreads: ref.threads, hostRam: ref.ramGiB,
      vmCount: 1, vmRam: v.reqMemGiB, vmRamRequested: v.reqMemGiB, vmVcpu: v.vcpu,
      devices: v.vfio || 0, gpuVms: v.vfio > 0 ? 1 : 0,
    });
    const modelled = one.perVmRam * 1024;                    // GiB -> MiB
    const e = pct(modelled, v.overheadMiB);
    if (Math.abs(e) > Math.abs(worst)) { worst = e; worstVm = v.name; }
    rows.push([`  VM ${v.name} (${v.vcpu} vCPU / ${v.reqMemGiB.toFixed(1)} GiB${v.vfio ? ', VFIO' : ''})`,
               `${modelled.toFixed(0)} MiB`, `${v.overheadMiB} MiB`,
               `${e >= 0 ? '+' : ''}${e.toFixed(2)}%`]);
  }
  if (Math.abs(worst) > 20) warn(`per-VM overhead: worst error ${worst.toFixed(0)}% on ${worstVm}`);
} else {
  rows.push(['per-VM overhead', '', 'not captured', '']);
}

const w = [Math.max(...rows.map(r => r[0].length)), 12, 14, 9];
console.log(`  ${'Term'.padEnd(w[0])}  ${'Model'.padStart(w[1])}  ${'Measured'.padStart(w[2])}  ${'Error'.padStart(w[3])}`);
for (const r of rows) {
  console.log(`  ${r[0].padEnd(w[0])}  ${r[1].padStart(w[1])}  ${r[2].padStart(w[2])}  ${r[3].padStart(w[3])}`);
}

const covered = rows.filter(r => r[2] !== 'not captured').length;
console.log(`\n${covered} term(s) scored, ${warnings} warning(s).`);
if (vms.length) console.log(`Worst per-VM error: ${worst.toFixed(2)}% (${worstVm}).`);
if (!warnings) console.log('The model agrees with this cluster within 20% on every captured term.');
else console.log('Terms flagged above disagree with the model by more than 20% — worth a look before ' +
                 'changing a coefficient: check the platform version and whether the basis matches.');
process.exit(strict && warnings ? 1 : 0);
