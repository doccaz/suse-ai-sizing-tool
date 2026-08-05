/* Real browser smoke test: the tool is a single file with CDN React + Babel,
   so "compiles" is not the same as "renders". Drive the actual page. */
const puppeteer = require('puppeteer-core');
const path = require('path');

const URL = 'file://' + (process.env.SIZING_HTML || path.join(__dirname, '..', 'index.html'));
// Screenshots are debugging artifacts, not repo content — keep them out of git.
const OUT = process.env.SCREENSHOT_DIR || require('os').tmpdir();

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome-stable',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--allow-file-access-from-files'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1200 });

  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });

  let fails = 0;
  const is = (n, c) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) fails++; };

  await page.goto(URL, { waitUntil: 'networkidle0', timeout: 60000 });
  /* Babel-standalone compiles in-page. Wait for something only the mounted app
     produces — a body-length threshold is satisfied by the pre-React skeleton,
     which made this suite flaky. The tab bar is the first thing the next step
     needs, so gate on that. */
  await page.waitForFunction(
    () => [...document.querySelectorAll('button')].some(b => /virtualization/i.test(b.textContent)),
    { timeout: 90000 });

  is('page rendered (React mounted)', await page.$eval('body', b => b.innerText.length > 200));
  const ver = require('fs').readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
    .match(/const APP_VERSION = "([^"]+)"/)[1];
  is(`version badge matches APP_VERSION (${ver})`, (await page.content()).includes('v' + ver));

  // Navigate to the Virtualization tab.
  const went = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => /virtualization/i.test(x.textContent));
    if (b) { b.click(); return true; } return false;
  });
  is('Virtualization tab reachable', went);
  await page.waitForFunction(
    () => /virtualization platform/i.test(document.body.innerText), { timeout: 30000 });

  const txt = () => page.$eval('body', b => b.innerText);
  let body = await txt();
  is('platform selector rendered', /virtualization platform/i.test(body));
  is('defaults to Harvester', /SUSE Virtualization \(Harvester\)/.test(body));
  is('overhead breakdown panel rendered', /platform overhead/i.test(body));
  is('scenario table rendered', /overhead by cluster size/i.test(body));
  is('scenario rows present', /3n \/ 50 VM/.test(body) && /5n \/ 100 VM/.test(body));
  is('Longhorn line is itemised', /Longhorn instance-manager/.test(body));
  is('kubelet reserve line is itemised', /Kubelet reserve/.test(body));
  is('provenance badges rendered (all three tiers)',
     ['verified', 'measured', 'estimate'].every(t => body.toLowerCase().includes(t)));
  is('cluster scope is labelled "once per cluster"', /once per cluster/i.test(body));
  is('no stale "first 0 nodes" heading', !/first 0 node/i.test(body));
  is('physical-RAM lines are marked as such', /physical ram only/i.test(body));
  is('the request basis is stated in the UI', /scheduler <?strong>?requests|scheduler requests/i.test(body));
  is('storage-engine line is shown', /storage engine ram/i.test(body));
  is('add-on toggles rendered', /rancher-monitoring/.test(body));
  is('Harvester is shown as a calibrated model', /model: calibrated/i.test(body));
  is('storage-service add-on is offered', /longhorn v2 data engine/i.test(body));
  /* Overhead makes several displayed values fractional; raw JS floats leak as
     e.g. "80.60400000000001" and look broken in a customer-facing tool. */
  const floatNoise = body.match(/\d+\.\d{5,}/g);
  is(`no floating-point noise in the UI${floatNoise ? ' — found ' + floatNoise.slice(0, 3).join(', ') : ''}`,
     !floatNoise);

  await page.screenshot({ path: path.join(OUT, 'virt-harvester.png'), fullPage: true });

  /* Turning the overhead toggle off must remove the panels entirely, not leave
     a table of zeroes behind. */
  const toggled = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')]
      .find(x => /Apply platform overhead automatically/i.test(x.textContent));
    if (b) { b.click(); return true; } return false;
  });
  is('overhead toggle found', toggled);
  await page.waitForFunction(() => !/overhead by cluster size/i.test(document.body.innerText),
    { timeout: 15000 }).catch(() => {});
  const bodyOff = await txt();
  // Match a string unique to the breakdown panel — "platform overhead" also
  // appears in the toggle's own label ("Apply platform overhead automatically").
  is('  overhead breakdown panel disappears', !/per node \(every host\)/i.test(bodyOff));
  is('  scenario table disappears (no all-zero rows)', !/overhead by cluster size/i.test(bodyOff));
  is('  no zeroed overhead rows linger', !/0\.00 thr/.test(bodyOff));
  // Toggle back on for the rest of the run.
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')]
      .find(x => /Apply platform overhead automatically/i.test(x.textContent));
    if (b) b.click();
  });
  await page.waitForFunction(() => /overhead by cluster size/i.test(document.body.innerText),
    { timeout: 15000 }).catch(() => {});
  is('  and comes back when re-enabled', /overhead by cluster size/i.test(await txt()));

  // Expand the overhead-factors disclosure.
  const opened = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => /Show overhead factors/.test(x.textContent));
    if (b) { b.click(); return true; } return false;
  });
  is('overhead factors disclosure opens', opened);
  await page.waitForFunction(
    () => /threads\/node/i.test(document.body.innerText), { timeout: 15000 }).catch(() => {});
  body = await txt();
  is('editable coefficients shown', /threads\/node/.test(body));
  is('formula note shown', /408m \+ 612m = 1020m/.test(body));
  // The panel is generated from overrideSchema(); spot-check the controls that
  // were missing or dead before, including the two biggest levers.
  is('  Longhorn 12% is editable in the panel', /allocatable CPU/i.test(body));
  is('  the KubeVirt overhead ratio is editable', /overhead ratio/i.test(body));
  is('  cluster-scope services are editable', /once per cluster:/i.test(body));
  is('  no dead per-VM controls from the old form', !/× RAM\b/.test(body) || !/MiB\/vCPU/.test(body) === false);
  is('  storage per-TB coefficients are editable',
     /GB\/TB/i.test(body) || !/vsan|ceph|odf/i.test(body));

  // Switch platforms and confirm no crash + overcommit untouched.
  for (const p of ['ahv', 'vsphere', 'proxmox', 'ocpvirt', 'none', 'harvester']) {
    await page.evaluate((val) => {
      const sel = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === val));
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, val);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }, p);
    await page.waitForFunction((val) => {
      const sel = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === val));
      return sel && sel.value === val;
    }, { timeout: 15000 }, p).catch(() => {});
    const b2 = await txt();
    is(`platform "${p}" renders without blanking`, b2.length > 200 && !/NaN/.test(b2));
    // Thin models must say so, or a reader mistakes modelling depth for efficiency.
    if (['vsphere', 'proxmox', 'ahv', 'ocpvirt'].includes(p)) {
      is(`  "${p}" declares its model depth`, /model: modelled/i.test(b2));
    }
    // OCP-V has both a kubelet reserve and cluster singletons — the panel has
    // to say so, because "counted once" is the whole point of the v2.11 split.
    if (p === 'ocpvirt') {
      is('  "ocpvirt" claims its kubelet reserve', /kubelet reserve/i.test(b2));
      is('  "ocpvirt" says cluster services are counted once', /cluster services counted/i.test(b2));
    }
    // Don't describe terms this platform doesn't have.
    if (['vsphere', 'proxmox', 'ahv'].includes(p)) {
      is(`  "${p}" does not claim a control-plane or kubelet term it lacks`,
         !/control-plane extra on the first/i.test(b2) && !/kubelet reserve/i.test(b2));
      // "Pods" and "scheduler requests" are Kubernetes-only. These platforms
      // have neither, and the panel used to say both regardless of platform.
      is(`  "${p}" does not describe its overhead in Kubernetes terms`,
         !/platform pods/i.test(b2) && !/scheduler requests/i.test(b2));
      is(`  "${p}" says its figures are host consumption instead`,
         /host consumption/i.test(b2));
    }
    if (['harvester', 'ocpvirt'].includes(p)) {
      is(`  "${p}" still describes requests and pods`,
         /platform pods/i.test(b2) && /scheduler requests/i.test(b2));
    }
    /* Prose that names a component must name this platform's component. The
       storage sentence and the cluster-services sentence both used to be
       hardcoded to Harvester's stack whatever was selected. */
    if (p !== 'harvester') {
      is(`  "${p}" is not told its storage is Longhorn`,
         !/SUSE Storage \/ Longhorn\) is replicated/i.test(b2));
      is(`  "${p}" is not told its cluster services are Rancher and CDI`,
         !/Cluster services \(Rancher, CDI/i.test(b2));
    }
    const svc = { vsphere: /vCenter Server Appliance\) are/i, ahv: /Prism Central\) are/i,
                  proxmox: /corosync, pve-cluster/i, ocpvirt: /virt-api, virt-controller/i }[p];
    if (svc) is(`  "${p}" names its own cluster services`, svc.test(b2));
  }

  // AHV rule visible.
  await page.evaluate(() => {
    const sel = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'ahv'));
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(sel, 'ahv'); sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(
    () => /cannot overcommit memory/.test(document.body.innerText), { timeout: 15000 }).catch(() => {});
  is('AHV memory-overcommit rule shown', /cannot overcommit memory/.test(await txt()));
  await page.screenshot({ path: path.join(OUT, 'virt-ahv.png'), fullPage: true });

  // Back to Harvester, then generate the PDF to prove that path runs.
  await page.evaluate(() => {
    const sel = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'harvester'));
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(sel, 'harvester'); sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(
    () => /Harvester/.test(document.body.innerText), { timeout: 15000 }).catch(() => {});

  const pdfErr = await page.evaluate(async () => {
    const b = [...document.querySelectorAll('button')].find(x => /pdf|report/i.test(x.textContent));
    if (!b) return 'no PDF button found';
    try { b.click(); } catch (e) { return 'click threw: ' + e.message; }
    return null;
  });
  is('PDF export button found and clicked', pdfErr === null);
  await new Promise(r => setTimeout(r, 6000));

  const fatal = errors.filter(e => !/Failed to load resource|net::ERR|CORS|favicon|Download is not allowed/i.test(e));
  if (fatal.length) { console.log('\nJS errors:'); fatal.forEach(e => console.log('  ' + e)); }
  is('no fatal JS errors', fatal.length === 0);

  await browser.close();
  console.log(`\n${fails === 0 ? 'BROWSER SMOKE TEST PASSED' : fails + ' CHECK(S) FAILED'}`);
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('harness error:', e.message); process.exit(2); });
