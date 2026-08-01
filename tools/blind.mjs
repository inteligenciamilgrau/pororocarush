// Builds a BLIND comparison set: the concept frame and the game frame are copied
// into a neutral folder as A.png / B.png in randomised order. The critic agent is
// pointed at that folder and never told which is which; the answer key is written
// outside the project tree so the critic cannot stumble onto it.
//
//   node tools/blind.mjs --v v1
//
// Produces  compare/<v>/<angle>/{A.png,B.png}  and the key in the scratchpad.
import { copyFile, mkdir, writeFile, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

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
const V = args.v || 'v1';
// The answer key must live OUTSIDE the project tree, or a critic agent browsing
// the repo can trip over it and the comparison stops being blind.
const KEYDIR = args.keydir || process.env.POROROCA_KEYDIR || join(tmpdir(), 'pororoca-blind-keys');

const PAIRS = [
  { angle: 'chase',  game: `shots/${V}/chase.png`,  concept: 'imagens_conceito/pororoca_rush_capa.png' },
  { angle: 'frente', game: `shots/${V}/frente.png`, concept: 'imagens_conceito/pororoca_rush_frente.png' },
  { angle: 'lado',   game: `shots/${V}/lado.png`,   concept: 'imagens_conceito/pororoca_rush_lado.png' },
  { angle: 'cima',   game: `shots/${V}/cima.png`,   concept: 'imagens_conceito/pororoca_rush_cima.png' },
];

// Cryptographic coin flip per pair — not seeded, so the critic cannot infer the
// ordering from a previous round.
const flip = () => (randomBytes(1)[0] & 1) === 1;

const key = { version: V, pairs: [] };
for (const p of PAIRS) {
  try { await readFile(resolve(p.game)); }
  catch { console.log(`[blind] skip ${p.angle}: missing ${p.game}`); continue; }

  const dir = resolve(`compare/${V}/${p.angle}`);
  await mkdir(dir, { recursive: true });
  const gameIsA = flip();
  await copyFile(resolve(p.game), join(dir, gameIsA ? 'A.png' : 'B.png'));
  await copyFile(resolve(p.concept), join(dir, gameIsA ? 'B.png' : 'A.png'));
  key.pairs.push({ angle: p.angle, dir: `compare/${V}/${p.angle}`, A: gameIsA ? 'game' : 'concept', B: gameIsA ? 'concept' : 'game' });
  console.log(`[blind] ${p.angle}: ${dir}`);
}

await mkdir(KEYDIR, { recursive: true });
const keyPath = join(KEYDIR, `blind-key-${V}.json`);
await writeFile(keyPath, JSON.stringify(key, null, 2));
console.log(`[blind] key -> ${keyPath}`);
console.log(JSON.stringify(key.pairs.map((p) => ({ angle: p.angle, dir: p.dir })), null, 2));
