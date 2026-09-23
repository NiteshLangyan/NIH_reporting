// One-off/rerunnable converter: llms.txt (markdown) -> aapharmasyn_data.json.
// Parses by heading (## or ###) and preserves every section in document order,
// so the JSON is a faithful structured mirror of llms.txt, not a hand copy.
// Re-run this whenever llms.txt changes: `node scripts/build-aapharmasyn-data.js`.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'llms.txt');
const OUT = path.join(__dirname, '..', 'aapharmasyn_data.json');

const text = fs.readFileSync(SRC, 'utf-8');
const lines = text.split(/\r?\n/);

const sections = [];
let current = null;

for (const line of lines) {
  const match = line.match(/^(#{1,6})\s+(.*)$/);
  if (match) {
    if (current) sections.push(current);
    current = {
      level: match[1].length,
      heading: match[2].trim(),
      content: '',
    };
  } else if (current) {
    current.content += (current.content ? '\n' : '') + line;
  }
  // Lines before the first heading (the top "# AAPharmaSyn" title + intro
  // blockquote) are captured once that first heading is opened, since the
  // title itself becomes the first section below.
}
if (current) sections.push(current);

// Trim trailing blank lines accumulated inside each section's content.
for (const s of sections) {
  s.content = s.content.replace(/\n+$/, '').trim();
}

fs.writeFileSync(OUT, JSON.stringify(sections, null, 2) + '\n', 'utf-8');
console.log(`Wrote ${sections.length} sections to ${path.relative(process.cwd(), OUT)}`);
