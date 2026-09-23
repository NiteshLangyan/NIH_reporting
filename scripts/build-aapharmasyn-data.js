// One-off/rerunnable converter: llms.txt (markdown, the full company file) ->
// aapharmasyn_data.json (only the sections that describe an actual chemistry
// service/capability — the data used for NIH-result fit-matching).
// llms.txt itself is never modified; this only reads it and filters on the
// way out. Re-run whenever llms.txt changes: `node scripts/build-aapharmasyn-data.js`.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'llms.txt');
const OUT = path.join(__dirname, '..', 'aapharmasyn_data.json');

// Sections that are company/HR/legal/link-list content rather than a
// description of a chemistry service AAPharmaSyn can be pitched for —
// matching a NIH project's abstract against "Client Testimonials" or
// "Company Timeline" would produce a nonsense top match, so these are
// dropped from the matching dataset entirely.
const EXCLUDED_HEADINGS = new Set([
  'AAPharmaSyn', // top-level title/intro, not a service description
  'Company Mission & Values',
  'Vision',
  'About AAPharmaSyn (Company Story)',
  'Company Timeline',
  'Explore More About AAPharmaSyn',
  'Additional Services', // pure links to sections already included in detail elsewhere
  'Lab Capabilities', // pure links; "Capabilities Overview Detail" covers the substance
  'Other Services', // pure link list, no substantive content of its own
  'Project & Program Support', // pure links
  'Resources',
  'Current and Legacy Clients',
  'Client Testimonials',
  'Employment',
  'Personnel',
  'Company Culture',
  'Management Team',
  'Operating Philosophy',
  'Core Values',
  'Company & Trust',
  'Partners Detail',
  'Example Partner Needs Addressed',
  'Partner Logos',
  'Resources Page Detail',
  'Publicly Available Information',
  'Government',
  'Patents',
  'Chemistry', // "Resources > Chemistry" link list, not a chemistry-capability description
  'Useful Guides (linked resources)',
  'White Papers Detail',
  'White Papers List (title — publish date)',
  'Key Pages',
]);

const text = fs.readFileSync(SRC, 'utf-8');
const lines = text.split(/\r?\n/);

const allSections = [];
let current = null;

for (const line of lines) {
  const match = line.match(/^(#{1,6})\s+(.*)$/);
  if (match) {
    if (current) allSections.push(current);
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
if (current) allSections.push(current);

// Trim trailing blank lines accumulated inside each section's content.
for (const s of allSections) {
  s.content = s.content.replace(/\n+$/, '').trim();
}

// Filter to service-relevant sections, and prefix a level-3 subsection's
// heading with its parent ## heading for context (e.g. a subsection called
// "Applications" appears under two different parents in llms.txt, so the
// bare heading alone is ambiguous once sections are used independently).
let lastLevel2Heading = null;
const sections = [];
for (const section of allSections) {
  if (section.level === 2) lastLevel2Heading = section.heading;
  if (EXCLUDED_HEADINGS.has(section.heading)) continue;
  if (!section.content) continue;

  const heading =
    section.level === 3 && lastLevel2Heading && lastLevel2Heading !== section.heading
      ? `${lastLevel2Heading} — ${section.heading}`
      : section.heading;

  sections.push({ level: section.level, heading, content: section.content });
}

fs.writeFileSync(OUT, JSON.stringify(sections, null, 2) + '\n', 'utf-8');
console.log(`Wrote ${sections.length} of ${allSections.length} sections to ${path.relative(process.cwd(), OUT)} (${allSections.length - sections.length} excluded as non-service content)`);
