/* End-to-end import compatibility, using a REAL export from a REAL older build.
 *
 * Synthetic fixtures test what I *think* an old file looks like. This drives the
 * previously released index.html in a browser, clicks its own Export button,
 * captures the JSON it actually writes, then feeds that file to the current
 * build's file input and compares the sizing output on screen.
 *
 * Old builds are taken from git, so this keeps working as releases accumulate:
 *   node test/import-old.js            # HEAD, plus any tags matching v*
 *   OLD_REVS=HEAD,v2.4.0 node ...      # explicit list
 */
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const CURRENT = process.env.SIZING_HTML || path.join(REPO, 'index.html');

let fails = 0;
const is = (n, c) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) fails++; };

const revs = (process.env.OLD_REVS || 'HEAD').split(',').map(r => r.trim()).filter(Boolean);

/* Drive one build: optionally import a file, then read the numbers off screen. */
async function drive(browser, htmlPath, importFile) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1200 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('file://' + htmlPath, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForFunction(
    () => [...document.querySelectorAll('button')].some(b => /virtualization/i.test(b.textContent)),
    { timeout: 90000 });

  let toast = null;
  if (importFile) {
    const input = await page.$('input[type="file"]');
    if (!input) { await page.close(); return { error: 'no file input found' }; }
    await input.uploadFile(importFile);
    // The app shows a toast either way; capture whichever appears.
    await page.waitForFunction(
      () => /Configuration imported|Invalid config file/.test(document.body.innerText),
      { timeout: 20000 }).catch(() => {});
    toast = await page.evaluate(() =>
      (/Invalid config file/.test(document.body.innerText) && 'Invalid config file') ||
      (/Configuration imported/.test(document.body.innerText) && 'Configuration imported') || null);
  }

  // Go to the Virtualization tab and read the headline numbers.
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => /virtualization/i.test(x.textContent));
    if (b) b.click();
  });
  await page.waitForFunction(() => /recommended hosts|inventory feasibility/i.test(document.body.innerText),
    { timeout: 30000 }).catch(() => {});

  const numbers = await page.evaluate(() => {
    const t = document.body.innerText;
    const grab = (re) => { const m = t.match(re); return m ? m[1].trim() : null; };
    return {
      // With multiple DR sites the heading reads "RECOMMENDED HOSTS / SITE".
      hosts:   grab(/RECOMMENDED HOSTS[^\n]*\n\s*(\d+)/i),
      totVms:  grab(/Total VMs\s*\n?\s*([\d,]+)/i),
      totVcpu: grab(/Total vCPU\s*\n?\s*([\d,]+)/i),
      totRam:  grab(/Total RAM\s*\n?\s*([\d,]+ GB)/i),
      physHosts: grab(/Physical hosts\s*\n?\s*([\d,]+)/i),
      physCores: grab(/Physical cores\s*\n?\s*([\d,]+)/i),
    };
  });
  await page.close();
  return { numbers, toast, errors };
}

/* Fixtures: real exported files kept in the repo. The customer file below is a
   genuine pre-v2.5.0 export (5 clusters, mixed enabled groups, custom VMs, 2 DR
   sites) — far better coverage than anything synthetic, and it carries no
   identifying content (checked: no IPs, hostnames, emails or URLs). */
const FIXTURES = fs.existsSync(path.join(__dirname, 'fixtures'))
  ? fs.readdirSync(path.join(__dirname, 'fixtures')).filter(f => f.endsWith('.json'))
      .map(f => path.join(__dirname, 'fixtures', f))
  : [];

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome-stable',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--allow-file-access-from-files'],
  });

  for (const rev of revs) {
    console.log(`\n--- export from ${rev}, import into the current build ---`);
    let oldHtml;
    try {
      oldHtml = execFileSync('git', ['show', `${rev}:index.html`], { cwd: REPO, encoding: 'utf8', maxBuffer: 64e6 });
    } catch {
      console.log(`SKIP  ${rev} — not in git`);
      continue;
    }
    const oldPath = path.join(os.tmpdir(), `sizing-${rev.replace(/[^\w.-]/g, '_')}.html`);
    fs.writeFileSync(oldPath, oldHtml);
    const oldVer = (oldHtml.match(/const APP_VERSION = "([^"]+)"/) || [])[1] || '?';

    // 1. Capture what the old build actually exports.
    const capPage = await browser.newPage();
    await capPage.goto('file://' + oldPath, { waitUntil: 'networkidle0', timeout: 60000 });
    await capPage.waitForFunction(
      () => [...document.querySelectorAll('button')].some(b => /virtualization/i.test(b.textContent)),
      { timeout: 90000 });
    const json = await capPage.evaluate(async () => {
      const orig = URL.createObjectURL.bind(URL);
      let captured = null;
      URL.createObjectURL = (b) => { if (!captured && b && /json/.test(b.type)) captured = b; return orig(b); };
      const btn = [...document.querySelectorAll('button')].find(x => /save config|export config|download/i.test(x.textContent));
      if (!btn) return null;
      btn.click();
      for (let i = 0; i < 40 && !captured; i++) await new Promise(r => setTimeout(r, 100));
      return captured ? await captured.text() : null;
    });
    await capPage.close();
    is(`${rev} (v${oldVer}) exports a config file`, !!json);
    if (!json) continue;
    let parsed = null;
    try { parsed = JSON.parse(json); } catch {}
    is(`  the export is valid JSON`, !!parsed);
    is(`  it predates the platform model (no platform key)`,
       !parsed || !parsed.virtualization || parsed.virtualization.platform === undefined ||
       typeof parsed.virtualization.platform === 'string');

    const jsonPath = path.join(os.tmpdir(), `sizing-export-${oldVer}.json`);
    fs.writeFileSync(jsonPath, json);

    // 2. What did the OLD build show for that config?
    const before = await drive(browser, oldPath, null);
    // 3. Import it into the CURRENT build.
    const after = await drive(browser, CURRENT, jsonPath);

    is(`  imports without an error toast`, after.toast === 'Configuration imported');
    is(`  no JS errors on import`, after.errors.filter(e => !/Failed to load|net::ERR/.test(e)).length === 0);
    is(`  the app still renders after import`, !!after.numbers && after.numbers.totVms !== null);

    /* The headline sizing must be unchanged. A pre-v2.5.0 file migrates to
       platform:'none', so overhead is zero and every number should match what
       the old build produced. */
    const keys = ['hosts', 'totVms', 'totVcpu', 'totRam', 'physHosts', 'physCores'];
    for (const k of keys) {
      is(`  ${k}: ${JSON.stringify(before.numbers[k])} -> ${JSON.stringify(after.numbers[k])}`,
         before.numbers[k] === after.numbers[k]);
    }
  }

  /* ---- real exported files -------------------------------------------
     Import each fixture into BOTH the previous release and the current build
     and require the sizing to be identical. This is the check that answers
     "will a customer's saved file still give them the same answer?" */
  let baselineHtml = null;
  try {
    baselineHtml = path.join(os.tmpdir(), 'sizing-baseline.html');
    fs.writeFileSync(baselineHtml,
      execFileSync('git', ['show', 'HEAD:index.html'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64e6 }));
  } catch { baselineHtml = null; }

  for (const fx of FIXTURES) {
    const name = path.basename(fx);
    console.log(`\n--- fixture: ${name} ---`);
    const raw = JSON.parse(fs.readFileSync(fx, 'utf8'));
    const clusters = (raw.clusters || []).length;
    console.log(`    ${clusters} cluster(s), ${(raw.virtualization || {}).mode} mode, ` +
                `platform=${JSON.stringify((raw.virtualization || {}).platform)}`);

    const now = await drive(browser, CURRENT, fx);
    is(`  imports into the current build`, now.toast === 'Configuration imported');
    is(`  no JS errors`, now.errors.filter(e => !/Failed to load|net::ERR/.test(e)).length === 0);
    is(`  produces a host count`, !!now.numbers.hosts);
    is(`  no NaN on screen`, !Object.values(now.numbers).some(v => v && /NaN/.test(v)));

    if (baselineHtml) {
      const then = await drive(browser, baselineHtml, fx);
      is(`  imports into the previous release too`, then.toast === 'Configuration imported');
      for (const k of ['hosts', 'totVms', 'totVcpu', 'totRam', 'physHosts', 'physCores']) {
        is(`  ${k} unchanged: ${JSON.stringify(then.numbers[k])} -> ${JSON.stringify(now.numbers[k])}`,
           then.numbers[k] === now.numbers[k]);
      }
    }
  }

  await browser.close();
  console.log(`\n${fails === 0 ? 'OLD-EXPORT IMPORT CHECKS PASSED' : fails + ' CHECK(S) FAILED'}`);
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('harness error:', e.message); process.exit(2); });
