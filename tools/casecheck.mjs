// GitHub Pages serves from a case-sensitive filesystem; Windows does not.
// An import written with the wrong case works locally and 404s in production.
// This walks every relative import and asset reference and compares it against
// the real directory listing, byte for byte.
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = resolve('.');
const SKIP = new Set(['node_modules', '.git', 'shots', 'compare', 'versions', 'imagens_conceito']);

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else out.push(p);
  }
  return out;
}

// Real, case-exact path set.
const files = await walk(ROOT);
const real = new Set(files.map((f) => relative(ROOT, f).split('\\').join('/')));
const lower = new Map();
for (const f of real) lower.set(f.toLowerCase(), f);

const SPECS = [
  // JS: import/export ... from '...'  and  import('...')
  /(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g,
  /import\(\s*['"]([^'"]+)['"]\s*\)/g,
  // HTML/CSS asset references
  /(?:src|href)\s*=\s*['"]([^'"]+)['"]/g,
  /url\(\s*['"]?([^'")]+)['"]?\s*\)/g,
];

const problems = [];
let checked = 0;

for (const abs of files) {
  const rel = relative(ROOT, abs).split('\\').join('/');
  if (!/\.(js|mjs|html|css)$/i.test(rel)) continue;
  if (rel.startsWith('vendor/')) continue;          // third-party, self-consistent
  const code = await readFile(abs, 'utf8');

  for (const re of SPECS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code))) {
      const spec = m[1];
      if (!spec) continue;
      if (/^(https?:|data:|blob:|#|mailto:)/.test(spec)) continue;
      if (!spec.startsWith('.') && !spec.startsWith('/')) continue;  // bare → import map

      const target = spec.startsWith('/')
        ? spec.slice(1)
        : relative(ROOT, resolve(dirname(abs), spec)).split('\\').join('/');
      const clean = target.split('?')[0].split('#')[0];
      if (!clean) continue;
      checked++;

      if (real.has(clean)) continue;
      const alt = lower.get(clean.toLowerCase());
      if (alt) {
        problems.push({ kind: 'CAIXA', from: rel, spec, esperado: alt, escrito: clean });
      } else if (!(await stat(join(ROOT, clean)).catch(() => null))) {
        problems.push({ kind: 'AUSENTE', from: rel, spec, resolvido: clean });
      }
      if (spec.startsWith('/')) {
        problems.push({ kind: 'ABSOLUTO', from: rel, spec, nota: 'quebra sob /<repo>/ no Pages' });
      }
    }
  }
}

console.log(`[casecheck] ${checked} referencias verificadas em arquivos do jogo`);
if (!problems.length) console.log('[casecheck] OK — nenhuma divergencia de caixa, nenhum caminho absoluto, nenhum alvo ausente');
else { console.log(JSON.stringify(problems, null, 2)); }
process.exit(problems.length ? 1 : 0);
