/* The capture scripts run against other people's production clusters, so the
   two properties that matter are enforced here rather than promised in a
   comment: they only read, and what they emit is something validate.js can
   score. The kubectl one is exercised end to end against recorded fixtures. */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = path.join(__dirname, 'measurements');
const CAP = path.join(DIR, 'capture');
const FIX = path.join(CAP, 'fixtures');

let fails = 0;
const is = (n, c) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) fails++; };

const scripts = fs.readdirSync(CAP).filter(f => f.endsWith('.sh'));
is(`capture scripts present (${scripts.length})`, scripts.length >= 4);

console.log('\n--- Read-only: no script may mutate a customer cluster ---');
/* Deliberately broad. A false positive costs a comment reword; a false
   negative means shipping a script that changes production. Word-boundary
   matched so "get.summary" and "vm.list" do not trip the vm.* rules. */
const FORBIDDEN = [
  /\bkubectl\s+(apply|create|delete|patch|edit|replace|scale|drain|cordon|annotate|label|exec)\b/,
  /\boc\s+(apply|create|delete|patch|edit|replace|scale|adm|rsh|exec)\b/,
  /\bpvesh\s+(set|create|delete|put|post)\b/,
  /\bqm\s+(set|start|stop|shutdown|destroy|migrate|reset|suspend)\b/,
  /\bpct\s+(set|start|stop|destroy)\b/,
  /\bvim-cmd\s+\S*(power|destroy|createdummyvm|reload|unregister)/,
  /\besxcli\s+[^|\n]*\bset\b/,
  /\bacli\s+\S*\.(create|update|delete|on|off|migrate|clone)\b/,
  /\bncli\s+\S*\s+(add|edit|remove|delete|create)\b/,
  /\b(virsh|systemctl)\s+(start|stop|destroy|restart|set\S*|shutdown|suspend)\b/,
  /\brm\s+-|>\s*\/(etc|var|usr)\//,
];
for (const f of scripts) {
  const body = fs.readFileSync(path.join(CAP, f), 'utf8');
  const hit = FORBIDDEN.find(re => re.test(body));
  is(`${f}: no mutating command${hit ? ` — matched ${hit}` : ''}`, !hit);
  is(`${f}: declares itself read-only in the header`, /READ-ONLY/.test(body));
  is(`${f}: anonymizes by default`, /ANON=1/.test(body) && /--names/.test(body));
  // shellcheck-lite: the shell must at least parse.
  try {
    execFileSync(body.startsWith('#!/usr/bin/env sh') ? 'sh' : 'bash',
                 ['-n', path.join(CAP, f)], { stdio: 'pipe' });
    is(`${f}: parses`, true);
  } catch (e) { is(`${f}: parses — ${String(e.stderr || e).slice(0, 120)}`, false); }
}

console.log('\n--- capture-kubevirt.sh against recorded cluster JSON ---');
let cap = null;
try {
  const out = execFileSync(path.join(CAP, 'capture-kubevirt.sh'), [], {
    env: { ...process.env, CAPTURE_FIXTURES: FIX, CAPTURE_PLATFORM: 'harvester' },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  cap = JSON.parse(out);
  is('produces parseable JSON', true);
} catch (e) {
  is(`produces parseable JSON — ${String(e.stderr || e.message).slice(0, 200)}`, false);
}

if (cap) {
  const term = (k) => cap.terms.find(t => t.key === k || t.modelKey === k);
  // The fixture is the real v1.8.1 lab: 24-thread and 32-thread nodes.
  is('picks the BIGGEST node as reference, not the first',
     term('kubelet').node === cap.nodes.find(n => n.threads === 32).name);
  is('kubelet reserve = capacity - allocatable (32 thr node: 1100m)',
     Math.abs(term('kubelet').cpuThreads - 1.1) < 1e-9);
  is('Harvester reserves no kubelet memory, and the capture shows it',
     term('kubelet').ramGiB === 0);
  const ds = cap.terms.filter(t => t.scope === 'per-node' && t.basis === 'request');
  is('DaemonSets are per-node', ds.length === 2);
  is('  Longhorn instance-manager captured at 3.708 thr on the 32-thread node',
     ds.some(t => Math.abs(t.cpuThreads - 3.708) < 1e-9));
  /* An init container runs before the others, so the pod reserves
     max(largest init, sum of the rest) — 500m init beats 100m of containers. */
  is('  pod requests use max(init, sum) as the scheduler does',
     ds.some(t => Math.abs(t.cpuThreads - 0.5) < 1e-9 && Math.abs(t.ramGiB - 0.25) < 1e-9));

  const cl = cap.terms.find(t => t.scope === 'cluster');
  is('Deployments and static pods are cluster-scoped, counted once',
     Math.abs(cl.cpuThreads - 2.575) < 1e-9 && Math.abs(cl.ramGiB - 3.935) < 1e-9);
  /* The bug this fixture exists to catch: a virt-launcher pod is owned by a
     VirtualMachineInstance, so the ownerReferences test files it as a cluster
     workload and adds an entire guest to the control-plane figure. */
  is('  virt-launcher pods are NOT counted as platform overhead', cl.ramGiB < 4);
  is('  ... they are measured as VMs instead', cap.vms.length === 1);
  is('per-VM overhead = launcher request - guest request (8702Mi - 8Gi = 510)',
     cap.vms[0].overheadMiB === 510);
  is('names are replaced by default', cap.anonymized === true &&
     cap.nodes.every(n => /^node-\d+$/.test(n.name)) &&
     cap.vms.every(v => /^vm-\d+$/.test(v.name)));

  console.log('\n--- the captured file validates and scores ---');
  const tmp = path.join(require('os').tmpdir(), 'capture-selftest.json');
  fs.writeFileSync(tmp, JSON.stringify(cap));
  try {
    const rep = execFileSync('node', [path.join(DIR, 'validate.js'), tmp], { encoding: 'utf8' });
    is('validate.js accepts what capture emits', /well-formed/.test(rep));
    is('  ... and scores the kubelet term against the model', /kubelet CPU/.test(rep));
  } catch (e) { is(`validate.js accepts what capture emits — ${String(e.stdout || e).slice(-300)}`, false); }
}

console.log('\n--- validate.js on the worked example ---');
try {
  const rep = execFileSync('node',
    [path.join(DIR, 'validate.js'), path.join(DIR, 'example-harvester-v1.8.1.json'), '--strict'],
    { encoding: 'utf8' });
  is('the v1.8.1 lab still validates', /well-formed/.test(rep));
  // Every term in that file is one the model was calibrated against, so a
  // disagreement means a coefficient moved without the doc trail moving.
  is('  and the model still agrees with it within 20% on every term',
     /agrees with this cluster/.test(rep));
  const worst = +(rep.match(/Worst per-VM error: (-?[\d.]+)%/) || [])[1];
  is(`  worst per-VM error stays under 1% (${worst}%)`, Math.abs(worst) < 1);
} catch (e) {
  is(`the v1.8.1 lab still validates — ${String(e.stdout || e).slice(-400)}`, false);
}

console.log('\n--- validate.js rejects what it should ---');
const bad = (name, mutate) => {
  const o = JSON.parse(fs.readFileSync(path.join(DIR, 'example-harvester-v1.8.1.json'), 'utf8'));
  mutate(o);
  const tmp = path.join(require('os').tmpdir(), `bad-${name}.json`);
  fs.writeFileSync(tmp, JSON.stringify(o));
  try { execFileSync('node', [path.join(DIR, 'validate.js'), tmp], { encoding: 'utf8', stdio: 'pipe' });
        return false; } catch { return true; }
};
is('rejects an unknown platform', bad('plat', o => { o.platform = 'kvm'; }));
is('rejects a wrong schema version', bad('schema', o => { o.schema = 'v0'; }));
is('rejects a VM with no measurement', bad('vm', o => { delete o.vms[0].overheadMiB; }));
/* The basis check is the one that matters most: a "request" figure from a
   platform with no scheduler compares a number against terms denominated
   differently, and the resulting delta looks authoritative. */
is('rejects a scheduler-request figure from a platform that has no scheduler',
   bad('basis', o => { o.platform = 'vsphere'; }));

console.log(`\n${fails === 0 ? 'ALL CAPTURE CHECKS PASSED' : fails + ' CHECK(S) FAILED'}`);
process.exit(fails === 0 ? 0 : 1);
