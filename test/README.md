# Tests

The tool is a single self-contained `index.html` with no build step, so these
tests **extract the real functions out of that file** and run them under Node
rather than re-implementing them. They cannot silently drift from the code: if a
function is renamed or moved, extraction fails loudly.

```bash
npm install --no-save @babel/core @babel/preset-react puppeteer-core
./test/run.sh                 # everything
./test/run.sh checks e2e      # selected suites

# The browser suite writes screenshots to $TMPDIR by default:
SCREENSHOT_DIR=/tmp/shots ./test/run.sh browser
```

`pdftotext` (poppler-tools) enables the `pdf` suite; without it that suite skips.

| Suite | What it protects |
|---|---|
| `compile` | The `text/babel` block parses. A JSX error would otherwise blank the page at runtime with no build-time warning. |
| `checks` | `computePlatformOverhead` unit tests. **Anchored on the published Harvester worked example: a 16-core node must reserve exactly 1020 mCPU (408 + 612).** Also: the Longhorn 12%-of-allocatable term, per-VM formula, add-on toggles, overrides, and NaN-resistance against malformed input. |
| `benchmark` | **Calibration against a measured cluster** ([the benchmark](https://gist.github.com/Vicente-Cheng/ae8d5ce743f94c0c9a333574813bc777)). Reconstructs its configuration and asserts the model reproduces 8488 m / 5745 Mi at one node, 12 587 Mi at three, the 2.19× request-basis scaling ratio, 421 MiB per-VM, 136 MiB per Longhorn replica, and ~49% physical consumption at max density. Also guards the failure modes directly: the cluster lump must be flat across 1/3/5/7 nodes, and `Pc + Sc` must be counted **once**, not per node. This suite is what would have caught all three v2.5.0 errors. |
| `e2e` | End-to-end `virtSummary`: selecting a platform costs capacity, overcommit is never mutated, the AHV memory rule fires, auto-mode iteration converges, pool mode stays single-pass, the BOM stays raw, and the scenario table is non-linear. |
| `migrate` | **Import compatibility.** Real `isValidConfig` + `migrateState` against a v2.4.0 export, the pre-2.3 single-cluster shape, the pre-2.1 single-host shape, malformed/hostile `overhead` objects and `__proto__`-style platform keys. Asserts `isValidConfig` was not tightened. |
| `docs` | Every coefficient in `HYPERVISORS` carries a source and a tier, and METHODOLOGY.md documents the section's load-bearing claims. A number in code with no citation is a failure. |
| `regression` | A configuration saved before the platform-overhead feature must produce **identical** numbers (it migrates to `platform: 'none'`). Compares against `golden-baseline.json`, captured from the pre-change build. |
| `browser` | Real headless Chrome: the page mounts, the Virtualization tab renders, every platform switches without blanking or emitting `NaN`, and the PDF export path runs. Skipped if Chrome is absent. |
| `import-old` | **Import compatibility, end to end.** Drives the *previous release* (from `git show HEAD:index.html`) in a browser, clicks its own Export button, captures the JSON it actually writes, then feeds that file to the current build's file input — and requires the sizing on screen to be identical. Also imports every file in `fixtures/` into both builds and compares. Skipped if Chrome is absent. |
| `pdf` | Generates the report in-browser, captures the bytes, and reads the **text back with `pdftotext`** — so it asserts on what the customer actually receives: no `NaN`/`undefined`, the platform named, the overhead table with its Verified/Estimate column and source citations, the scenario table, and that the provenance footnote does not collide with the page footer. Needs Chrome and `poppler-tools`. |

## fixtures/

Real exported configurations, used by `import-old`. `customer-pre-2.5-export.json`
is a genuine pre-v2.5.0 export from a live engagement — 5 clusters (management,
observability and three workload), mixed enabled/disabled node groups, custom
VMs and 2 DR sites. It is far better coverage than anything synthetic, and it was
checked for identifying content before being committed (no IPs, hostnames,
emails or URLs; cluster names are generic environment labels).

Drop any additional exported `.json` here and it is picked up automatically.

## golden-baseline.json

Captured from the build **immediately before** the platform-overhead feature, on
a deliberately non-trivial fleet (multiple clusters, two host types, custom VMs,
fault tolerance, replication, two DR sites) across auto, pool and
external-storage modes.

The `regression` suite ignores three fields that v2.5.0 adds to `hostCaps`
(`rawStorage`, `ohCpu`, `ohRam`) — they are additive and carry no meaning under
`platform: 'none'`.

**One deliberate deviation from the pre-change build.** `totals.gpus` in auto
mode used to be `NaN` (serialised as `null`): the code read `hc.gpu` on a raw
host object whose field is `gpus`. That printed literally as `"NaN"` in the PDF's
*Total GPUs* row. It is fixed in v2.5.0 and the baseline was regenerated for that
field only — every other value is byte-identical to the pre-change build.

Regenerate it **only** when a sizing change is intended, and say so in the commit
message; silently re-baselining defeats the point. To capture a baseline from an
older revision:

```bash
git show <rev>:index.html > /tmp/old.html
SIZING_HTML=/tmp/old.html node test/harness.js > test/golden-baseline.json
```
