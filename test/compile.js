/* Compile the in-browser text/babel block exactly as the browser would, so a
   JSX or syntax error fails here instead of silently blanking the page. */
const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');

const SRC = process.env.SIZING_HTML || path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(SRC, 'utf8');

const m = html.match(/<script type="text\/babel">([\s\S]*?)<\/script>/);
if (!m) { console.error('no text/babel block found'); process.exit(1); }

// Line offset so reported errors map back to index.html line numbers.
const offset = html.slice(0, m.index).split('\n').length;

try {
  babel.transformSync(m[1], { presets: [require('@babel/preset-react')], filename: 'index.html' });
  console.log(`PASS  text/babel block compiles (${m[1].split('\n').length} lines)`);
} catch (e) {
  const lm = /\((\d+):(\d+)\)/.exec(e.message);
  if (lm) console.error(`FAIL  index.html:${offset + (+lm[1]) - 1}  ${e.message.split('\n')[0]}`);
  else console.error('FAIL ', e.message.split('\n').slice(0, 4).join('\n'));
  process.exit(1);
}
