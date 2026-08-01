// POROROCA RUSH — "A história da pororoca".
//
// A modal that explains the phenomenon the game simulates: Moon -> tide ->
// tidal bore. It opens over the intro or over the pause menu, and the drawing
// is the point — three inline SVG frames, no external assets, no CDN.
//
//   const story = new StoryScreen({ onClose: () => intro.focusBack() });
//   story.show();  story.hide();  story.dispose();
//
// Facts checked against Wikipédia (Pororoca / Araguari River), Mongabay
// ("Riders of the lost waves", 2022) and Wikipédia lusófona (Macaréu).
// Height and speed are deliberately left qualitative: published figures
// disagree (3–6 m, 16–50 km/h), so the copy says "alguns metros" instead of
// inventing a number the player could catch us on.

const STYLE_ID = 'pr-story-style';
const ROOT_ID = 'pr-story';

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/* ========================================================================== */
/* CSS                                                                         */
/* ========================================================================== */

// Everything below the panel is sized in `em` against one clamped root size,
// so the whole screen scales together from 1280x720 up to 4K without a single
// media query for typography. Only the card grid reflows, and it does that on
// its own via auto-fit.
const CSS = `
#${ROOT_ID}{
  position:fixed;inset:0;z-index:140;display:none;place-items:center;
  font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif;
  font-size:clamp(13px,1.42vmin,24px);line-height:1.32;color:#fdf6ea;
  background:radial-gradient(ellipse at 50% 40%,rgba(58,27,8,.82),rgba(9,5,3,.955));
  backdrop-filter:blur(8px) saturate(.85);-webkit-backdrop-filter:blur(8px) saturate(.85);
  --amber:#f5c033;--amber-hi:#ffd24a;--orange:#ff7a18;--ink:#fdf6ea;--dim:#c2ac8c;
}
#${ROOT_ID}.on{display:grid}
#${ROOT_ID} *{box-sizing:border-box;margin:0;padding:0}

#${ROOT_ID} .panel{
  position:relative;
  width:min(86em,95vw);height:min(64em,93vh);display:flex;flex-direction:column;
  background:linear-gradient(180deg,rgba(33,19,9,.965),rgba(17,10,5,.985));
  border:1px solid rgba(245,192,51,.30);border-radius:.75em;
  box-shadow:0 2em 6em rgba(0,0,0,.66),inset 0 1px 0 rgba(255,220,160,.10);
  overflow:hidden;
}

/* ---------------------------------------------------------------- header -- */
#${ROOT_ID} .head{padding:1.35em 1.8em 1.05em;border-bottom:1px solid rgba(245,192,51,.18)}
#${ROOT_ID} .kick{
  font-size:.82em;font-weight:700;letter-spacing:.34em;text-transform:uppercase;
  color:var(--amber);opacity:.9;
}
#${ROOT_ID} h2{
  margin:.14em 0 0;font-size:2.5em;font-weight:800;font-style:italic;line-height:.98;
  letter-spacing:.015em;text-transform:uppercase;
  background:linear-gradient(180deg,#fff 42%,#ffb64a 76%,#ff7a18 100%);
  -webkit-background-clip:text;background-clip:text;color:transparent;
}
#${ROOT_ID} .lead{
  margin-top:.55em;max-width:52em;font-size:1.12em;line-height:1.38;color:#efe1c9;
}
#${ROOT_ID} .lead b{color:var(--amber);font-weight:700}

/* ------------------------------------------------------------------ body -- */
#${ROOT_ID} .body{
  position:relative;flex:1;min-height:0;padding:1em 1.2em;overflow:hidden;
}
#${ROOT_ID} .viewport{width:100%;height:100%;overflow:hidden}
#${ROOT_ID} .track{
  display:flex;width:100%;height:100%;transform:translateX(0);
  transition:transform .42s cubic-bezier(.2,.8,.25,1);will-change:transform;
}
#${ROOT_ID} .slide{
  flex:0 0 100%;width:100%;height:100%;min-width:0;padding:.15em 4.1em;
  display:flex;align-items:center;justify-content:center;overflow:hidden;
}

#${ROOT_ID} .art{
  width:100%;height:100%;margin:0;display:flex;flex-direction:column;
  align-items:center;justify-content:center;overflow:visible;background:transparent;border:0;
}
#${ROOT_ID} .art img{
  display:block;max-width:100%;width:auto;max-height:calc(100% - 3.2em);height:auto;object-fit:contain;border-radius:.4em;
  border:1px solid rgba(245,192,51,.22);box-shadow:0 1em 3em rgba(0,0,0,.5);
}
#${ROOT_ID} .art figcaption{
  width:min(68em,100%);margin-top:.7em;font-size:1.02em;line-height:1.35;color:#d9c9ae;
  border-left:.14em solid var(--amber);padding-left:.7em;
}
#${ROOT_ID} .art.diagram img{background:#140c06}

#${ROOT_ID} .card{
  width:min(72em,100%);max-height:100%;display:grid;
  grid-template-columns:minmax(0,1.4fr) minmax(18em,.6fr);grid-template-rows:auto 1fr;
  gap:.8em 1.2em;padding:1em;
  background:linear-gradient(180deg,rgba(255,196,104,.055),rgba(0,0,0,.20));
  border:1px solid rgba(245,192,51,.17);border-radius:.5em;
}
#${ROOT_ID} .card>figure{grid-row:1 / 3;align-self:center}
#${ROOT_ID} .card>.cap{align-self:end}
#${ROOT_ID} .card>div:last-child{align-self:start}
#${ROOT_ID} figure{
  margin:0;border-radius:.32em;overflow:hidden;background:#140c06;
  border:1px solid rgba(245,192,51,.14);
}
#${ROOT_ID} figure svg{display:block;width:100%;height:auto}

#${ROOT_ID} .cap{display:flex;align-items:baseline;gap:.55em}
#${ROOT_ID} .step{
  flex:0 0 auto;font-size:1.5em;font-weight:900;font-style:italic;line-height:1;
  letter-spacing:-.02em;color:var(--orange);
  text-shadow:0 .06em 0 rgba(0,0,0,.55);
}
#${ROOT_ID} h3{
  font-size:1.18em;font-weight:800;font-style:italic;letter-spacing:.045em;
  text-transform:uppercase;line-height:1.05;color:var(--ink);
}
#${ROOT_ID} .card p{font-size:1.02em;line-height:1.36;color:#e4d5bb}
#${ROOT_ID} .card p+p{margin-top:.5em}
#${ROOT_ID} .card p b{color:var(--amber);font-weight:700}

/* -------------------------------------------------------------- fact bar -- */
#${ROOT_ID} .facts{
  display:grid;grid-template-columns:repeat(auto-fit,minmax(15em,1fr));gap:.55em 1.4em;
  width:min(66em,100%);padding:1.4em;border:1px solid rgba(245,192,51,.18);
  border-radius:.5em;background:linear-gradient(180deg,rgba(255,196,104,.055),rgba(0,0,0,.20));
}
#${ROOT_ID} .fact{display:flex;flex-direction:column;gap:.16em}
#${ROOT_ID} .fact b{
  font-size:.8em;font-weight:700;letter-spacing:.24em;text-transform:uppercase;color:var(--amber);
}
#${ROOT_ID} .fact span{font-size:.98em;line-height:1.3;color:#d9c9ae}
#${ROOT_ID} .fact i{font-style:italic;color:var(--ink)}

/* ------------------------------------------------------------ navigation -- */
#${ROOT_ID} .nav{
  position:absolute;z-index:3;top:50%;width:3.2em;height:3.2em;margin-top:-1.6em;
  display:grid;place-items:center;border-radius:50%;cursor:pointer;
  border:1px solid rgba(255,210,90,.72);color:#170d05;
  background:linear-gradient(180deg,#ffd967,#ff9b1b);
  box-shadow:0 .35em 1.3em rgba(0,0,0,.48),0 0 1.4em rgba(255,140,20,.22);
  font:900 1.45em/1 Arial,sans-serif;
}
#${ROOT_ID} .nav.prev{left:1.25em}
#${ROOT_ID} .nav.next{right:1.25em}
#${ROOT_ID} .nav:hover:not(:disabled){background:linear-gradient(180deg,#ffe68f,#ffad36);transform:scale(1.05)}
#${ROOT_ID} .nav:disabled{opacity:.22;cursor:default;box-shadow:none}
#${ROOT_ID} .pager{display:flex;align-items:center;gap:.55em;color:var(--dim)}
#${ROOT_ID} .dots{display:flex;align-items:center;gap:.34em}
#${ROOT_ID} .dot{width:.42em;height:.42em;border-radius:50%;background:rgba(255,255,255,.25)}
#${ROOT_ID} .dot.on{width:1.25em;border-radius:1em;background:var(--amber)}
#${ROOT_ID} .page-n{min-width:3.7em;text-align:center;font-weight:800;color:#f4dfbd}

/* ---------------------------------------------------------------- footer -- */
#${ROOT_ID} .foot{
  position:relative;
  display:flex;align-items:center;gap:.8em;padding:.85em 1.8em;
  border-top:1px solid rgba(245,192,51,.18);background:rgba(0,0,0,.24);
}
#${ROOT_ID} .foot .hint{
  font-size:.82em;letter-spacing:.16em;text-transform:uppercase;color:var(--dim);opacity:.7;
}
#${ROOT_ID} .foot .spacer{flex:1}
#${ROOT_ID} .btn{
  font:inherit;font-size:1.05em;font-weight:800;font-style:italic;letter-spacing:.13em;
  text-transform:uppercase;padding:.5em 1.6em;border-radius:.3em;cursor:pointer;
  color:#150d05;border:1px solid #ffcf5e;
  background:linear-gradient(180deg,#ffd24a,#ff9c1c);
  box-shadow:0 .25em 1.1em rgba(255,140,20,.30);
}
#${ROOT_ID} .btn:hover{background:linear-gradient(180deg,#ffdd6e,#ffab34)}
#${ROOT_ID} .btn:active{transform:translateY(1px)}

#${ROOT_ID} :focus-visible{outline:.16em solid var(--amber-hi);outline-offset:.22em;border-radius:.2em}

/* -------------------------------------------------------------- motion --- */
@media (prefers-reduced-motion:no-preference){
  #${ROOT_ID}.on{animation:pr-story-fade .2s ease both}
  #${ROOT_ID}.on .panel{animation:pr-story-rise .28s cubic-bezier(.2,.8,.3,1) both}
  #${ROOT_ID} .btn,#${ROOT_ID} .nav{transition:background .15s ease,transform .08s ease,opacity .15s ease}
  #${ROOT_ID} .pr-glow{animation:pr-story-glow 5.5s ease-in-out infinite}
}
@keyframes pr-story-fade{from{opacity:0}to{opacity:1}}
@keyframes pr-story-rise{from{opacity:0;transform:translateY(1.6em) scale(.985)}to{opacity:1;transform:none}}
@keyframes pr-story-glow{0%,100%{opacity:.16}50%{opacity:.34}}

/* Short viewports: give the slides everything they can get. */
@media (max-height:820px){
  #${ROOT_ID} .panel{height:96vh}
  #${ROOT_ID} .head{padding:1.1em 1.5em .85em}
  #${ROOT_ID} .body{padding:1em 1.5em .85em}
  #${ROOT_ID} .foot{padding:.7em 1.5em}
  #${ROOT_ID} .card{gap:.55em;padding:.7em .75em .85em}
  #${ROOT_ID} .facts{padding:.9em}
}
@media (max-height:560px){
  #${ROOT_ID} .panel{height:98vh}
  #${ROOT_ID} .head{padding:.9em 1.4em .8em}
  #${ROOT_ID} .lead{display:none}
  #${ROOT_ID} .body{padding:.65em 1em}
  #${ROOT_ID} .foot{padding:.6em 1.4em}
}
@media (max-width:820px){
  #${ROOT_ID} .slide{padding:.1em 3.3em}
  #${ROOT_ID} .card{display:flex;flex-direction:column;gap:.55em;font-size:.88em}
  #${ROOT_ID} .card>figure{max-height:52%;flex:1}
  #${ROOT_ID} .card>figure svg{width:100%;height:100%;object-fit:contain}
  #${ROOT_ID} .nav.prev{left:.75em}
  #${ROOT_ID} .nav.next{right:.75em}
}
`;

/* ========================================================================== */
/* ILLUSTRATIONS — inline SVG, game palette                                    */
/*   water  #8a5a28 .. #c08a45   foam #e8d6b4                                  */
/*   amber  #f5c033   orange #ff7a18   jungle #101a10   bg #140c06             */
/* ========================================================================== */

// Shared text styling for the drawings. SVG has no text-transform, so every
// label is written in caps by hand.
const SVG_FONT = `font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif`;

/* --- 1. The Moon pulls the ocean; Sun-Earth-Moon aligned = spring tide ----- */
function svgTide() {
  return `
<svg viewBox="0 0 320 240" role="img" aria-labelledby="prs1-t prs1-d" style="${SVG_FONT}">
  <title id="prs1-t">A Lua puxa o oceano</title>
  <desc id="prs1-d">Sol, Terra e Lua alinhados. O oceano da Terra está esticado em dois bojos,
  um voltado para a Lua e outro do lado oposto — a maré de sizígia. Esquema fora de escala.</desc>
  <defs>
    <radialGradient id="prs1-sun">
      <stop offset="0" stop-color="#fff0c4"/><stop offset=".45" stop-color="#ffb02e"/>
      <stop offset="1" stop-color="#c04c0a" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="prs1-earth" cx=".38" cy=".32" r=".85">
      <stop offset="0" stop-color="#c08a45"/><stop offset=".62" stop-color="#8a5a28"/>
      <stop offset="1" stop-color="#3c2410"/>
    </radialGradient>
    <linearGradient id="prs1-bulge" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#c08a45" stop-opacity=".55"/>
      <stop offset=".5" stop-color="#8a5a28" stop-opacity=".30"/>
      <stop offset="1" stop-color="#c08a45" stop-opacity=".55"/>
    </linearGradient>
    <marker id="prs1-ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="#f5c033"/>
    </marker>
  </defs>

  <rect width="320" height="240" fill="#140c06"/>

  <!-- syzygy axis: the whole point of the frame -->
  <line x1="0" y1="118" x2="320" y2="118" stroke="#f5c033" stroke-width="1"
        stroke-dasharray="6 6" opacity=".35"/>

  <text x="160" y="24" text-anchor="middle" font-size="11.5" font-weight="700"
        letter-spacing="1.4" fill="#f5c033">SOL · TERRA · LUA ALINHADOS</text>
  <text x="160" y="39" text-anchor="middle" font-size="10" font-weight="700"
        letter-spacing="1.1" fill="#fdf6ea" opacity=".82">MARÉ DE SIZÍGIA — A MAIOR DO MÊS</text>

  <!-- Sun, off the left edge -->
  <circle class="pr-glow" cx="-10" cy="118" r="74" fill="#ff7a18" opacity=".22"/>
  <circle cx="-10" cy="118" r="48" fill="url(#prs1-sun)"/>
  <text x="8" y="192" font-size="10.5" font-weight="800" letter-spacing="2.4" fill="#ffb64a">SOL</text>

  <!-- exaggerated tidal bulge, drawn behind the planet -->
  <ellipse cx="155" cy="118" rx="57" ry="38" fill="url(#prs1-bulge)"
           stroke="#f5c033" stroke-width="1.2" stroke-dasharray="4 4" opacity=".95"/>

  <!-- Earth -->
  <circle cx="155" cy="118" r="32" fill="url(#prs1-earth)"/>
  <path d="M136,100 c8,-5 16,1 21,-4 c6,-5 12,0 16,4 c-5,7 -14,6 -20,11 c-7,5 -14,0 -17,-11 z
           M141,133 c9,-2 15,4 24,2 c5,-1 8,3 6,7 c-11,6 -25,3 -30,-9 z"
        fill="#101a10" opacity=".78"/>
  <circle cx="155" cy="118" r="32" fill="none" stroke="#e8d6b4" stroke-width="1" opacity=".35"/>
  <text x="155" y="182" text-anchor="middle" font-size="10.5" font-weight="800"
        letter-spacing="2.2" fill="#fdf6ea">TERRA</text>

  <!-- pull arrows, one toward the Sun, one toward the Moon -->
  <line x1="98" y1="118" x2="76" y2="118" stroke="#f5c033" stroke-width="2.6"
        marker-end="url(#prs1-ar)"/>
  <line x1="216" y1="118" x2="240" y2="118" stroke="#f5c033" stroke-width="2.6"
        marker-end="url(#prs1-ar)"/>

  <!-- bulge callout -->
  <text x="155" y="56" text-anchor="middle" font-size="10" font-weight="700"
        letter-spacing="1.2" fill="#e8d6b4">BOJO DA MARÉ</text>
  <path d="M126,60 L106,99 M184,60 L204,99" stroke="#e8d6b4" stroke-width=".9"
        opacity=".55" fill="none"/>

  <!-- Moon -->
  <circle class="pr-glow" cx="274" cy="118" r="26" fill="#e8d6b4" opacity=".18"/>
  <circle cx="274" cy="118" r="13" fill="#e8d6b4"/>
  <circle cx="270" cy="113" r="3.2" fill="#c2ab86"/>
  <circle cx="279" cy="122" r="2.3" fill="#c2ab86"/>
  <circle cx="271" cy="124" r="1.6" fill="#c2ab86"/>
  <text x="274" y="152" text-anchor="middle" font-size="10.5" font-weight="800"
        letter-spacing="2.2" fill="#fdf6ea">LUA</text>

  <text x="160" y="226" text-anchor="middle" font-size="9.8" font-weight="600"
        letter-spacing=".4" fill="#c2ac8c">Fora de escala: o bojo foi exagerado — sem exagero, não dá para ver.</text>
</svg>`;
}

/* --- 2. The tide enters the mouth; funnel + shallowing stacks the water ---- */
function svgMouth() {
  return `
<svg viewBox="0 0 320 240" role="img" aria-labelledby="prs2-t prs2-d" style="${SVG_FONT}">
  <title id="prs2-t">A maré entra pela foz</title>
  <desc id="prs2-d">Vista de cima: a maré do Atlântico entra pela foz, à direita. O canal
  afunila em direção ao rio, à esquerda, e as setas da maré se comprimem numa frente de espuma
  só. Abaixo, um corte mostra o fundo subindo rio acima.</desc>
  <defs>
    <linearGradient id="prs2-water" x1="1" y1="0" x2="0" y2="0">
      <stop offset="0" stop-color="#4d3116"/><stop offset=".45" stop-color="#8a5a28"/>
      <stop offset="1" stop-color="#c08a45"/>
    </linearGradient>
    <linearGradient id="prs2-deep" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#a8703a"/><stop offset="1" stop-color="#4d3116"/>
    </linearGradient>
    <marker id="prs2-ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="4.6" markerHeight="4.6" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="#f5c033"/>
    </marker>
    <marker id="prs2-arS" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5.5" markerHeight="5.5" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="#e8d6b4"/>
    </marker>
  </defs>

  <rect width="320" height="240" fill="#140c06"/>

  <!-- === plan view (looking straight down), y 0..150 === -->
  <rect x="0" y="0" width="320" height="150" fill="url(#prs2-water)"/>

  <!-- banks: jungle in near-black silhouette, ochre mud at the water line -->
  <path d="M0,0 H320 V4 C290,6 264,10 250,16 C214,28 176,30 140,36 C96,43 46,47 0,52 Z"
        fill="#101a10"/>
  <path d="M0,52 C46,47 96,43 140,36 C176,30 214,28 250,16 C264,10 290,6 320,4"
        fill="none" stroke="#8a5a28" stroke-width="3"/>
  <path d="M0,150 H320 V146 C290,144 264,140 250,134 C214,122 176,120 140,114 C96,107 46,103 0,98 Z"
        fill="#101a10"/>
  <path d="M0,98 C46,103 96,107 140,114 C176,120 214,122 250,134 C264,140 290,144 320,146"
        fill="none" stroke="#8a5a28" stroke-width="3"/>

  <!-- ocean tide arriving: wide, loose, spread out -->
  <g stroke="#f5c033" stroke-width="2" opacity=".8" marker-end="url(#prs2-ar)">
    <line x1="314" y1="48" x2="272" y2="52"/>
    <line x1="314" y1="74" x2="272" y2="74"/>
    <line x1="314" y1="100" x2="272" y2="96"/>
  </g>
  <!-- squeezed by the funnel -->
  <g stroke="#f5c033" stroke-width="2.4" opacity=".95" marker-end="url(#prs2-ar)">
    <line x1="258" y1="48" x2="216" y2="58"/>
    <line x1="258" y1="74" x2="216" y2="74"/>
    <line x1="258" y1="100" x2="216" y2="90"/>
  </g>

  <!-- the wave front: one line of foam across the whole channel -->
  <path d="M172,34 Q144,74 168,116" fill="none" stroke="#e8d6b4" stroke-width="15" opacity=".22"/>
  <path d="M172,34 Q144,74 168,116" fill="none" stroke="#e8d6b4" stroke-width="6" stroke-linecap="round"/>

  <!-- and one thick arrow ahead of it: everything is a single push now.
       Head drawn by hand — a marker would scale with the 9-wide stroke. -->
  <line x1="148" y1="74" x2="64" y2="74" stroke="#f5c033" stroke-width="9"/>
  <path d="M36,74 L66,60 L66,88 Z" fill="#f5c033"/>
  <text x="104" y="56" text-anchor="middle" font-size="12" font-weight="800"
        letter-spacing="1.8" fill="#f5c033">RIO ACIMA</text>

  <text x="150" y="22" text-anchor="middle" font-size="12" font-weight="800"
        letter-spacing="1.6" fill="#f5c033">O CANAL AFUNILA</text>
  <text x="306" y="30" text-anchor="end" font-size="11" font-weight="800"
        letter-spacing="1.8" fill="#f0dcb8">ATLÂNTICO</text>
  <text x="192" y="138" text-anchor="middle" font-size="10.5" font-weight="700"
        letter-spacing="1" fill="#e8d6b4">FRENTE DA ONDA</text>
  <path d="M178,131 L168,114" stroke="#e8d6b4" stroke-width="1.1" opacity=".7" fill="none"/>

  <!-- === section along the channel, y 160..240 === -->
  <line x1="0" y1="157" x2="320" y2="157" stroke="#f5c033" stroke-width="1" opacity=".25"/>
  <text x="160" y="174" text-anchor="middle" font-size="11" font-weight="800"
        letter-spacing="1.4" fill="#f5c033">…E O FUNDO SOBE</text>

  <path d="M0,186 H320 V234 C258,229 198,220 140,211 C96,204 46,200 0,198 Z" fill="url(#prs2-deep)"/>
  <path d="M0,240 H320 V234 C258,229 198,220 140,211 C96,204 46,200 0,198 V240 Z" fill="#241407"/>
  <path d="M0,198 C46,200 96,204 140,211 C198,220 258,229 320,234"
        fill="none" stroke="#c08a45" stroke-width="2"/>
  <line x1="0" y1="186" x2="320" y2="186" stroke="#f5e3c2" stroke-width="1.6" opacity=".8"/>

  <!-- depth gauges: deep at the sea end, shallow upriver.
       Plain caps, not arrowheads — the shallow one is 10 units tall and two
       heads that size simply collide into a blob. -->
  <g stroke="#f5c033" stroke-width="1.5">
    <line x1="288" y1="188" x2="288" y2="230"/>
    <line x1="283" y1="188" x2="293" y2="188"/><line x1="283" y1="230" x2="293" y2="230"/>
    <line x1="40" y1="188" x2="40" y2="199"/>
    <line x1="35" y1="188" x2="45" y2="188"/><line x1="35" y1="199" x2="45" y2="199"/>
  </g>
  <text x="60" y="196" font-size="9.5" font-weight="800" letter-spacing="1.2" fill="#f5c033">RASO</text>
  <text x="278" y="212" text-anchor="end" font-size="9.5" font-weight="800" letter-spacing="1.2" fill="#f5c033">FUNDO</text>
  <text x="160" y="228" text-anchor="middle" font-size="10" font-weight="700"
        letter-spacing=".8" fill="#f0dcb8">A ÁGUA NÃO TEM PARA ONDE ESCOAR</text>
</svg>`;
}

/* --- 3. The bore climbs the river against the current --------------------- */
function svgBore() {
  return `
<svg viewBox="0 0 320 240" role="img" aria-labelledby="prs3-t prs3-d" style="${SVG_FONT}">
  <title id="prs3-t">A onda sobe o rio</title>
  <desc id="prs3-d">Corte lateral ao pôr do sol: a frente abrupta da pororoca viaja para a
  esquerda, rio acima, contra a correnteza que desce para o mar. Atrás dela vem um trem de
  ondas menores. Um surfista minúsculo desce a face.</desc>
  <defs>
    <linearGradient id="prs3-sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2a1809"/><stop offset=".42" stop-color="#a04d14"/>
      <stop offset=".78" stop-color="#ff7a18"/><stop offset="1" stop-color="#ffb64a"/>
    </linearGradient>
    <!-- the river surface receding into the distance: pale, sun-glazed -->
    <linearGradient id="prs3-far" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#e0ab68"/><stop offset="1" stop-color="#b8813e"/>
    </linearGradient>
    <!-- the water body in section: much darker, so the wave reads as a mass -->
    <linearGradient id="prs3-water" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#96622a"/><stop offset=".45" stop-color="#6b4520"/>
      <stop offset="1" stop-color="#33200c"/>
    </linearGradient>
    <marker id="prs3-arD" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="#e8d6b4"/>
    </marker>
  </defs>

  <rect width="320" height="240" fill="#140c06"/>
  <rect width="320" height="72" fill="url(#prs3-sky)"/>
  <circle cx="254" cy="60" r="15" fill="#ffe6b0" opacity=".95"/>

  <!-- jungle in silhouette, the way the concept art has it -->
  <path d="M0,80 V60 c7,-4 12,2 18,-6 c6,-8 13,1 19,-3 c7,-5 13,6 21,2 c8,-4 13,5 21,2
           c8,-3 13,6 21,3 c10,-4 15,5 25,2 c10,-3 15,6 25,3 c10,-3 15,4 25,1
           c10,-3 15,6 25,3 c10,-3 15,4 25,1 c10,-3 19,7 29,4 c6,-2 10,-4 14,-6 V80 Z"
        fill="#101a10"/>
  <!-- a few palms breaking the canopy line -->
  <g fill="#101a10">
    <path d="M44,60 l1.6,-14 M45,46 c-5,-4 -9,-3 -11,1 c4,-2 8,-1 11,1 c3,-4 8,-5 12,-2 c-4,-3 -9,-3 -12,0 z"
          stroke="#101a10" stroke-width="1.6"/>
    <path d="M148,58 l1.4,-15 M149,43 c-6,-4 -10,-3 -12,2 c5,-3 9,-2 12,1 c4,-4 9,-5 13,-2 c-4,-3 -10,-4 -13,-1 z"
          stroke="#101a10" stroke-width="1.6"/>
    <path d="M296,60 l1.4,-13 M297,47 c-5,-4 -9,-3 -11,1 c4,-2 8,-1 11,1 c3,-4 8,-4 11,-2 c-3,-3 -8,-3 -11,0 z"
          stroke="#101a10" stroke-width="1.6"/>
  </g>
  <rect x="0" y="78" width="320" height="9" fill="#33200e"/>

  <!-- the river surface stretching away, ahead of the wave -->
  <rect x="0" y="86" width="320" height="154" fill="url(#prs3-far)"/>

  <!-- direction of travel: upriver, to the left.
       Arrowheads are drawn by hand — SVG markers scale with stroke-width, and an
       8-wide shaft turns a 5-unit marker into a 40-unit triangle that eats the label. -->
  <line x1="84" y1="112" x2="50" y2="112" stroke="#f5c033" stroke-width="8"/>
  <path d="M20,112 L52,99 L52,125 Z" fill="#f5c033"/>
  <text x="56" y="94" text-anchor="middle" font-size="12" font-weight="800"
        letter-spacing="1.8" fill="#f5c033"
        paint-order="stroke" stroke="#2a1608" stroke-width="3.4" stroke-linejoin="round">RIO ACIMA</text>

  <!-- the wave train behind the front -->
  <text x="252" y="98" text-anchor="middle" font-size="10.5" font-weight="700"
        letter-spacing="1.2" fill="#3a2410">TREM DE ONDAS</text>
  <path d="M196,104 H308 M196,104 V109 M308,104 V109"
        fill="none" stroke="#3a2410" stroke-width="1.2" opacity=".7"/>

  <!-- the bore: a step up in water level, a steep face, a decaying train -->
  <path d="M0,240 L0,170 C26,169 62,168 100,168 C112,168 118,165 124,158
           C131,148 138,124 150,108 C154,103 159,100 163,102
           C168,107 172,118 177,128 C183,140 191,144 199,137
           C205,132 208,120 214,118 C221,116 226,130 232,138
           C237,145 244,144 249,136 C253,130 256,123 261,122
           C267,121 271,131 276,137 C281,143 287,142 292,135
           C296,130 299,127 304,127 C309,127 314,132 318,134
           L320,135 L320,240 Z"
        fill="url(#prs3-water)"/>
  <!-- the still water level ahead of it: the step is the whole point -->
  <line x1="0" y1="168" x2="104" y2="168" stroke="#f5e3c2" stroke-width="1.6" opacity=".55"/>

  <!-- foam: cream, never white -->
  <path d="M122,161 C129,146 137,124 150,108 C154,103 159,100 163,102 C168,108 173,119 178,130"
        fill="none" stroke="#e8d6b4" stroke-width="10" opacity=".13" stroke-linecap="round"/>
  <path d="M123,159 C130,145 138,124 150,108 C154,103 159,100 163,102 C168,108 172,119 177,129"
        fill="none" stroke="#e8d6b4" stroke-width="5.4" stroke-linecap="round"/>
  <ellipse cx="131" cy="154" rx="7" ry="3.4" fill="#e8d6b4" opacity=".32"/>
  <ellipse cx="176" cy="131" rx="6" ry="3" fill="#e8d6b4" opacity=".3"/>
  <path d="M207,120 C211,117 218,117 222,121" fill="none" stroke="#e8d6b4" stroke-width="3"
        stroke-linecap="round" opacity=".8"/>
  <path d="M254,124 C258,121 264,121 268,125" fill="none" stroke="#e8d6b4" stroke-width="2.4"
        stroke-linecap="round" opacity=".6"/>
  <path d="M297,129 C300,127 305,127 308,129" fill="none" stroke="#e8d6b4" stroke-width="1.9"
        stroke-linecap="round" opacity=".45"/>

  <!-- the surfer, small on the face — the same scene the game renders.
       A cream halo underneath, or a dark silhouette on dark water disappears. -->
  <g transform="translate(145,137) rotate(-36) scale(1.4)">
    <g fill="none" stroke="#f5e3c2" stroke-width="4.6" stroke-linecap="round"
       stroke-linejoin="round" opacity=".5">
      <path d="M0,8.6 h.1 M1.6,-4.6 h.1"/>
      <path d="M1.4,-2.4 L0.4,2.6 L-3.4,7.6 M0.4,2.6 L4.4,7.8 M1.4,-1.8 L-4.6,.8 M1.4,-1.8 L6.6,0"/>
    </g>
    <ellipse cx="0" cy="9.6" rx="12" ry="2.8" fill="#f5e3c2" opacity=".7"/>
    <ellipse cx="0" cy="8.6" rx="10.6" ry="2" fill="#1a1006"/>
    <circle cx="1.6" cy="-4.6" r="2.3" fill="#1a1006"/>
    <path d="M1.4,-2.4 L0.4,2.6 L-3.4,7.6 M0.4,2.6 L4.4,7.8 M1.4,-1.8 L-4.6,.8 M1.4,-1.8 L6.6,0"
          fill="none" stroke="#1a1006" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>
  </g>

  <!-- height — stated the only honest way, qualitatively -->
  <g stroke="#f5c033" stroke-width="1.6">
    <line x1="108" y1="104" x2="108" y2="168"/>
    <line x1="102" y1="104" x2="114" y2="104"/>
    <line x1="102" y1="168" x2="114" y2="168"/>
  </g>
  <path d="M108,102 L104,112 L112,112 Z M108,170 L104,160 L112,160 Z" fill="#f5c033"/>
  <text transform="translate(96,136) rotate(-90)" text-anchor="middle" font-size="10"
        font-weight="800" letter-spacing="1.2" fill="#f5c033"
        paint-order="stroke" stroke="#2a1608" stroke-width="3" stroke-linejoin="round">ALGUNS METROS</text>

  <!-- and the current, running the other way -->
  <line x1="94" y1="196" x2="192" y2="196" stroke="#e8d6b4" stroke-width="2.6" opacity=".65"
        marker-end="url(#prs3-arD)"/>
  <text x="146" y="188" text-anchor="middle" font-size="10.5" font-weight="700"
        letter-spacing="1.4" fill="#e8d6b4" opacity=".9">A CORRENTEZA DESCE</text>

  <!-- riverbed: this is a section, and the wave is nearly as tall as the river is deep -->
  <path d="M0,240 H320 V231 C250,228 180,224 110,221 C72,219 34,218 0,217 Z" fill="#241407"/>
  <path d="M0,217 C34,218 72,219 110,221 C180,224 250,228 320,231"
        fill="none" stroke="#6b4520" stroke-width="1.8"/>

  <text x="160" y="235" text-anchor="middle" font-size="10" font-weight="600"
        letter-spacing=".3" fill="#dcc8a4" opacity=".95">Corte lateral: a onda vem do mar, à direita, e sobe contra a corrente.</text>
</svg>`;
}

/* ========================================================================== */
/* Copy — pt-BR, ~240 words total                                              */
/* ========================================================================== */

const ACTS = [
  {
    n: '01',
    title: 'A Lua puxa o oceano',
    svg: svgTide,
    body: `
      <p>A gravidade da <b>Lua</b> estica o oceano dos dois lados do planeta. O <b>Sol</b>
      puxa também, com menos força.</p>
      <p>Quando Sol, Terra e Lua se alinham — na <b>lua nova</b> e na <b>lua cheia</b> — os
      dois puxões somam. É a <b>maré de sizígia</b>, a maior do mês, e é nela que a pororoca
      cresce.</p>`,
  },
  {
    n: '02',
    title: 'A maré entra pela foz',
    svg: svgMouth,
    body: `
      <p>Visto de cima: a maré cheia invade a foz do Amazonas, e o canal vai
      <b>afunilando</b> enquanto o fundo sobe.</p>
      <p>Sem largura para se espalhar nem profundidade para escoar, a água se empilha — e a
      maré inteira se resume a <b>uma frente só</b>.</p>`,
  },
  {
    n: '03',
    title: 'A onda sobe o rio',
    svg: svgBore,
    body: `
      <p>De lado: a frente abrupta avança <b>rio acima, contra a corrente</b>, puxando atrás
      um trem de ondas menores. É exatamente a onda do jogo.</p>
      <p>Não é só espetáculo: derruba barrancos, arranca árvores, muda o leito. No
      <b>Araguari</b>, no Amapá, ela deixou de acontecer depois que o rio foi alterado.</p>`,
  },
];

const FACTS = [
  {
    k: 'Quando',
    v: 'Lua nova e lua cheia. Fica maior perto dos <i>equinócios</i>, por volta de março e setembro.',
  },
  {
    k: 'Onde',
    v: 'Rios do Norte: Amazonas, Guamá, Capim, Mearim — e o <i>Arari</i>, que dá nome ao percurso do jogo.',
  },
  {
    k: 'Quanto dura',
    v: 'Uma onda de mar fecha em segundos; a pororoca segue por quilômetros. Em 2003, <i>Picuruta Salazar</i> surfou 12,5 km em 37 minutos no rio Guamá.',
  },
];

/* ========================================================================== */
/* Screen                                                                      */
/* ========================================================================== */

export class StoryScreen {
  constructor({ onClose } = {}) {
    this.onClose = onClose || (() => {});
    this.open = false;
    this.page = 0;
    this._lastFocus = null;
    this._ownsStyle = false;

    this._buildStyle();
    this._buildDom();

    // Capture phase, on window: while the story is open it must swallow ESC
    // before the pause menu's own window listener sees it, or closing the story
    // would also toggle the menu underneath.
    this._onKey = (e) => this._handleKey(e);
    window.addEventListener('keydown', this._onKey, true);
  }

  // ------------------------------------------------------------------ setup
  _buildStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
    this._styleEl = s;
    this._ownsStyle = true;
  }

  _buildDom() {
    const el = document.createElement('div');
    el.id = ROOT_ID;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'pr-story-title');
    el.setAttribute('aria-hidden', 'true');

    const cards = ACTS.map((a) => `
      <section class="slide" aria-label="Etapa ${a.n}: ${a.title}">
      <article class="card">
        <figure>${a.svg()}</figure>
        <div class="cap"><span class="step" aria-hidden="true">${a.n}</span><h3>${a.title}</h3></div>
        <div>${a.body}</div>
      </article>
      </section>`).join('');

    // As imagens ampliam a narrativa; os desenhos continuam logo abaixo para
    // explicar o fenômeno em etapas e manter todos os detalhes interativos.
    const art = `
      <section class="slide slide-art" aria-label="A onda da pororoca">
      <figure class="art hero">
        <img src="./assets/pororoca-historia.webp" loading="eager" decoding="async"
             alt="A pororoca ao pôr do sol: uma única onda atravessa o rio inteiro, com a lua cheia baixa no céu e um povoado de palafitas na margem." />
        <figcaption>A frente atravessa o rio de margem a margem. A lua no mesmo quadro não é enfeite &mdash; é ela que levanta a maré que empurra essa parede de água.</figcaption>
      </figure></section>
      <section class="slide slide-art" aria-label="Da Lua até o rio">
      <figure class="art diagram">
        <img src="./assets/pororoca-historia-infografico.webp" loading="lazy" decoding="async"
             alt="Infográfico em três partes: Sol, Terra e Lua alinhados deformando os oceanos; a maré entrando pela foz e afunilando; a onda subindo o rio contra a correnteza, com um surfista na face." />
        <figcaption>Da lua ao rio, em três passos.</figcaption>
      </figure></section>`;


    const facts = FACTS.map((f) => `
      <div class="fact"><b>${f.k}</b><span>${f.v}</span></div>`).join('');

    el.innerHTML = `
<div class="panel">
  <header class="head">
    <div class="kick">Entenda o fenômeno</div>
    <h2 id="pr-story-title">A história da pororoca</h2>
    <p class="lead">Pororoca é o nome amazônico do <b>macaréu</b>: a maré do Atlântico sobe
    rio adentro como uma parede de água. O nome vem do <b>tupi</b>, com o sentido de
    estrondo — ela é ouvida antes de ser vista.</p>
  </header>

  <div class="body">
    <div class="viewport">
      <div class="track">
        ${art}
        ${cards}
        <section class="slide" aria-label="Curiosidades sobre a pororoca">
          <div class="facts">${facts}</div>
        </section>
      </div>
    </div>
    <button type="button" class="nav prev" data-act="prev" aria-label="Tela anterior">&#10094;</button>
    <button type="button" class="nav next" data-act="next" aria-label="Próxima tela">&#10095;</button>
  </div>

  <footer class="foot">
    <span class="hint">&#8592; &#8594; navegar &middot; ESC para voltar</span>
    <span class="spacer"></span>
    <div class="pager" aria-live="polite">
      <div class="dots" aria-hidden="true"></div>
      <span class="page-n"></span>
    </div>
    <span class="spacer"></span>
    <button type="button" class="btn" data-act="close">Voltar</button>
  </footer>
</div>`;

    document.body.appendChild(el);
    this.el = el;
    this.panel = el.querySelector('.panel');
    this.bodyEl = el.querySelector('.body');
    this.trackEl = el.querySelector('.track');
    this.slides = [...el.querySelectorAll('.slide')];
    this.prevBtn = el.querySelector('[data-act=prev]');
    this.nextBtn = el.querySelector('[data-act=next]');
    this.pageN = el.querySelector('.page-n');
    this.dotsEl = el.querySelector('.dots');
    this.closeBtn = el.querySelector('[data-act=close]');

    this.dotsEl.innerHTML = this.slides.map(() => '<i class="dot"></i>').join('');
    this.dots = [...this.dotsEl.querySelectorAll('.dot')];
    this.prevBtn.addEventListener('click', () => this._setPage(this.page - 1));
    this.nextBtn.addEventListener('click', () => this._setPage(this.page + 1));
    this.closeBtn.addEventListener('click', () => this.hide());
    // Backdrop closes; the panel does not.
    el.addEventListener('mousedown', (e) => { if (e.target === el) this.hide(); });
  }

  // ------------------------------------------------------------------- keys
  _handleKey(e) {
    if (!this.open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.hide();
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      this._setPage(this.page + (e.key === 'ArrowRight' ? 1 : -1));
      return;
    }
    if (e.key !== 'Tab') return;

    // Focus trap. Nothing behind the modal should ever be reachable.
    const items = [...this.panel.querySelectorAll(FOCUSABLE)]
      .filter((n) => n.offsetParent !== null || n === document.activeElement);
    if (!items.length) { e.preventDefault(); return; }

    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;

    if (!this.panel.contains(active)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    } else if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
    e.stopPropagation();
  }

  // ------------------------------------------------------------------ state
  _setPage(next) {
    const last = Math.max(0, this.slides.length - 1);
    this.page = Math.max(0, Math.min(last, Math.round(Number(next) || 0)));
    this.trackEl.style.transform = `translateX(${-this.page * 100}%)`;
    this.prevBtn.disabled = this.page === 0;
    this.nextBtn.disabled = this.page === last;
    this.pageN.textContent = `${this.page + 1} / ${last + 1}`;
    this.slides.forEach((slide, i) => slide.setAttribute('aria-hidden', i === this.page ? 'false' : 'true'));
    this.dots.forEach((dot, i) => dot.classList.toggle('on', i === this.page));
  }

  toggle() { this.open ? this.hide() : this.show(); }

  show() {
    if (this.open) return;
    this.open = true;
    this._lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // The player needs the cursor back to click "Voltar".
    if (document.pointerLockElement) document.exitPointerLock?.();
    this.el.classList.add('on');
    this.el.setAttribute('aria-hidden', 'false');
    this._setPage(0);
    this.nextBtn.focus({ preventScroll: true });
  }

  hide() {
    if (!this.open) return;
    this.open = false;
    this.el.classList.remove('on');
    this.el.setAttribute('aria-hidden', 'true');
    if (this._lastFocus && document.contains(this._lastFocus)) {
      this._lastFocus.focus({ preventScroll: true });
    }
    this._lastFocus = null;
    this.onClose();
  }

  dispose() {
    window.removeEventListener('keydown', this._onKey, true);
    this.el?.remove();
    if (this._ownsStyle) this._styleEl?.remove();
    this.el = this.panel = this.bodyEl = this.trackEl = this.closeBtn = null;
    this.prevBtn = this.nextBtn = this.pageN = this.dotsEl = null;
    this.slides = this.dots = null;
  }
}

export default StoryScreen;
