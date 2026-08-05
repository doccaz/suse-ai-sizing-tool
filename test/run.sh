#!/usr/bin/env bash
# Test suite for the sizing tool. There is no build step and no framework — each
# script extracts the real functions out of index.html and exercises them, so the
# tests cannot drift from the implementation.
#
#   ./test/run.sh          # everything (browser test skipped if Chrome is absent)
#   ./test/run.sh checks   # a single suite
#
# Dependencies (dev only, not needed to use the tool):
#   npm install --no-save @babel/core @babel/preset-react puppeteer-core
set -uo pipefail
cd "$(dirname "$0")"

SUITES=("$@")
if [ ${#SUITES[@]} -eq 0 ]; then
  SUITES=(compile checks benchmark e2e migrate docs capture regression browser pdf import-old)
fi

fails=0
for s in "${SUITES[@]}"; do
  printf '%-11s ' "$s"
  case "$s" in
    regression)
      # A pre-change config must still produce the numbers it always produced.
      if node harness.js > /tmp/golden-now.json 2>/tmp/err.txt && python3 - <<'PY'
import json, sys
def strip(o):
    if isinstance(o, dict):
        return {k: strip(v) for k, v in o.items() if k not in ('rawStorage', 'ohCpu', 'ohRam')}
    if isinstance(o, list): return [strip(x) for x in o]
    return o
a = strip(json.load(open('golden-baseline.json')))
b = strip(json.load(open('/tmp/golden-now.json')))
if a != b:
    def diff(x, y, p=''):
        if isinstance(x, dict):
            for k in x: diff(x[k], y.get(k) if isinstance(y, dict) else None, p + '.' + k)
        elif x != y:
            print(f'  {p}: {x!r} -> {y!r}')
    diff(a, b)
sys.exit(0 if a == b else 1)
PY
      then echo "OK   pre-change configs produce identical numbers"
      else echo "FAILED  sizing output changed for platform:'none'"; fails=$((fails+1)); fi
      ;;
    browser|pdf|import-old)
      if ! { [ -x /usr/bin/google-chrome-stable ] || [ -x /usr/bin/chromium ]; }; then
        echo "SKIP (no Chrome)"
      elif [ "$s" = pdf ] && ! command -v pdftotext >/dev/null; then
        echo "SKIP (no pdftotext — install poppler-tools)"
      elif out=$(timeout 240 node "$s.js" 2>&1); then
        echo "OK   ($(grep -c PASS <<<"$out") assertions)"
      else echo FAILED; grep FAIL <<<"$out" | head -5; fails=$((fails+1)); fi
      ;;
    *)
      if out=$(node "$s.js" 2>&1); then
        echo "OK   ($(grep -c PASS <<<"$out") assertions)"
      else echo FAILED; grep -E 'FAIL|Error' <<<"$out" | head -5; fails=$((fails+1)); fi
      ;;
  esac
done

echo
[ "$fails" -eq 0 ] && echo "ALL SUITES PASSED" || echo "$fails SUITE(S) FAILED"
exit $((fails == 0 ? 0 : 1))
