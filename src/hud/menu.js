// Pause / options / controls overlay.
// Integrator-owned: it reaches into input, camera and renderer, which no single
// subsystem should. Opens on ESC or P, and once automatically on first load.
//
// Preferences persist in localStorage under `pororoca.opts`. Everything exposed
// here is actually wired — no decorative toggles.

const STORE_KEY = 'pororoca.opts';

// Bump this whenever a default changes in a way that a stale saved value would
// contradict. Preferences are per-origin and survive a cache clear, so a camera
// mode picked once on localhost kept coming back for good — while the same build
// served from another origin behaved correctly, which is baffling from the outside.
const OPTS_VERSION = 2;

export const DEFAULT_OPTS = {
  invertSteer: false,
  steerSensitivity: 1.0,
  mouseLook: true,
  mouseSensitivity: 1.0,
  invertMouseY: false,
  autoRecenter: false,
  pointerLock: true,
  flip180: false,
  camera: 'chase',
  fov: 58,
  renderScale: 1.0,
  music: true,
  musicVolume: 0.68,
  sfx: true,
  sfxVolume: 0.78,
  showHud: true,
  showTips: true,
};

export function loadOpts() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch { /* corrupt or blocked */ }
  if (saved.__v !== OPTS_VERSION) {
    try { localStorage.removeItem(STORE_KEY); } catch { /* private mode */ }
    return { ...DEFAULT_OPTS };
  }
  const out = { ...DEFAULT_OPTS, ...saved };
  delete out.__v;
  return out;
}

function saveOpts(opts) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ ...opts, __v: OPTS_VERSION })); } catch { /* private mode */ }
}

const CONTROLS = [
  {
    group: 'Surfar',
    rows: [
      { keys: ['A', 'D'], alt: '← →', desc: 'Direção — inclina a prancha no rail' },
      { keys: ['W'], alt: '↑', desc: 'Acelerar. Na face, no ritmo certo, isso é o bombeio' },
      { keys: ['S'], alt: '↓', desc: 'Frear e abrir a curva' },
      { keys: ['SHIFT'], desc: 'Agachar — encaixa no tubo' },
    ],
  },
  {
    group: 'Manobras',
    rows: [
      { keys: ['ESPAÇO'], desc: 'Aéreo — solta do lábio em velocidade' },
      { keys: ['Q', 'E'], desc: 'Girar no ar (360 · 540 · 720)' },
      { keys: ['G'], desc: 'Grab — segura o rail no ar, multiplica a nota' },
    ],
  },
  {
    group: 'Câmera e sistema',
    rows: [
      { keys: ['C'], desc: 'Trocar câmera: perseguição · baixa · rabeta · 1ª pessoa · aberta · frente · lado · aérea' },
      { keys: ['V'], desc: 'Virar a câmera 180° — passa para o contra-plano' },
      { keys: ['P'], alt: 'ESC', desc: 'Pausar e abrir este menu' },
      { keys: ['R'], desc: 'Voltar para o pocket da onda' },
    ],
  },
];

const DICAS = [
  'Fique no <b>pocket</b>, logo à frente da crista: é onde a água te carrega e a velocidade se sustenta.',
  'Subir em direção ao lábio custa velocidade; descer a face devolve. <b>Bombear</b> é fazer isso no ritmo.',
  'Alto demais você passa por cima da onda. Baixo demais ela te alcança e engole. Os dois perdem o combo.',
  'Trimar quase paralelo à crista é mais rápido que apontar morro abaixo.',
  'Carvar forte raspa velocidade — vale pelos pontos, não pela pressa.',
  'No tubo os pontos correm rápido, mas o lábio fecha. Sair pela frente vale o bônus.',
  'Troncos são o perigo principal. Impacto direto derruba; de raspão só rouba velocidade.',
];

export class Menu {
  constructor(ctx, { onOptsChange } = {}) {
    this.ctx = ctx;
    this.state = ctx.state;
    this.opts = loadOpts();
    this.onOptsChange = onOptsChange || (() => {});
    this.open = false;
    this._tab = 'controles';

    this._buildStyle();
    this._buildDom();
    this._bindKeys();

    this.onOptsChange(this.opts);
  }

  // ------------------------------------------------------------------ setup
  _buildStyle() {
    if (document.getElementById('pr-menu-style')) return;
    const s = document.createElement('style');
    s.id = 'pr-menu-style';
    s.textContent = `
#pr-menu{position:fixed;inset:0;z-index:60;display:none;place-items:center;
  background:radial-gradient(ellipse at 50% 45%,rgba(60,28,8,.72),rgba(8,5,3,.92));
  backdrop-filter:blur(7px) saturate(.8);-webkit-backdrop-filter:blur(7px) saturate(.8);
  font-family:'Barlow Condensed','Arial Narrow',sans-serif;color:#f6ead6;
  animation:pr-fade .18s ease}
#pr-menu.on{display:grid}
@keyframes pr-fade{from{opacity:0}to{opacity:1}}
#pr-menu .panel{width:min(1020px,92vw);max-height:88vh;display:flex;flex-direction:column;
  background:linear-gradient(180deg,rgba(30,17,8,.93),rgba(18,10,5,.96));
  border:1px solid rgba(245,192,51,.28);border-radius:10px;
  box-shadow:0 30px 90px rgba(0,0,0,.62),inset 0 1px 0 rgba(255,220,160,.1);overflow:hidden}
#pr-menu .head{display:flex;align-items:baseline;gap:1rem;padding:1.15rem 1.6rem .9rem;
  border-bottom:1px solid rgba(245,192,51,.18)}
#pr-menu .head h2{margin:0;font-size:1.85rem;font-weight:800;font-style:italic;letter-spacing:.03em;
  text-transform:uppercase;background:linear-gradient(180deg,#fff 45%,#ffb64a 78%,#ff7a18 100%);
  -webkit-background-clip:text;background-clip:text;color:transparent}
#pr-menu .head .sub{font-size:.78rem;letter-spacing:.3em;text-transform:uppercase;opacity:.5}
#pr-menu .tabs{margin-left:auto;display:flex;gap:.35rem}
#pr-menu .tabs button{pointer-events:auto;font:inherit;font-size:.9rem;font-weight:700;letter-spacing:.16em;
  text-transform:uppercase;color:#c8b193;background:transparent;border:1px solid transparent;
  padding:.4rem .95rem;border-radius:5px;cursor:pointer;transition:.15s}
#pr-menu .tabs button:hover{color:#f6ead6;background:rgba(245,192,51,.09)}
#pr-menu .tabs button.sel{color:#0f0a05;background:linear-gradient(180deg,#ffd24a,#ff9c1c);border-color:#ffcf5e}
#pr-menu .body{padding:1.25rem 1.6rem 1.5rem;overflow:auto}
#pr-menu .cols{display:grid;grid-template-columns:1fr 1fr;gap:.4rem 2.6rem}
#pr-menu h3{grid-column:1/-1;margin:1.1rem 0 .45rem;font-size:.82rem;letter-spacing:.26em;
  text-transform:uppercase;color:#f5c033;font-weight:700}
#pr-menu h3:first-child{margin-top:0}
#pr-menu .row{display:flex;align-items:center;gap:.75rem;padding:.34rem 0;
  border-bottom:1px solid rgba(255,255,255,.045)}
#pr-menu .keys{display:flex;gap:.28rem;flex:0 0 auto;min-width:112px}
#pr-menu kbd{font:inherit;font-size:.82rem;font-weight:700;letter-spacing:.06em;
  background:linear-gradient(180deg,#3b2712,#241708);border:1px solid rgba(245,192,51,.4);
  border-bottom-width:2px;border-radius:4px;padding:.16rem .5rem;color:#ffd98a;
  box-shadow:0 1px 0 rgba(0,0,0,.5)}
#pr-menu .alt{opacity:.45;font-size:.8rem;align-self:center}
#pr-menu .desc{font-size:.95rem;opacity:.88;line-height:1.25}
#pr-menu .opt{display:flex;align-items:center;gap:1rem;padding:.6rem 0;
  border-bottom:1px solid rgba(255,255,255,.05)}
#pr-menu .opt .lbl{flex:1 1 auto}
#pr-menu .opt .lbl b{display:block;font-size:1rem;font-weight:700;letter-spacing:.02em}
#pr-menu .opt .lbl span{display:block;font-size:.82rem;opacity:.5;margin-top:.1rem}
#pr-menu .opt .ctl{flex:0 0 auto;display:flex;align-items:center;gap:.6rem;pointer-events:auto}
#pr-menu select,#pr-menu input[type=range]{pointer-events:auto;font:inherit}
#pr-menu select{background:#241708;color:#ffd98a;border:1px solid rgba(245,192,51,.4);
  border-radius:4px;padding:.3rem .6rem;font-size:.92rem;font-weight:600;cursor:pointer}
#pr-menu input[type=range]{width:170px;accent-color:#ff9c1c;cursor:pointer}
#pr-menu .val{min-width:52px;text-align:right;font-variant-numeric:tabular-nums;
  font-size:.92rem;color:#f5c033;font-weight:700}
#pr-menu .sw{position:relative;width:50px;height:26px;border-radius:13px;cursor:pointer;
  background:#2c1c0c;border:1px solid rgba(245,192,51,.32);transition:.18s}
#pr-menu .sw.on{background:linear-gradient(90deg,#c9721a,#ffb02e);border-color:#ffcf5e}
#pr-menu .sw i{position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;
  background:#f6ead6;transition:.18s;box-shadow:0 1px 3px rgba(0,0,0,.5)}
#pr-menu .sw.on i{left:26px}
#pr-menu .dicas li{margin:.42rem 0;font-size:.95rem;line-height:1.35;opacity:.85}
#pr-menu .dicas b{color:#f5c033;font-weight:700}
#pr-menu .foot{display:flex;align-items:center;gap:.7rem;padding:.9rem 1.6rem;
  border-top:1px solid rgba(245,192,51,.18);background:rgba(0,0,0,.22)}
#pr-menu .foot .hint{font-size:.8rem;letter-spacing:.14em;text-transform:uppercase;opacity:.42}
#pr-menu .foot .spacer{flex:1}
#pr-menu .btn{pointer-events:auto;font:inherit;font-size:1rem;font-weight:800;font-style:italic;
  letter-spacing:.12em;text-transform:uppercase;padding:.55rem 1.5rem;border-radius:5px;
  cursor:pointer;border:1px solid rgba(245,192,51,.42);background:transparent;color:#ffd98a;transition:.15s}
#pr-menu .btn:hover{background:rgba(245,192,51,.12)}
#pr-menu .btn.primary{color:#150d05;border-color:#ffcf5e;
  background:linear-gradient(180deg,#ffd24a,#ff9c1c);box-shadow:0 4px 18px rgba(255,140,20,.3)}
@media (max-width:760px){#pr-menu .cols{grid-template-columns:1fr}}

/* Dica de pointer lock: sem ela ninguem descobre que precisa clicar. */
#pr-lock{position:fixed;left:50%;bottom:11%;transform:translateX(-50%);z-index:40;
  display:none;align-items:center;gap:.6rem;padding:.5rem 1.1rem;border-radius:999px;
  background:rgba(18,10,5,.62);border:1px solid rgba(245,192,51,.3);
  backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);
  font-family:'Barlow Condensed','Arial Narrow',sans-serif;color:#f6ead6;
  font-size:.92rem;letter-spacing:.14em;text-transform:uppercase;
  pointer-events:none;animation:pr-pulse 2.6s ease-in-out infinite}
#pr-lock.on{display:flex}
#pr-lock svg{width:17px;height:17px;fill:#f5c033;flex:0 0 auto}
@keyframes pr-pulse{0%,100%{opacity:.62}50%{opacity:1}}
`;
    document.head.appendChild(s);
  }

  _buildDom() {
    const el = document.createElement('div');
    el.id = 'pr-menu';
    el.innerHTML = `
<div class="panel">
  <div class="head">
    <h2>Pororoca Rush</h2>
    <div class="sub">Pororoca do Arari</div>
    <div class="tabs">
      <button data-tab="controles" class="sel">Controles</button>
      <button data-tab="opcoes">Opções</button>
      <button data-tab="dicas">Como surfar</button>
    </div>
  </div>
  <div class="body"></div>
  <div class="foot">
    <span class="hint">ESC ou P para fechar</span>
    <span class="spacer"></span>
    <button class="btn" data-act="defaults">Redefinir opções</button>
    <button class="btn" data-act="reset">Voltar pro pocket</button>
    <button class="btn primary" data-act="close">Surfar</button>
  </div>
</div>`;
    document.body.appendChild(el);
    this.el = el;
    this.bodyEl = el.querySelector('.body');

    const lock = document.createElement('div');
    lock.id = 'pr-lock';
    lock.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5zm0 2a3 3 0 0 1 3 3v3H9V7a3 3 0 0 1 3-3z"/></svg><span>Clique para travar o mouse e olhar em volta</span>`;
    document.body.appendChild(lock);
    this.lockHint = lock;
    this._syncLockHint();
    document.addEventListener('pointerlockchange', () => this._syncLockHint());

    el.querySelectorAll('.tabs button').forEach((b) => {
      b.addEventListener('click', () => { this._tab = b.dataset.tab; this._renderTabs(); this._render(); });
    });
    el.querySelector('[data-act=close]').addEventListener('click', () => this.close());
    // Preferences persist, so a camera picked once keeps coming back on every
    // load — invisibly, and it looks like the game ignoring you.
    el.querySelector('[data-act=defaults]').addEventListener('click', () => {
      this.opts = { ...DEFAULT_OPTS };
      try { localStorage.removeItem(STORE_KEY); } catch { /* private mode */ }
      this.state.camera.flip180 = false;
      this.state.camera.lookYaw = 0;
      this.state.camera.lookPitch = 0;
      this.state.camera.zoom = 1;
      this.onOptsChange(this.opts);
      this._render();
      this._syncLockHint();
    });
    el.querySelector('[data-act=reset]').addEventListener('click', () => {
      this.ctx.physics?.reset?.();
      this.close();
    });
    // Clicking the backdrop closes, clicking the panel does not.
    el.addEventListener('click', (e) => { if (e.target === el) this.close(); });

    this._render();
  }

  _bindKeys() {
    this._onKey = (e) => {
      if (e.code === 'Escape' || e.code === 'KeyP') {
        // ESC that merely released the pointer lock is the player asking for the
        // cursor back, not for the menu. Swallow that one.
        if (e.code === 'Escape' && this.ctx.input?.wasLockReleasedJustNow?.()) return;
        e.preventDefault();
        this.toggle();
      } else if (this.open && e.code === 'Enter') {
        e.preventDefault();
        this.close();
      }
    };
    window.addEventListener('keydown', this._onKey);
  }

  // ----------------------------------------------------------------- render
  _renderTabs() {
    this.el.querySelectorAll('.tabs button').forEach((b) => {
      b.classList.toggle('sel', b.dataset.tab === this._tab);
    });
  }

  _render() {
    if (this._tab === 'controles') this._renderControls();
    else if (this._tab === 'opcoes') this._renderOptions();
    else this._renderDicas();
  }

  _renderControls() {
    const rowHtml = (r) => `
<div class="row">
  <div class="keys">${r.keys.map((k) => `<kbd>${k}</kbd>`).join('')}</div>
  ${r.alt ? `<div class="alt">${r.alt}</div>` : ''}
  <div class="desc">${r.desc}</div>
</div>`;
    this.bodyEl.innerHTML = `<div class="cols">${
      CONTROLS.map((g) => `<h3>${g.group}</h3>${g.rows.map(rowHtml).join('')}`).join('')
    }</div>`;
  }

  _renderDicas() {
    this.bodyEl.innerHTML = `<ul class="dicas">${DICAS.map((d) => `<li>${d}</li>`).join('')}</ul>`;
  }

  _renderOptions() {
    const o = this.opts;
    const sw = (key, title, sub) => `
<div class="opt">
  <div class="lbl"><b>${title}</b><span>${sub}</span></div>
  <div class="ctl"><div class="sw ${o[key] ? 'on' : ''}" data-sw="${key}"><i></i></div></div>
</div>`;
    const rng = (key, title, sub, min, max, step, fmt) => `
<div class="opt">
  <div class="lbl"><b>${title}</b><span>${sub}</span></div>
  <div class="ctl">
    <input type="range" data-rng="${key}" min="${min}" max="${max}" step="${step}" value="${o[key]}">
    <span class="val" data-val="${key}">${fmt(o[key])}</span>
  </div>
</div>`;

    this.bodyEl.innerHTML = `
${sw('invertSteer', 'Inverter direção', 'Troca esquerda e direita')}
${rng('steerSensitivity', 'Sensibilidade da direção', 'O quanto a prancha responde ao comando', 0.4, 1.8, 0.05, (v) => (+v).toFixed(2) + '×')}
<div class="opt">
  <div class="lbl"><b>Câmera</b><span>Também alterna no jogo com a tecla C</span></div>
  <div class="ctl"><select data-sel="camera">
    <optgroup label="De trás">
      <option value="pov">Primeira pessoa</option>
      <option value="tail">Rabeta — rente à água</option>
      <option value="chaseLow">Perseguição baixa</option>
      <option value="chase">Perseguição</option>
      <option value="chaseFar">Perseguição aberta</option>
    </optgroup>
    <optgroup label="Outros ângulos">
      <option value="front">De frente</option>
      <option value="side">De lado</option>
      <option value="aerial">Aérea</option>
    </optgroup>
  </select></div>
</div>
${sw('flip180', 'Virar câmera 180°', 'Contra-plano: o rig vai para a frente e olha de volta · tecla V')}
${sw('mouseLook', 'Mouse controla a câmera', 'Arraste para girar em volta do surfista · roda dá zoom · botão do meio recentraliza')}
${rng('mouseSensitivity', 'Sensibilidade do mouse', 'O quanto a câmera gira por pixel arrastado', 0.3, 2.5, 0.05, (v) => (+v).toFixed(2) + '×')}
${sw('invertMouseY', 'Inverter eixo Y do mouse', 'Arrastar para baixo olha para cima')}
${sw('autoRecenter', 'Recentralizar sozinho', 'Volta ao enquadramento padrão depois de 1,6 s parado')}
${sw('pointerLock', 'Travar o ponteiro', 'Olhar contínuo sem arrastar. ESC libera o cursor')}
${rng('fov', 'Campo de visão', 'Maior alarga a cena e exagera a velocidade', 45, 80, 1, (v) => Math.round(v) + '°')}
${rng('renderScale', 'Resolução', 'Baixe se o jogo estiver travando', 0.5, 1.0, 0.05, (v) => Math.round(v * 100) + '%')}
${sw('music', 'Trilha sonora', 'Surf music com guitarrada e percussão amazônica')}
${rng('musicVolume', 'Volume da música', 'Ajusta só a trilha do jogo', 0, 1, 0.05, (v) => Math.round(v * 100) + '%')}
${sw('sfx', 'Efeitos sonoros', 'Ondas, prancha, impactos, obstáculos e manobras')}
${rng('sfxVolume', 'Volume dos efeitos', 'Ajusta os barulhinhos sem alterar a música', 0, 1, 0.05, (v) => Math.round(v * 100) + '%')}
${sw('showHud', 'Mostrar HUD', 'Pontuação, velocidade, checkpoint e minimapa')}`;

    this.bodyEl.querySelector('[data-sel=camera]').value = o.camera;

    this.bodyEl.querySelectorAll('[data-sw]').forEach((el) => {
      el.addEventListener('click', () => {
        const k = el.dataset.sw;
        this.opts[k] = !this.opts[k];
        el.classList.toggle('on', this.opts[k]);
        this._commit();
      });
    });
    this.bodyEl.querySelectorAll('[data-rng]').forEach((el) => {
      el.addEventListener('input', () => {
        const k = el.dataset.rng;
        this.opts[k] = parseFloat(el.value);
        const out = this.bodyEl.querySelector(`[data-val="${k}"]`);
        if (out) {
          out.textContent = k === 'fov' ? Math.round(this.opts[k]) + '°'
            : (k === 'renderScale' || k === 'musicVolume' || k === 'sfxVolume') ? Math.round(this.opts[k] * 100) + '%'
            : this.opts[k].toFixed(2) + '×';
        }
        this._commit();
      });
    });
    this.bodyEl.querySelector('[data-sel=camera]').addEventListener('change', (e) => {
      this.opts.camera = e.target.value;
      this._commit();
    });
  }

  _commit() {
    saveOpts(this.opts);
    this.onOptsChange(this.opts);
    this._syncLockHint();
  }

  // Only nag when the pointer is actually free, mouse look is on, pointer lock is
  // the chosen mode, and the menu is not covering the screen anyway.
  _syncLockHint() {
    if (!this.lockHint) return;
    const show = !this.open
      && this.opts.mouseLook !== false
      && this.opts.pointerLock !== false
      && !document.pointerLockElement;
    this.lockHint.classList.toggle('on', show);
  }

  // ------------------------------------------------------------------ state
  toggle() { this.open ? this.close() : this.show(); }

  show() {
    this.open = true;
    this.state.paused = true;
    // Hand the cursor back, or the player cannot click anything in here.
    if (document.pointerLockElement) document.exitPointerLock?.();
    this.el.classList.add('on');
    this._renderTabs();
    this._render();
  }

  close() {
    this.open = false;
    this.state.paused = false;
    this.el.classList.remove('on');
    this._syncLockHint();
  }

  dispose() {
    window.removeEventListener('keydown', this._onKey);
    this.el?.remove();
  }
}
