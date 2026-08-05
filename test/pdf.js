/* The PDF is the artifact that reaches the customer, so inspect its text rather
   than just proving the button does not throw. Extracts the raw text streams
   from the generated PDF and asserts on their content. */
const puppeteer = require('puppeteer-core');
const path = require('path');
const zlib = require('zlib');

const URL = 'file://' + (process.env.SIZING_HTML || path.join(__dirname, '..', 'index.html'));

/* Lint first: jsPDF's standard fonts are WinAnsi (CP1252) encoded. Any character
   outside that set renders as garbage in the report AND corrupts the letter
   spacing of the whole cell — which is exactly how an arrow slipped through. */
{
  const src = require('fs').readFileSync(
    process.env.SIZING_HTML || path.join(__dirname, '..', 'index.html'), 'utf8');
  const from = src.indexOf('function generatePdfReport');
  const region = src.slice(from);
  const offenders = new Map();
  for (let i = 0; i < region.length; i++) {
    const ch = region[i];
    if (ch.charCodeAt(0) < 128) continue;
    let ok = true;
    try { Buffer.from(ch, 'latin1').toString('latin1'); ok = /[\u00A0-\u00FF\u20AC\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178]/.test(ch); }
    catch { ok = false; }
    if (!ok) offenders.set(ch, (offenders.get(ch) || 0) + 1);
  }
  const list = [...offenders.keys()].map(c => `${c} (U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')})`);
  console.log(`${offenders.size === 0 ? 'PASS' : 'FAIL'}  PDF strings are WinAnsi-safe` +
              (offenders.size ? ` — found ${list.join(', ')}` : ''));
  if (offenders.size) process.exitCode = 1;
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome-stable',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--allow-file-access-from-files'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1200 });
  await page.goto(URL, { waitUntil: 'networkidle0', timeout: 60000 });
  await new Promise(r => setTimeout(r, 2500));

  let fails = 0;
  const is = (n, c) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) fails++; };

  /* Capture the PDF blob where it is created. jsPDF's save() builds its own
     anchor and fires dispatchEvent (not .click()), so hooking the anchor is
     unreliable; createObjectURL is the one chokepoint every path goes through. */
  await page.evaluate(() => {
    const orig = URL.createObjectURL.bind(URL);
    window.__pdfB64 = null;
    URL.createObjectURL = (b) => {
      if (b && b.type === 'application/pdf' && !window.__pdfB64) {
        b.arrayBuffer().then(buf => {
          let s = ''; const u8 = new Uint8Array(buf);
          for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
          window.__pdfB64 = btoa(s);
        });
      }
      return orig(b);
    };
    window.__hooked = true;
  });
  is('blob hook installed', await page.evaluate(() => !!window.__hooked));

  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(x => /pdf|report/i.test(x.textContent));
    btn.click();
  });
  await page.waitForFunction(() => !!window.__pdfB64, { timeout: 120000 }).catch(() => {});
  const b64 = await page.evaluate(() => window.__pdfB64);

  is('PDF was generated', !!b64);
  if (!b64) { await browser.close(); process.exit(1); }

  const pdf = Buffer.from(b64, 'base64');
  const pdfPath = '/tmp/sizing-report.pdf';
  require('fs').writeFileSync(pdfPath, pdf);
  is('PDF is well-formed', pdf.slice(0, 5).toString() === '%PDF-');

  /* Use pdftotext rather than hand-parsing: it handles compressed streams,
     font encodings and text ordering correctly. */
  let text = '';
  try {
    text = require('child_process')
      .execFileSync('pdftotext', ['-layout', pdfPath, '-'], { encoding: 'utf8', maxBuffer: 64e6 });
  } catch (e) {
    console.log('  pdftotext unavailable or failed:', e.message.split('\n')[0]);
    console.log('  SKIPPING content assertions (install poppler-tools to enable)');
    await browser.close();
    process.exit(fails === 0 ? 0 : 1);
  }
  require('fs').writeFileSync('/tmp/pdf-text.txt', text);
  is('PDF text extracted', text.length > 500);

  is('no "NaN" anywhere in the report', !/NaN/.test(text));
  is('no "undefined" anywhere in the report', !/undefined/.test(text));
  is('platform is named', /SUSE Virtualization \(Harvester\)/.test(text));
  is('overhead table rendered', /Platform overhead/i.test(text));
  is('Longhorn line present', /Longhorn instance-manager/i.test(text));
  is('provenance column populated', /Verified/.test(text) && /Estimate/.test(text));
  is('provenance footnote present', /no kubelet memory reservation/i.test(text.replace(/\s+/g, ' ')));
  /* Sources are cited by number in the table and listed once underneath —
     printing URLs inline repeated the same link on a dozen rows. */
  is('a numbered Sources list is printed', /Sources/.test(text) && /\[1\]/.test(text));
  is('the list contains the actual citations', /docs\.harvesterhci\.io/.test(text) && /cos\.go/.test(text));
  is('the benchmark is cited', /gist\.github\.com/.test(text));
  const flatT = text.replace(/\s+/g, ' ');
  // Every [n] used in the table must exist in the list, and vice versa.
  const listed = [...flatT.matchAll(/\[(\d+)\]\s+\S+/g)].map(m => +m[1]);
  is(`Sources list is contiguous from [1] (${listed.length} entries)`,
     listed.length > 0 && listed.every((n, i) => n === i + 1));
  is('no raw URL is repeated more than twice in the body',
     (flatT.match(/gist\.github\.com/g) || []).length <= 2);
  // pdftotext wraps lines, so match tolerantly across whitespace.
  const flat = text.replace(/\s+/g, ' ');
  is('overcommit-not-altered note present', /never altered by the platform selection/i.test(flat));
  is('model-completeness statement present', /model completeness/i.test(flat));
  is('  Harvester report states it is calibrated', /calibrated against measurements/i.test(flat));
  is('scenario table rendered', /Overhead by cluster size/i.test(text));
  is('the current-design row is marked legibly', /\(this design\)/.test(text));
  // Garbage glyphs show up as runs of single letters separated by spaces.
  is('no mangled letter-spacing in the scenario table',
     !/\bn o d e\b|\bV M\b|\bt h i s\b/.test(text));
  is('Total GPUs row is a number', /Total GPUs/.test(text));
  // The footnote must not run into the page footer.
  is('provenance footnote does not collide with the footer',
     !/platform\s*\n?\s*Generated/i.test(text) && !/Generated\s+\d.*derivations/i.test(text));

  /* Second pass on a NON-Kubernetes platform. The provenance footnote used to
     assert the Kubernetes basis, a lower-bound direction and Harvester's
     no-kubelet-memory quirk for every platform alike — all three are false on
     ESXi, and the customer reads this page. */
  {
    // The platform selector only exists on the Virtualization tab.
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find(x => /virtualization/i.test(x.textContent));
      if (b) b.click();
    });
    await page.waitForFunction(
      () => /virtualization platform/i.test(document.body.innerText), { timeout: 30000 });
    const switched = await page.evaluate(() => {
      window.__pdfB64 = null;
      const sel = [...document.querySelectorAll('select')]
        .find(s => [...s.options].some(o => o.value === 'vsphere'));
      if (!sel) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, 'vsphere'); sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    });
    is('vSphere selectable for the second report', switched);
    await new Promise(r => setTimeout(r, 1500));
    await page.evaluate(() => {
      [...document.querySelectorAll('button')].find(x => /pdf|report/i.test(x.textContent)).click();
    });
    await page.waitForFunction(() => !!window.__pdfB64, { timeout: 120000 }).catch(() => {});
    const b2 = await page.evaluate(() => window.__pdfB64);
    is('vSphere PDF was generated', !!b2);
    if (b2) {
      require('fs').writeFileSync('/tmp/sizing-report-vsphere.pdf', Buffer.from(b2, 'base64'));
      const t2 = require('child_process')
        .execFileSync('pdftotext', ['-layout', '/tmp/sizing-report-vsphere.pdf', '-'],
                      { encoding: 'utf8', maxBuffer: 64e6 })
        .replace(/\s+/g, ' ');
      is('  vSphere report names the platform', /VMware vSphere/i.test(t2));
      is('  ... states a host-consumption basis', /host consumption/i.test(t2));
      is('  ... does not claim a scheduler-request basis',
         !/figures are scheduler requests/i.test(t2));
      is('  ... does not repeat Harvester’s no-kubelet-memory caveat',
         !/no kubelet memory reservation/i.test(t2));
      is('  ... does not claim to be calibrated', !/calibrated against measurements/i.test(t2));
      is('  ... and does not promise the total is a floor', !/lower bound/i.test(t2));
    }
  }

  if (fails) {
    const i = text.search(/NaN|undefined/);
    if (i >= 0) console.log('\ncontext:', JSON.stringify(text.slice(Math.max(0, i - 120), i + 120)));
  }
  await browser.close();
  console.log(`\n${fails === 0 ? 'PDF CHECKS PASSED' : fails + ' CHECK(S) FAILED'}`);
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('harness error:', e.message); process.exit(2); });
