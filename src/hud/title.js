// POROROCA RUSH — tela de abertura (title screen).
//
//   const title = new TitleScreen({
//     enabled: !captureMode,          // ?capture=1 -> false: a tela nunca aparece
//     onStart: () => { state.paused = false; },
//     onStory: () => story.show(),
//   });
//   if (title.enabled) { state.paused = true; title.show(); }
//
// DOM puro. Não importa nada do jogo 3D, não lê CONFIG, não toca no renderer.
// O overlay fica *por cima* da cena já renderizada — a cena é o fundo vivo da
// abertura, então nada aqui é opaco: há um degradê escuro concentrado atrás do
// texto e uma vinheta, e só.
//
// Escala: `--s` é a mesma fórmula de hud.css (um pixel da arte conceito no
// quadro de referência 1672x941), com um teto para telas absurdas. Todo tamanho
// é `N * var(--s)`, então a abertura e o HUD crescem juntos e a proporção da
// arte é preservada de 1280x720 a 4K.
//
// Vizinhos (não brigar com eles):
//  - `#boot` (index.html) tem z-index 100 e se remove sozinho; a abertura fica
//    em 80, portanto entra por baixo do boot e aparece quando ele sai.
//  - `#pr-menu` (menu.js) tem z-index 60 e pausa o jogo no ESC. Enquanto a
//    abertura está visível engolimos ESC/P na fase de captura, e o construtor
//    marca `pororoca.seen` (a chave que main.js usa para abrir o menu na
//    primeira visita) — a abertura já ensina os controles no rodapé.
//    Quem integra pode ainda checar `title.visible` antes de `menu.show()`.
//  - `#hud-root` e `#pr-lock` são apagados enquanto a abertura está no ar
//    (`body.pr-title-on`), senão o logo do HUD duplica o logo da abertura.

const STYLE_ID = 'pr-title-style';
const ROOT_ID = 'pr-title';
const BODY_CLASS = 'pr-title-on';

// A chave que main.js consulta para abrir o menu de controles na primeira
// visita. A abertura ocupa esse papel, então marcamos por ela.
const SEEN_KEY = 'pororoca.seen';

const FADE_MS = 420;

const TAGLINE = 'A maré vira o rio do avesso e nasce uma onda só. Fique nela.';

const CONTROL_HINTS = [
  { keys: ['A', 'D'], label: 'direção' },
  { keys: ['W'], label: 'acelerar' },
  { keys: ['ESPAÇO'], label: 'aéreo' },
  { keys: ['SHIFT'], label: 'tubo' },
  { keys: ['C'], label: 'câmera' },
  { keys: ['ESC'], label: 'menu' },
];

function reducedMotion() {
  try {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------- ilustração

// Mesma construção do logo de hud.js (mesmas proporções, mesmo rake itálico,
// mesmos riscos de velocidade), com os ids dos gradientes em outro namespace:
// id de SVG é global no documento, e repetir `prLogoW` faria o HUD e a abertura
// disputarem a mesma definição.
function logoSVG() {
  return `<svg viewBox="0 0 392 160" role="img" aria-label="Pororoca Rush">
  <defs>
    <linearGradient id="prtLogoW" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/><stop offset=".62" stop-color="#fbf4e7"/>
      <stop offset="1" stop-color="#dccfb8"/>
    </linearGradient>
    <linearGradient id="prtLogoO" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffe04f"/><stop offset=".34" stop-color="#ffab1c"/>
      <stop offset=".72" stop-color="#ff6f11"/><stop offset="1" stop-color="#d3300a"/>
    </linearGradient>
    <linearGradient id="prtLogoS" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ff8a16"/><stop offset="1" stop-color="#ff8a16" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <!-- pincelada de entrada, no mesmo rake do R de RUSH -->
  <g transform="skewX(-15)" fill="#ffffff">
    <path d="M52 100.6 L62 89.5 L112 89.5 L112 102.5 Z" opacity=".95"/>
    <path d="M66 107.5 L72 104 L112 104 L112 110 Z" opacity=".6"/>
  </g>

  <g transform="translate(27 76) skewX(-10)">
    <text x="0" y="0" textLength="309" lengthAdjust="spacingAndGlyphs"
          font-family="'Archivo Black','Barlow Condensed',Impact,sans-serif"
          font-size="72" fill="url(#prtLogoW)">POROROCA</text>
  </g>

  <g transform="translate(68 136) skewX(-15)">
    <text x="0" y="0" textLength="196" lengthAdjust="spacingAndGlyphs"
          font-family="'Archivo Black','Barlow Condensed',Impact,sans-serif"
          font-size="68" fill="url(#prtLogoO)"
          stroke="#2a1206" stroke-width="4.5" paint-order="stroke">RUSH</text>
  </g>

  <!-- riscos de velocidade -->
  <g transform="skewX(-15)">
    <path d="M286 88 L378 88 L372 99 L280 99 Z" fill="url(#prtLogoS)"/>
    <path d="M292 103 L364 103 L359 111 L287 111 Z" fill="#171008" opacity=".92"/>
    <path d="M282 115 L372 115 L366 124 L276 124 Z" fill="url(#prtLogoS)"/>
    <path d="M296 127 L352 127 L348 134 L292 134 Z" fill="#171008" opacity=".85"/>
    <path d="M300 138 L338 138 L335 143 L297 143 Z" fill="#ff8a16" opacity=".55"/>
  </g>
</svg>`;
}

function playSVG() {
  return `<svg class="pr-t-play" viewBox="0 0 24 24" aria-hidden="true">
  <path d="M5 2.5 L20.5 12 L5 21.5 Z"/>
</svg>`;
}

function diamondSVG() {
  return `<svg class="pr-t-dia" viewBox="0 0 24 24" aria-hidden="true">
  <path d="M12 1.5 L22.5 12 L12 22.5 L1.5 12 Z"/>
</svg>`;
}

function hintsHTML() {
  return CONTROL_HINTS.map((h) => `<span class="pr-t-k">${
    h.keys.map((k) => `<kbd>${k}</kbd>`).join('<i>/</i>')
  }<em>${h.label}</em></span>`).join('');
}

// ============================================================ a tela de abertura

export class TitleScreen {
  /**
   * @param {object}   [opts]
   * @param {Function} [opts.onStart]  chamado quando o jogador manda começar
   * @param {Function} [opts.onStory]  chamado no botão "A história da pororoca"
   * @param {boolean}  [opts.enabled]  false (modo captura) => nunca constrói nada
   * @param {boolean}  [opts.suppressFirstRunMenu] marcar `pororoca.seen` (padrão true)
   */
  constructor({ onStart, onStory, enabled = true, suppressFirstRunMenu = true } = {}) {
    this.enabled = enabled !== false;
    this.onStart = typeof onStart === 'function' ? onStart : () => {};
    this.onStory = typeof onStory === 'function' ? onStory : null;

    this._visible = false;
    this._started = false;
    this._disposed = false;
    this._hideTimer = 0;
    this._showRaf = 0;

    this.root = null;
    this.btnStart = null;
    this.btnStory = null;

    if (!this.enabled) return;

    if (suppressFirstRunMenu) {
      // O menu de controles abre sozinho na primeira visita e cairia por cima
      // desta tela. A abertura já lista os controles essenciais no rodapé.
      try { localStorage.setItem(SEEN_KEY, '1'); } catch (_) { /* modo privado */ }
    }

    try {
      this._buildStyle();
      this._buildDom();
      this._bind();
    } catch (err) {
      // Uma abertura quebrada não pode impedir o jogo de rodar.
      this.enabled = false;
      this._teardown();
      if (typeof console !== 'undefined') console.error('[title] build failed', err);
    }
  }

  get visible() { return this._visible; }

  // -------------------------------------------------------------------- estilo

  _buildStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
/* --s: um pixel da arte conceito (quadro 1672x941), igual a hud.css. */
#${ROOT_ID}{
  --s: clamp(0.52px, min(100vw / 1672, 100vh / 941), 2.9px);
  --amber:#f5c033; --amber-hi:#ffd24a; --orange:#ff7a18;
  --ink:#fdf6ea; --ink-dim:#cdbfa8; --deep:#140c06;
  position:fixed; inset:0; z-index:80; display:none;
  font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;
  color:var(--ink); line-height:1;
  text-transform:uppercase; font-variant-numeric:tabular-nums;
  -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility;
  user-select:none; -webkit-user-select:none;
  opacity:0; transition:opacity ${FADE_MS}ms ease;
}
#${ROOT_ID}.pr-t-on{ display:grid; grid-template-rows:1fr auto; }
#${ROOT_ID}.pr-t-vis{ opacity:1; }
#${ROOT_ID}.pr-t-out{ opacity:0; }
#${ROOT_ID} *{ box-sizing:border-box; margin:0; padding:0; }

/* --- fundo: nada opaco. Escurece a faixa do texto e vinheta nas bordas. --- */
#${ROOT_ID} .pr-t-veil,
#${ROOT_ID} .pr-t-vig,
#${ROOT_ID} .pr-t-glow{ position:absolute; inset:0; pointer-events:none; }
#${ROOT_ID} .pr-t-veil{
  background:
    radial-gradient(ellipse 58% 40% at 50% 43%,
      rgba(9,5,3,.74) 0%, rgba(9,5,3,.52) 46%, rgba(9,5,3,.16) 74%, rgba(9,5,3,0) 100%),
    linear-gradient(180deg,
      rgba(8,5,3,.52) 0%, rgba(8,5,3,.10) 24%, rgba(8,5,3,.12) 52%,
      rgba(8,5,3,.62) 84%, rgba(8,5,3,.86) 100%);
}
#${ROOT_ID} .pr-t-vig{
  background: radial-gradient(ellipse 76% 78% at 50% 50%,
    rgba(0,0,0,0) 40%, rgba(0,0,0,.30) 74%, rgba(0,0,0,.60) 100%);
}
/* brilho quente de pôr do sol atrás do logo */
#${ROOT_ID} .pr-t-glow{
  background: radial-gradient(ellipse 40% 26% at 50% 40%,
    rgba(255,150,40,.20) 0%, rgba(255,110,20,.07) 52%, rgba(255,110,20,0) 100%);
  mix-blend-mode:screen;
  animation: pr-t-breathe 9s ease-in-out infinite;
}
@keyframes pr-t-breathe{ 0%,100%{opacity:.72} 50%{opacity:1} }

/* --------------------------------------------------------------- conteúdo --- */
#${ROOT_ID} .pr-t-main{
  position:relative; grid-row:1;
  display:flex; flex-direction:column; align-items:center; justify-content:center;
  gap:calc(14 * var(--s));
  padding:calc(40 * var(--s)) 5vw calc(10 * var(--s));
  min-height:0; overflow:auto; overscroll-behavior:contain;
  text-align:center;
}
#${ROOT_ID} .pr-t-logo{
  width:min(calc(660 * var(--s)), 86vw, 62vh);
  aspect-ratio:392 / 160;
  filter:
    drop-shadow(0 calc(6 * var(--s)) calc(14 * var(--s)) rgba(0,0,0,.62))
    drop-shadow(0 0 calc(46 * var(--s)) rgba(255,122,24,.30));
}
#${ROOT_ID} .pr-t-logo svg{ display:block; width:100%; height:100%; overflow:visible; }

#${ROOT_ID} .pr-t-sub{
  display:flex; align-items:center; gap:calc(16 * var(--s));
  margin-top:calc(4 * var(--s));
  font-size:calc(26 * var(--s)); font-weight:800; font-style:italic; letter-spacing:.34em;
  color:var(--amber); white-space:nowrap;
  text-shadow: 0 calc(2 * var(--s)) 0 rgba(0,0,0,.55),
               0 calc(2 * var(--s)) calc(9 * var(--s)) rgba(0,0,0,.6);
}
#${ROOT_ID} .pr-t-sub i{
  display:block; width:calc(46 * var(--s)); height:calc(2.4 * var(--s));
  background:linear-gradient(90deg, rgba(245,192,51,0), var(--amber));
  flex:none;
}
#${ROOT_ID} .pr-t-sub i:last-child{ background:linear-gradient(90deg, var(--amber), rgba(245,192,51,0)); }

#${ROOT_ID} .pr-t-tag{
  max-width:calc(760 * var(--s));
  font-size:calc(30 * var(--s)); font-weight:600;
  letter-spacing:.02em; line-height:1.28; text-transform:none;
  color:#eadcc4;
  text-shadow: 0 calc(2 * var(--s)) calc(10 * var(--s)) rgba(0,0,0,.8);
}

/* ------------------------------------------------------------------ botões --- */
#${ROOT_ID} .pr-t-acts{
  display:flex; align-items:center; justify-content:center; flex-wrap:wrap;
  gap:calc(20 * var(--s)); margin-top:calc(20 * var(--s));
}
#${ROOT_ID} button{
  font:inherit; font-weight:800; font-style:italic; text-transform:uppercase;
  cursor:pointer; border-radius:calc(6 * var(--s)); white-space:nowrap;
  display:inline-flex; align-items:center; gap:calc(12 * var(--s));
  transition: transform .14s ease, background-color .18s ease, color .18s ease,
              box-shadow .18s ease, filter .18s ease, border-color .18s ease;
}
#${ROOT_ID} button:focus-visible{
  outline:calc(3 * var(--s)) solid #ffe9a8;
  outline-offset:calc(3 * var(--s));
}
#${ROOT_ID} .pr-t-go{
  font-size:calc(38 * var(--s)); letter-spacing:.16em;
  padding:calc(17 * var(--s)) calc(52 * var(--s)) calc(19 * var(--s));
  color:#180d04; border:calc(1.4 * var(--s)) solid #ffcf5e;
  background:linear-gradient(180deg,#ffdc74 0%,#ffb02e 46%,#ff7a18 100%);
  box-shadow: 0 calc(6 * var(--s)) calc(26 * var(--s)) rgba(255,122,24,.36),
              0 calc(3 * var(--s)) calc(8 * var(--s)) rgba(0,0,0,.45),
              inset 0 calc(1.5 * var(--s)) 0 rgba(255,255,255,.5);
  text-shadow:none;
}
#${ROOT_ID} .pr-t-go:hover{ filter:brightness(1.08); transform:translateY(calc(-1.5 * var(--s))); }
#${ROOT_ID} .pr-t-go:active{ transform:translateY(calc(1 * var(--s))); filter:brightness(.97); }
#${ROOT_ID} .pr-t-play{
  width:calc(24 * var(--s)); height:calc(24 * var(--s)); flex:none;
  fill:#2a1206; transform:skewX(-10deg);
}
#${ROOT_ID} .pr-t-story{
  font-size:calc(24 * var(--s)); letter-spacing:.14em;
  padding:calc(14 * var(--s)) calc(28 * var(--s)) calc(15 * var(--s));
  color:#ffd98a; border:calc(1.4 * var(--s)) solid rgba(245,192,51,.5);
  background:rgba(18,10,5,.5);
  -webkit-backdrop-filter:blur(4px); backdrop-filter:blur(4px);
  box-shadow:0 calc(3 * var(--s)) calc(10 * var(--s)) rgba(0,0,0,.42);
  text-shadow:0 calc(2 * var(--s)) calc(6 * var(--s)) rgba(0,0,0,.7);
}
#${ROOT_ID} .pr-t-story:hover{
  color:#fff3d8; border-color:var(--amber-hi); background:rgba(245,192,51,.16);
}
#${ROOT_ID} .pr-t-dia{
  width:calc(15 * var(--s)); height:calc(15 * var(--s)); flex:none; fill:var(--amber);
}

/* ------------------------------------------------------------------ rodapé --- */
#${ROOT_ID} .pr-t-foot{
  position:relative; grid-row:2;
  display:flex; flex-direction:column; align-items:center; gap:calc(12 * var(--s));
  padding:calc(14 * var(--s)) 4vw calc(30 * var(--s));
}
#${ROOT_ID} .pr-t-keys{
  display:flex; flex-wrap:wrap; align-items:center; justify-content:center;
  gap:calc(9 * var(--s)) calc(20 * var(--s));
}
#${ROOT_ID} .pr-t-k{ display:inline-flex; align-items:center; gap:calc(8 * var(--s)); }
#${ROOT_ID} .pr-t-k + .pr-t-k::before{
  content:'·'; margin-right:calc(12 * var(--s));
  color:var(--amber); opacity:.5; font-size:calc(22 * var(--s)); line-height:1;
}
#${ROOT_ID} kbd{
  font:inherit; font-style:normal; font-size:calc(17 * var(--s)); font-weight:800;
  letter-spacing:.06em; line-height:1;
  padding:calc(4 * var(--s)) calc(8 * var(--s)) calc(5 * var(--s));
  min-width:calc(26 * var(--s)); text-align:center;
  color:#ffd98a; background:linear-gradient(180deg,#3b2712,#241708);
  border:calc(1 * var(--s)) solid rgba(245,192,51,.45);
  border-bottom-width:calc(2.4 * var(--s));
  border-radius:calc(4 * var(--s));
  box-shadow:0 calc(2 * var(--s)) calc(5 * var(--s)) rgba(0,0,0,.6);
}
#${ROOT_ID} .pr-t-k i{ font-style:normal; opacity:.4; font-size:calc(16 * var(--s)); }
#${ROOT_ID} .pr-t-k em{
  font-style:italic; font-weight:800; font-size:calc(20 * var(--s)); letter-spacing:.08em;
  text-shadow:0 calc(2 * var(--s)) 0 rgba(0,0,0,.55), 0 calc(2 * var(--s)) calc(8 * var(--s)) rgba(0,0,0,.7);
}
#${ROOT_ID} .pr-t-mouse{
  font-size:calc(17 * var(--s)); font-weight:700; letter-spacing:.22em;
  color:var(--ink-dim); opacity:.72;
  text-shadow:0 calc(2 * var(--s)) calc(8 * var(--s)) rgba(0,0,0,.8);
}

/* --------------------------------------------------------------- entrada --- */
@keyframes pr-t-rise{
  from{ opacity:0; transform:translateY(calc(26 * var(--s))); }
  to{ opacity:1; transform:none; }
}
@keyframes pr-t-logo-in{
  from{ opacity:0; transform:translateY(calc(-18 * var(--s))) scale(.965); }
  to{ opacity:1; transform:none; }
}
#${ROOT_ID}.pr-t-vis .pr-t-logo{ animation:pr-t-logo-in .70s cubic-bezier(.16,.84,.3,1) both; }
#${ROOT_ID}.pr-t-vis .pr-t-sub{ animation:pr-t-rise .6s cubic-bezier(.16,.84,.3,1) .14s both; }
#${ROOT_ID}.pr-t-vis .pr-t-tag{ animation:pr-t-rise .6s cubic-bezier(.16,.84,.3,1) .22s both; }
#${ROOT_ID}.pr-t-vis .pr-t-acts{ animation:pr-t-rise .6s cubic-bezier(.16,.84,.3,1) .32s both; }
#${ROOT_ID}.pr-t-vis .pr-t-foot{ animation:pr-t-rise .6s cubic-bezier(.16,.84,.3,1) .44s both; }
#${ROOT_ID}.pr-t-out .pr-t-main{ transform:scale(1.015); transition:transform ${FADE_MS}ms ease; }

/* HUD e a dica de pointer lock ficam fora do ar enquanto a abertura está no ar. */
#hud-root{ transition:opacity .55s ease; }
body.${BODY_CLASS} #hud-root{ opacity:0; }
body.${BODY_CLASS} #pr-lock{ display:none !important; }

/* ------------------------------------------------------------ telas curtas --- */
@media (max-height:520px){
  #${ROOT_ID} .pr-t-tag{ display:none; }
  #${ROOT_ID} .pr-t-main{ gap:calc(8 * var(--s)); }
}
@media (max-width:640px){
  #${ROOT_ID} .pr-t-sub{ letter-spacing:.2em; font-size:calc(30 * var(--s)); }
  #${ROOT_ID} .pr-t-sub i{ width:calc(24 * var(--s)); }
  #${ROOT_ID} .pr-t-go{ font-size:calc(44 * var(--s)); }
  #${ROOT_ID} .pr-t-story{ font-size:calc(30 * var(--s)); }
  #${ROOT_ID} .pr-t-k em,
  #${ROOT_ID} .pr-t-mouse{ font-size:calc(24 * var(--s)); }
  #${ROOT_ID} kbd{ font-size:calc(21 * var(--s)); }
}

@media (prefers-reduced-motion: reduce){
  #${ROOT_ID},
  #${ROOT_ID} *{ animation:none !important; transition:none !important; }
  #hud-root{ transition:none !important; }
}
`;
    document.head.appendChild(s);
    this._styleEl = s;
  }

  // ----------------------------------------------------------------- markup

  _buildDom() {
    const el = document.createElement('div');
    el.id = ROOT_ID;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Pororoca Rush — tela inicial');

    el.innerHTML = `
<div class="pr-t-veil"></div>
<div class="pr-t-glow"></div>
<div class="pr-t-vig"></div>

<div class="pr-t-main">
  <div class="pr-t-logo">${logoSVG()}</div>
  <div class="pr-t-sub"><i></i><span>Pororoca do Arari</span><i></i></div>
  <p class="pr-t-tag">${TAGLINE}</p>
  <div class="pr-t-acts">
    <button type="button" class="pr-t-go" data-act="start">${playSVG()}<span>Começar</span></button>
    <button type="button" class="pr-t-story" data-act="story">${diamondSVG()}<span>A história da pororoca</span></button>
  </div>
</div>

<div class="pr-t-foot">
  <div class="pr-t-keys">${hintsHTML()}</div>
  <div class="pr-t-mouse">O mouse controla a câmera</div>
</div>`;

    document.body.appendChild(el);
    this.root = el;
    this.mainEl = el.querySelector('.pr-t-main');
    this.btnStart = el.querySelector('[data-act=start]');
    this.btnStory = el.querySelector('[data-act=story]');

    // Sem callback de história não há botão: um botão morto é pior que nenhum.
    if (!this.onStory && this.btnStory) {
      this.btnStory.remove();
      this.btnStory = null;
    }
  }

  _bind() {
    this._onStartClick = (e) => { e.preventDefault(); this._start(); };
    this._onStoryClick = (e) => {
      e.preventDefault();
      try { this.onStory(); } catch (err) {
        if (typeof console !== 'undefined') console.error('[title] onStory failed', err);
      }
    };
    // Clicar no fundo não começa o jogo (COMEÇAR é uma decisão, não um tropeço),
    // mas devolve o foco ao botão para que ENTER continue funcionando.
    this._onBackdrop = (e) => {
      if (e.target === this.root && this.btnStart) this.btnStart.focus({ preventScroll: true });
    };
    this._onKey = (e) => this._handleKey(e);

    this.btnStart.addEventListener('click', this._onStartClick);
    if (this.btnStory) this.btnStory.addEventListener('click', this._onStoryClick);
    this.root.addEventListener('mousedown', this._onBackdrop);
  }

  // ------------------------------------------------------------------ teclado

  _focusable() {
    if (!this.root) return [];
    return [this.btnStart, this.btnStory].filter((b) => b && b.isConnected);
  }

  _handleKey(e) {
    if (!this._visible || e.defaultPrevented) return;
    const code = e.code || '';

    // ESC/P abririam o menu de pausa por cima da abertura. Engolimos os dois
    // enquanto ela está no ar — o menu continua normal depois do COMEÇAR.
    if (code === 'Escape' || code === 'KeyP') {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (code === 'Tab') {
      const items = this._focusable();
      if (items.length < 2) { e.preventDefault(); items[0]?.focus({ preventScroll: true }); return; }
      const i = items.indexOf(document.activeElement);
      const next = e.shiftKey
        ? (i <= 0 ? items.length - 1 : i - 1)
        : (i < 0 || i === items.length - 1 ? 0 : i + 1);
      e.preventDefault();
      e.stopPropagation();
      items[next].focus({ preventScroll: true });
      return;
    }

    if (code === 'Enter' || code === 'NumpadEnter' || code === 'Space') {
      // Foco num botão: deixa a ativação nativa decidir — senão ENTER em
      // "A história da pororoca" começaria o jogo.
      const a = document.activeElement;
      if (a && a.tagName === 'BUTTON' && this.root.contains(a)) return;
      e.preventDefault();
      e.stopPropagation();
      this._start();
    }
  }

  // -------------------------------------------------------------------- fluxo

  _start() {
    if (this._started || !this._visible) return;
    this._started = true;
    this.hide();
    try { this.onStart(); } catch (err) {
      if (typeof console !== 'undefined') console.error('[title] onStart failed', err);
    }
  }

  /** Mostra a abertura. No-op (retorna false) quando `enabled` é false. */
  show() {
    if (!this.enabled || this._disposed || !this.root || this._visible) return false;
    this._visible = true;
    this._started = false;

    if (this._hideTimer) { clearTimeout(this._hideTimer); this._hideTimer = 0; }
    this.root.classList.remove('pr-t-out');
    this.root.classList.add('pr-t-on');
    document.body.classList.add(BODY_CLASS);
    this.root.removeAttribute('aria-hidden');

    // Capture: precisamos ver ESC antes do listener do menu (que é de bolha).
    window.addEventListener('keydown', this._onKey, true);

    // display:none -> grid precisa de um frame antes da transição de opacidade.
    if (this._showRaf) cancelAnimationFrame(this._showRaf);
    this._showRaf = requestAnimationFrame(() => {
      this._showRaf = 0;
      if (!this._visible || !this.root) return;
      this.root.classList.add('pr-t-vis');
      try { this.btnStart.focus({ preventScroll: true }); } catch (_) { /* sem foco, paciência */ }
    });
    return true;
  }

  /** Some com uma transição curta (instantâneo sob prefers-reduced-motion). */
  hide() {
    if (!this._visible || !this.root) return;
    this._visible = false;

    window.removeEventListener('keydown', this._onKey, true);
    if (this._showRaf) { cancelAnimationFrame(this._showRaf); this._showRaf = 0; }

    // Sai já da classe do body: o HUD entra enquanto a abertura sai.
    document.body.classList.remove(BODY_CLASS);
    this.root.classList.remove('pr-t-vis');
    this.root.classList.add('pr-t-out');
    this.root.setAttribute('aria-hidden', 'true');
    if (document.activeElement && this.root.contains(document.activeElement)) {
      try { document.activeElement.blur(); } catch (_) { /* noop */ }
    }

    const wait = reducedMotion() ? 0 : FADE_MS;
    if (this._hideTimer) clearTimeout(this._hideTimer);
    this._hideTimer = setTimeout(() => {
      this._hideTimer = 0;
      if (!this.root || this._visible) return;
      this.root.classList.remove('pr-t-on', 'pr-t-out');
    }, wait);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._visible = false;
    this._teardown();
  }

  _teardown() {
    if (this._onKey) window.removeEventListener('keydown', this._onKey, true);
    if (this._hideTimer) { clearTimeout(this._hideTimer); this._hideTimer = 0; }
    if (this._showRaf) { cancelAnimationFrame(this._showRaf); this._showRaf = 0; }
    try { document.body.classList.remove(BODY_CLASS); } catch (_) { /* noop */ }
    if (this.btnStart && this._onStartClick) this.btnStart.removeEventListener('click', this._onStartClick);
    if (this.btnStory && this._onStoryClick) this.btnStory.removeEventListener('click', this._onStoryClick);
    if (this.root) {
      if (this._onBackdrop) this.root.removeEventListener('mousedown', this._onBackdrop);
      this.root.remove();
    }
    if (this._styleEl) { this._styleEl.remove(); this._styleEl = null; }
    this.root = null;
    this.btnStart = null;
    this.btnStory = null;
    this.mainEl = null;
  }
}

export default TitleScreen;
