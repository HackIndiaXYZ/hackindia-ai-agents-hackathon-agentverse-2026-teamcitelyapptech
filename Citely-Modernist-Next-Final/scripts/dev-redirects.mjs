// Writes a forwarding page at every page path of a built site, so links to
// the old citely.example/dev/... keep working after dev moved to its own
// address. Usage: node dev-redirects.mjs <built site> <output dir> <new origin>
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [from, to, origin] = process.argv.slice(2);
if (!from || !to || !/^https:\/\/[a-z0-9.-]+$/.test(origin || '')) {
  console.error('usage: dev-redirects.mjs <built site> <output dir> <https://new.origin>');
  process.exit(1);
}

async function pages(dir, base = '') {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('_next')) continue;
    const rel = path.posix.join(base, entry.name);
    if (entry.isDirectory()) out.push(...await pages(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith('.html')) out.push(rel);
  }
  return out;
}

const page = (target) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="robots" content="noindex"><link rel="canonical" href="${target}">
<title>Citely dev has moved</title>
<script>location.replace(${JSON.stringify(target)} + location.search + location.hash)</script>
<meta http-equiv="refresh" content="0; url=${target}">
</head><body><p>Citely dev has moved to <a href="${target}">${target}</a>.</p></body></html>
`;

const files = await pages(from);
for (const rel of files) {
  const route = rel === 'index.html' ? '' : rel.endsWith('/index.html') ? rel.slice(0, -'index.html'.length) : rel;
  await mkdir(path.join(to, path.dirname(rel)), { recursive: true });
  await writeFile(path.join(to, rel), page(`${origin}/${route}`));
}
console.log(`dev-redirects: ${files.length} forwarding pages -> ${origin}`);
