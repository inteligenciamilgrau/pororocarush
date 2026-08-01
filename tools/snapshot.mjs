// Freezes the current source tree as a version so the evolution v1 → v2 → v3 …
// stays inspectable and revertible.
//
//   node tools/snapshot.mjs --v v1 --note "mecanica base jogavel"
import { cp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function parseArgs(argv) {
  const o = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2), n = argv[i + 1];
      if (n === undefined || n.startsWith('--')) o[k] = true; else { o[k] = n; i++; }
    }
  }
  return o;
}
const args = parseArgs(process.argv);
const V = args.v;
if (!V) { console.error('usage: node tools/snapshot.mjs --v v1 [--note "..."]'); process.exit(1); }

const dest = resolve(`versions/${V}`);
await mkdir(dest, { recursive: true });
await cp(resolve('src'), `${dest}/src`, { recursive: true });
await cp(resolve('index.html'), `${dest}/index.html`);

let shots = null;
try { shots = JSON.parse(await readFile(resolve(`shots/${V}/manifest.json`), 'utf8')); } catch {}

await writeFile(`${dest}/VERSION.json`, JSON.stringify({
  version: V,
  note: args.note || '',
  stamped: process.env.PR_STAMP || null,
  shots: shots?.angles?.map((a) => ({
    angle: a.name, t: a.t,
    speedKmh: a.info?.snap?.player ? Math.round(a.info.snap.player.speed * 3.6) : null,
    points: a.info?.snap?.score?.points ?? null,
    drawCalls: a.info?.render?.calls ?? null,
    triangles: a.info?.render?.tris ?? null,
  })) || null,
}, null, 2));

console.log(`[snapshot] ${V} -> versions/${V}`);
