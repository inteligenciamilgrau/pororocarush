# ESTADO DO PROJETO — retomada após corte de sessão

> Documento de handoff. Se a sessão morreu, **comece por aqui**, depois leia
> `docs/ARCHITECTURE.md` (o contrato) e só então mexa em código.
> Última atualização: fim da Fase 1 (implementação paralela dos módulos).

---

## 1. Ambiente

Node 18+ e as dependências do projeto:

```bash
npm install          # three + playwright
npx playwright install chromium
```

Se o `node` não estiver no PATH (é o caso na máquina de desenvolvimento original,
onde há uma distribuição portátil numa pasta `apps/` vizinha), prefixe os comandos:

```bash
export PATH="/caminho/para/node-vXX-win-x64:$PATH"
```

`JOGAR.bat` descobre o node sozinho: `%POROROCA_NODE%`, depois `./node/`, depois o
PATH, depois `%ProgramFiles%\nodejs`, depois qualquer `node-*` numa pasta `apps/`
próxima. Não há caminho pessoal gravado em nenhum arquivo.

- Playwright + chromium headless-shell são instalados em `node_modules`.
- WebGL2 headless funciona via SwiftShader (float buffers + anisotropia OK).
  Flags obrigatórias: `--use-angle=swiftshader --enable-unsafe-swiftshader`.

## 2. Comandos

```bash
node tools/serve.mjs 5179 &          # servidor estático (precisa estar de pé p/ o resto)
node tools/check.mjs                 # boota headless, reporta erros de console/boot/NaN/tela preta
node tools/playtest.mjs              # 7 perfis de jogada, métricas de mecânica -> shots/playtest.json
node tools/playtest.mjs --film shots/v1/filmstrip --frames 8 --cam chase
node tools/shots.mjs --v v1          # captura os 4 ângulos em 1672x941 -> shots/v1/
node tools/blind.mjs --v v1          # monta o teste cego A/B -> compare/v1/<angulo>/{A,B}.png
node tools/snapshot.mjs --v v1 --note "..."   # congela o código em versions/v1/
```

`check.mjs` sai com código 0 só se: nenhum erro de página, nenhum 404, nenhum NaN
no estado do jogador, e o frame não está preto nem chapado.

## 3. Onde o trabalho parou

**Fase 1 (MECÂNICA) — implementação paralela concluída pelo workflow
`wf_3f76fa94-9b0`** (13 agentes de implementação + 3 de revisão).
Script do workflow salvo em
`~/.claude/projects/<proj>/1cfac7d6-.../workflows/scripts/pororoca-rush-fase1-mecanica-wf_3f76fa94-9b0.js`
— dá para retomar com `Workflow({scriptPath, resumeFromRunId:"wf_3f76fa94-9b0"})`;
os relatórios de cada agente estão no `journal.jsonl` do transcript dir.

### Módulos no disco no momento do handoff

Prontos (tamanho indica implementação real, não esqueleto):

| Arquivo | bytes |
|---|---|
| `src/wave/bore.js` | 38.115 |
| `src/wave/waveMesh.js` | 30.086 |
| `src/player/physics.js` | 39.535 |
| `src/player/tricks.js` | 36.459 |
| `src/player/surfer.js` | 36.294 |
| `src/world/obstacles.js` | 40.662 |
| `src/world/river.js` | 33.983 |
| `src/world/scenery.js` | 73.107 |
| `src/game/camera.js` | 28.375 |
| `src/game/race.js` | 12.070 |
| `src/game/scoring.js` | 10.034 |

**Ainda não gravados** (agentes estavam rodando quando a sessão foi cortada):
`src/wave/foam.js`, `src/gfx/sky.js`, `src/gfx/lighting.js`, `src/gfx/post.js`,
`src/hud/hud.js`, `src/hud/hud.css`.

⚠️ `src/main.js` importa **todos** eles estaticamente — enquanto qualquer um faltar,
o jogo **não boota** e `tools/check.mjs` falha no import. Duas saídas:
(a) retomar o workflow `wf_3f76fa94-9b0` para que os agentes pendentes terminem, ou
(b) escrever os que faltam à mão seguindo §3.9 do `ARCHITECTURE.md` (todos têm a mesma
forma: `constructor(ctx)`, `step(dt)`, `dispose()`; `Post` também precisa de
`render()` e `setSize(w,h)`, e **`render()` é o único ponto de desenho do jogo** —
sem ele a tela fica preta).

Os relatórios individuais de cada agente (o que cada um implementou, premissas e
preocupações) estão em `journal.jsonl` no transcript dir do workflow:
`~/.claude/projects/<proj>/1cfac7d6-.../subagents/workflows/wf_3f76fa94-9b0/`.

### O QUE FALTA (na ordem)

1. **Integrar**: subir o servidor, rodar `node tools/check.mjs`, corrigir os erros
   cruzados entre módulos até bootar limpo. Os 13 agentes escreveram sem se ver —
   espere divergências de fronteira.
2. **Playtest** (`tools/playtest.mjs`) e ajustar a física até os alvos da §5.
3. **Capturar v1** + filmstrip, `snapshot --v v1`.
4. **PARAR E PERGUNTAR AO USUÁRIO** se a mecânica está certa.
   ⚠️ Isto é uma exigência explícita dele: *"Antes de fazer melhorias gráficas,
   verifique com o usuário se a mecânica do jogo está correta! Para evitar ficar
   fazer um jogo bonito que não funciona."* **Não pule esta etapa.**
5. Só então **Fase 2**: loop de polimento gráfico com o crítico cego (§6).

## 4. Arquitetura em uma tela

Three.js r180, ES modules, **sem bundler**. `index.html` tem importmap para
`three` e `three/addons/`. `src/main.js` constrói tudo nesta ordem e chama
`step(dt)` em todos:

```
sim:  input -> physics -> tricks -> scoring -> race -> obstacles
view: waveMesh, river, scenery, surfer, foam, sky, lighting, cameraRig, post, hud
```

Sistema de coordenadas (o que mais confunde): **+Z é o sentido em que a pororoca
sobe o rio**, +X é lateral, +Y é cima, `y=0` é o nível de repouso.
`d = z - crest(x,t)`: `d=0` é o lábio, `d>0` é a face surfável descendo até a água
plana à frente, `d<0` é a espuma quebrada atrás. `faceT = d/faceLen` (0 lábio, 1 base).

**Dois invariantes que não podem quebrar:**
- **Paridade CPU/GPU**: `src/wave/bore.js` é a única fonte de verdade da geometria da
  onda e exporta `BoreWave.GLSL` espelhando exatamente a matemática JS. Se divergirem,
  o surfista flutua acima ou afunda dentro da malha. `waveMesh.js` **tem** que usar
  esse GLSL, nunca reimplementar a onda.
- **Determinismo**: zero `Math.random()` na simulação e na geração de mundo — só
  `src/core/rng.js` com semente de `CONFIG.seed`. É o que faz `v2/chase.png` ser o
  *mesmo instante* de `v1/chase.png`; sem isso a comparação entre versões é ruído.

Arquivos do integrador, que agentes de módulo **não podem editar**:
`src/main.js`, `src/capture.js`, `src/config.js`, `src/core/*`.

## 5. Alvos de mecânica (o que "correto" significa)

| Métrica | Alvo |
|---|---|
| Velocidade de cruzeiro em trim | 14–20 m/s (50–72 km/h — bate com o HUD conceito: 68/72) |
| Velocidade de pico | ~24 m/s |
| Carve completo (lock-to-lock) | ~0,9 s |
| Tempo de voo num aéreo | 0,8–1,6 s |
| Jogador razoável fica na onda | > 60 s sem cair |
| NaN em qualquer estado | **zero** (blocker) |
| Draw calls / triângulos da onda | < 400 / < 260k |

Sensações que precisam **emergir da física**, não estar hard-coded: trimar rápido
paralelo à crista; bombear no ritmo ganha velocidade e mash não ganha; carvar forte
raspa velocidade; sair do pocket é sentido; perder a onda é culpa legível do jogador
(alto demais passa por cima, baixo demais a onda engole).

## 6. Fase 2 — o loop do crítico cego (como o usuário pediu)

Ele exigiu um avaliador **extremamente rigoroso** que compare o jogo com as imagens
conceito **lado a lado sem saber qual é qual** e diga qual parece melhor.

Mecânica já construída para isso:
- As capturas saem em **1672×941**, exatamente o tamanho das imagens conceito — o
  crítico não consegue identificar pelo formato.
- `tools/blind.mjs` sorteia com moeda criptográfica (`randomBytes`, não semeado, para
  não ser inferível entre rodadas) e copia as duas imagens como `A.png`/`B.png`.
- O **gabarito vai para fora da árvore do projeto** (scratchpad da sessão), então o
  crítico não tropeça nele: `.../scratchpad/blind-key-<v>.json`.
- O crítico recebe só o diretório `compare/<v>/<angulo>/`, julga, e **eu** confiro
  o gabarito depois.

Critério de parada: o crítico precisa preferir o frame do jogo (ou empatar) em todos
os 4 ângulos, e os agentes de área precisam estar satisfeitos. Enquanto não for isso,
continua iterando: v2, v3, v4…

Pares ângulo ↔ conceito:
`chase↔capa`, `frente↔frente`, `lado↔lado`, `cima↔cima`.

## 7. Mapa de arquivos

```
index.html              shell, importmap, tela de boot, captura de erro fatal
src/main.js             bootstrap + loop (passo fixo 1/120) [INTEGRADOR]
src/capture.js          window.PR_CAPTURE.seek(t) determinístico [INTEGRADOR]
src/config.js           TODOS os tunables [INTEGRADOR]
src/core/{state,bus,rng,input}.js
src/wave/{bore,waveMesh,foam}.js
src/world/{river,scenery,obstacles}.js
src/player/{physics,tricks,surfer}.js
src/game/{camera,scoring,race}.js
src/gfx/{sky,lighting,post}.js
src/hud/{hud.js,hud.css}
tools/{serve,check,shots,shot,playtest,blind,snapshot}.mjs
docs/ARCHITECTURE.md    O CONTRATO — leia inteiro antes de codar
imagens_conceito/*.png  a especificação visual (4 frames)
shots/vN/               capturas por versão
versions/vN/            código congelado por versão
compare/vN/<angulo>/    pares cegos A/B
```

## 8. Pedidos explícitos do usuário (não perder de vista)

- Jogo de surf na **pororoca do norte do Brasil**, com **tubos e manobras**.
- Qualidade **AAA** em tudo: texturas, física, e todo o resto.
- **Three.js**.
- Trabalho **distribuído entre vários subagentes**, cada um cuidando de uma parte.
- Usar **/loop** em cada item até ficar perfeito.
- Um subagente **avaliador visual separado**, crítico extremamente rigoroso, que
  continua trabalhando enquanto algo não parecer AAA.
- Comparação **cega, lado a lado**, com as imagens conceito.
- **Shots com as versões** (v1, v2, v3…) para acompanhar a evolução.
- **Validar a mecânica com o usuário ANTES do polimento gráfico.**
- Interface e textos do jogo em **português**.
