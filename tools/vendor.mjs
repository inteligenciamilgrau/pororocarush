// Vendors the exact subset of three.js the game imports into ./vendor/three,
// so the project is a self-contained static site (GitHub Pages) with no
// node_modules and no CDN.
//
//   node tools/vendor.mjs
//
// Walks the import graph from the entry points and copies only what is reached.
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const SRC = resolve('node_modules/three');
const OUT = resolve('vendor/three');

const ENTRIES = [
  'build/three.module.js',
  'examples/jsm/postprocessing/EffectComposer.js',
  'examples/jsm/postprocessing/RenderPass.js',
  'examples/jsm/postprocessing/ShaderPass.js',
  'examples/jsm/postprocessing/UnrealBloomPass.js',
  'examples/jsm/utils/BufferGeometryUtils.js',
];

if (!existsSync(SRC)) {
  console.error('[vendor] node_modules/three ausente — rode `npm install` primeiro.');
  process.exit(1);
}

// Matches static and dynamic imports plus re-exports.
const IMPORT_RE = /(?:^|\s)(?:import|export)\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

// Normalise to forward slashes: on Windows path.join/relative return backslashes,
// which would make the same file look like two different queue entries.
const norm = (p) => p.split('\\').join('/');

const seen = new Set();
const queue = ENTRIES.map(norm);
const copied = [];

while (queue.length) {
  const rel = norm(queue.shift());
  if (seen.has(rel)) continue;
  seen.add(rel);

  const abs = join(SRC, rel);
  if (!existsSync(abs)) { console.warn(`[vendor] nao encontrado: ${rel}`); continue; }

  const code = await readFile(abs, 'utf8');
  const dest = join(OUT, rel);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, code);
  copied.push(rel);

  IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_RE.exec(code))) {
    const spec = m[1] || m[2];
    if (!spec) continue;
    if (spec === 'three') continue;                 // resolved by the import map
    if (spec.startsWith('three/addons/')) {
      queue.push(join('examples/jsm', spec.slice('three/addons/'.length)));
      continue;
    }
    if (!spec.startsWith('.')) continue;            // any other bare specifier
    const target = relative(SRC, resolve(dirname(abs), spec)).split('\\').join('/');
    queue.push(target);
  }
}

// Licence must travel with the code.
for (const f of ['LICENSE', 'README.md']) {
  if (existsSync(join(SRC, f))) {
    await mkdir(OUT, { recursive: true });
    await writeFile(join(OUT, f), await readFile(join(SRC, f), 'utf8'));
  }
}

let bytes = 0;
for (const f of copied) {
  const { size } = await import('node:fs').then((fs) => fs.promises.stat(join(OUT, f)));
  bytes += size;
}
console.log(`[vendor] ${copied.length} arquivos, ${(bytes / 1024 / 1024).toFixed(2)} MB -> vendor/three`);
for (const f of copied) console.log('  ' + f);
