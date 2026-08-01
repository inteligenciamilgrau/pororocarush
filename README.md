# Pororoca Rush

Jogo de surf na **pororoca** — a onda que sobe o rio na Amazônia e não fecha nunca.
Você corre a face barrenta ao pôr do sol, enfia o tubo onde o lábio joga, solta aéreos
e desvia dos troncos, enquanto os checkpoints passam.

Feito em **Three.js**, sem bundler, sem build. É um site estático: abrir o
`index.html` num servidor já é o jogo.

**[▶ Jogar](https://inteligenciamilgrau.github.io/pororocarush/)**

---

## Controles

| Tecla | Ação |
| --- | --- |
| `A` `D` ou `←` `→` | Direção — inclina a prancha no rail |
| `W` ou `↑` | Acelerar. Na face, no ritmo certo, isso é o **bombeio** |
| `S` ou `↓` | Frear e abrir a curva |
| `SHIFT` | Agachar — encaixa no tubo |
| `ESPAÇO` | Aéreo — solta do lábio em velocidade |
| `Q` `E` | Girar no ar (360 · 540 · 720) |
| `G` | Grab — segura o rail no ar, multiplica a nota |
| `C` | Trocar câmera (5 de trás + frente, lado, aérea) |
| `P` ou `ESC` | Menu de opções |
| `R` | Voltar pro pocket |

Gamepad também funciona (analógico esquerdo, RT/LT, A/B/X).

## Como surfar

A física é a de uma encosta em movimento, e o jogo inteiro sai disso:

- **Fique no pocket**, logo à frente da crista. É onde a água te carrega e a
  velocidade se sustenta.
- Subir em direção ao lábio **custa** velocidade; descer a face **devolve**.
  Bombear é fazer isso no ritmo — martelar a tecla não adianta.
- **Trimar** quase paralelo à crista é mais rápido que apontar morro abaixo.
- Carvar forte **raspa** velocidade. Vale pelos pontos, não pela pressa.
- Alto demais e você passa por cima da onda; baixo demais e ela te alcança.
  Os dois perdem o combo.

## Rodar localmente

```bash
npm install          # three (para vendorizar) + playwright (ferramentas)
npm run serve        # http://127.0.0.1:5179/
```

No Windows, `JOGAR.bat` faz tudo: acha o Node sozinho, sobe o servidor e abre o
navegador. Se o Node não estiver no PATH, aponte com `set POROROCA_NODE=C:\...\node.exe`.

O jogo em si **não precisa de `node_modules`** — o subconjunto do Three.js que ele
usa (11 arquivos, 2 MB) está em `vendor/three/`, gerado por `node tools/vendor.mjs`.
Qualquer servidor estático serve.

## Estrutura

```
index.html            shell, import map, tela de boot
src/
  main.js             bootstrap + loop de passo fixo (1/120 s)
  config.js           todos os tunables num lugar só
  core/               state, bus, rng determinístico, input
  wave/               bore.js (campo da onda), waveMesh.js, foam.js
  world/              river.js, scenery.js, obstacles.js
  player/             physics.js, tricks.js, surfer.js
  game/               camera.js, scoring.js, race.js
  gfx/                sky.js, lighting.js, post.js
  hud/                hud.js, hud.css, menu.js
vendor/three/         subconjunto vendorizado do Three.js
tools/                servidor, capturas, playtest, comparação cega
docs/                 ARCHITECTURE.md (o contrato), ESTADO.md (handoff)
```

Dois invariantes sustentam o projeto:

1. **Paridade CPU/GPU da onda.** `src/wave/bore.js` é a única fonte de verdade da
   geometria e exporta o GLSL espelhando a matemática JS. Se os dois divergirem, o
   surfista flutua acima ou afunda dentro da malha.
2. **Determinismo.** Zero `Math.random()` na simulação e na geração de mundo — só o
   RNG semeado de `src/core/rng.js`. É o que faz duas capturas no mesmo instante de
   simulação serem comparáveis entre versões.

## Ferramentas de desenvolvimento

```bash
node tools/check.mjs                  # boota headless: erros, NaN, tela preta
node tools/playtest.mjs               # 7 perfis de jogada, métricas de mecânica
node tools/shots.mjs --v v2           # captura os 4 ângulos em 1672×941
node tools/glare.mjs                  # mede estouro de brilho contra o sol
node tools/blind.mjs --v v2           # monta comparação cega com a arte conceito
node tools/pagescheck.mjs --url ...   # valida o boot como o GitHub Pages serve
```

As capturas saem no mesmo tamanho das imagens conceito de propósito: a revisão
visual é feita **às cegas**, e o avaliador não pode distinguir os dois pelo formato.

## Publicar no GitHub Pages

O repositório já é um site estático pronto. Em **Settings → Pages**, escolha a branch
`main` e a pasta `/ (root)`. O `.nojekyll` garante que nada seja filtrado.

## Créditos

Three.js sob licença MIT — veja `vendor/three/LICENSE`.
Fontes Barlow Condensed e Archivo Black via Google Fonts.
