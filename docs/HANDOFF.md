# POROROCA RUSH — o que falta fazer

> Documento de passagem de bastão. Escrito para outro agente terminar o trabalho.
> Leia inteiro antes de tocar em código. Depois leia `docs/ARCHITECTURE.md` (o contrato).
> **Nada abaixo da seção 4 foi testado** — o autor anterior ficou sem orçamento e
> entregou sem validar. Trate como não verificado até rodar.

---

## 1. Ambiente

```bash
export PATH="/caminho/para/node-vXX-win-x64:$PATH"   # nada está no PATH desta máquina
cd <raiz do projeto>
npm install                    # three + playwright (só para as ferramentas)
npx playwright install chromium
```

Na máquina original o Node portátil está em
`C:\Users\BobGreen\Documents\PythonScripts\projetos_IA\apps\node-v24.15.0-win-x64\`.
`JOGAR.bat` descobre o Node sozinho e sobe o jogo.

O **jogo em si não precisa de `node_modules`**: o subconjunto usado do three.js está
vendorizado em `vendor/three/` (11 arquivos, 2 MB), gerado por `node tools/vendor.mjs`.
É um site estático puro — serve a pasta e funciona, inclusive no GitHub Pages.

## 2. Ferramentas (todas já existem e funcionam)

```bash
node tools/serve.mjs 5179          # servidor; --root <dir> serve de outra raiz
node tools/check.mjs               # boot headless: erros, NaN, tela preta. PORTÃO PRINCIPAL
node tools/playtest.mjs            # 7 perfis de jogada, métricas de mecânica
node tools/playtest.mjs --film shots/_tira --frames 10 --cam chase
node tools/shots.mjs --v v2        # captura os 4 ângulos em 1672x941
node tools/shot.mjs --out x.png --cam chase --t 12
node tools/glare.mjs               # mede estouro de brilho contra o sol
node tools/glaretune.mjs           # busca por descida coordenada dos parâmetros de brilho
node tools/refglare.mjs            # mede as imagens conceito (o alvo)
node tools/camsteer.mjs            # prova se o teclado move a câmera
node tools/casecheck.mjs           # caixa alta/baixa nos imports (quebra no Linux/Pages)
node tools/pagescheck.mjs --url .. # valida o boot como o GitHub Pages serve
node tools/blind.mjs --v v2        # monta a comparação cega com a arte conceito
node tools/snapshot.mjs --v v2     # congela o código em versions/v2/
node tools/vendor.mjs              # revendoriza o three
```

## 3. Armadilhas já descobertas — **cada uma custou horas**

1. **`localStorage` é por origem e sobrevive à limpeza de cache.** Uma preferência de
   câmera salva em `127.0.0.1` fez o jogo parecer ignorar correções por várias rodadas,
   enquanto a mesma build no GitHub Pages funcionava. Já existe versionamento
   (`OPTS_VERSION` em `src/hud/menu.js`) — **incremente-o** ao mudar qualquer padrão.
   Em teste headless: `context.addInitScript(() => localStorage.clear())`.
2. **`PR_CAPTURE.seek()` tem deriva residual.** Foi corrigido para restaurar um snapshot,
   mas três `seek(12)` no mesmo boot ainda dão x = 99,59 / 96,29 / 95,91.
   **Recarregue a página entre amostras** ao medir. Não confie em duas medições no
   mesmo boot — isso já invalidou silenciosamente uma investigação inteira de câmera.
3. **O menu de primeira visita pausa o jogo.** Em teste headless, sete
   `localStorage['pororoca.seen']='1'` via `addInitScript`, senão a simulação congela e
   tudo mede igual.
4. **Ao medir uma série, imprima a série inteira.** Olhar só min/max fez o autor
   anterior perseguir 3 outliers achando que eram regra, quando 5 de 8 amostras
   estavam perfeitas.
5. **Mundo +X cai na ESQUERDA da tela** (a câmera olha em +Z num sistema destro).
   Já mordeu o projeto três vezes: inversão do A/D, do giro no ar e do eixo X do mouse.
   Todas corrigidas em `src/core/input.js`, na fronteira de entrada.
6. **Há um hook/formatador que reverte edições em `src/hud/story.js`.** Ele desfez
   alterações duas vezes. Depois de editar esse arquivo, **confirme com `grep` que a
   mudança sobreviveu.**

## 4. Estado atual — o que já funciona

8 commits locais, **nada publicado**. Remote configurado:
`https://github.com/inteligenciamilgrau/pororocarush.git`
O push nunca foi autorizado pelo usuário — **pergunte antes de publicar**.

Pronto e verificado:
- 16 módulos de jogo, física de surf, manobras, tubo, obstáculos, pontuação, corrida
- HUD reproduzindo a arte conceito (pontuação, combo, velocidade, bússola, minimapa)
- Menu de opções (`ESC`/`P`) com controles, opções e dicas; tudo persistido e ligado
- 9 modos de câmera; 5 traseiros travados atrás e sem auto-movimento
- Mouse controla a câmera (pointer lock por padrão, roda dá zoom, `V` gira 180°)
- Legibilidade contra o sol corrigida: de 19,7% de pixels estourados para ~0%
- `JOGAR.bat`, favicon, README, `.gitignore`, pronto para GitHub Pages (validado
  em subcaminho, sem caminhos absolutos, sem divergência de caixa)
- Tela de abertura + tela da história com as imagens geradas pelo usuário
- `src/world/gates.js` (percurso de 12 portais de boias) — **entregue, não validado**

---

## 5. O QUE FALTA — em ordem de importância

### 5.1 Física do bolso da onda — **o item mais importante do projeto**

O jogador estaciona em `d ≈ 10`, onde a face já caiu para ~0,1 m de altura e ~5° de
inclinação. Ele surfa a parte rasa em vez do bolso. Medição real, `t=20 s`:

```
d = -10 → y = 0,89 m      d = +10 → y = 0,10 m   ← o jogador fica aqui
d =  -5 → y = 1,32 m      d = +15 → y = 0,09 m
d =   0 → y = 1,93 m (crista)
d =  +5 → y = 0,44 m
```

Contrato (`docs/ARCHITECTURE.md` §3.1/§3.2) pede: amplitude 3,1 m, face de 26 m,
inclinação máxima 55–70° na parte tubular. Entregue: 1,88 m, face útil ~5 m, 4,9°.

**Sem isso não existe tubo nem manobra de parede** — é o que separa "deslizar num rio"
de "surfar a pororoca". Provavelmente é preciso mexer nos dois lados:
`src/wave/bore.js` (onda fraca demais) e `src/player/physics.js` (o equilíbrio de
forças estaciona o jogador longe da crista). **Atenção à paridade CPU/GPU**: `bore.js`
exporta `BoreWave.GLSL` espelhando a matemática JS, e `waveMesh.js` usa esse GLSL.
Se mudar a matemática num lado e não no outro, o surfista flutua acima ou afunda
dentro da malha.

Alvos de aceite: `d` médio entre 2 e 6; inclinação sob o jogador > 25° a maior parte
do tempo; tempo em tubo > 0 numa corrida de 60 s.

### 5.2 Validar o percurso de boias

`src/world/gates.js`, `race.js`, `scoring.js` e `hud.js` foram alterados por agentes e
**a integração nunca rodou**. Verificar:
- `node tools/check.mjs` dá `ok: true`?
- `state.race.checkpoint` bate com o número de eventos `gate:pass`?
- Algum portal é atravessado sem emitir evento (tunelamento)? A detecção precisa ser
  por **cruzamento de plano** entre o frame anterior e o atual, não por distância —
  a 24 m/s um teste de proximidade deixa passar.
- Os portais estão na parte surfável da onda, ou caíram em água plana / na espuma?
- A seta do HUD aponta para o próximo portal?

### 5.3 Fase 2 — o loop de polimento gráfico com crítico cego

**Isto é um pedido explícito do usuário e nunca foi executado.** Nas palavras dele:

> "Não pare até que cada subagente esteja completamente impressionado com a qualidade,
> comparando o resultado com as imagens conceito. Ele deve literalmente comparar os
> dois lado a lado, sem saber qual é qual, e dizer qual parece melhor."

A infraestrutura está pronta:
- As capturas saem em **1672×941**, exatamente o tamanho das imagens conceito, para o
  crítico não identificar pelo formato.
- `tools/blind.mjs` sorteia com moeda criptográfica (`randomBytes`, não semeado, para
  não ser inferível entre rodadas) e copia as duas como `A.png`/`B.png`.
- **O gabarito vai para fora da árvore do projeto** (`os.tmpdir()/pororoca-blind-keys`),
  para o crítico não tropeçar nele.
- O crítico recebe só o diretório `compare/<v>/<ângulo>/`, julga, e o integrador
  confere o gabarito depois.

Ciclo: `shots.mjs --v vN` → `blind.mjs --v vN` → crítico julga → agentes de área
corrigem → `snapshot.mjs --v vN` → repete com `vN+1`.
Critério de parada: o crítico prefere o frame do jogo (ou empata) nos 4 ângulos.

Pares: `chase↔capa`, `frente↔frente`, `lado↔lado`, `cima↔cima`.

Lacunas visuais já conhecidas, levantadas pelos próprios agentes:
- **Sem antialiasing** — passar pelo composer descarta o MSAA do canvas. Conserto:
  um `FXAAPass` depois do grade pass. Um crítico cego vai reclamar disso.
- **Fontes vêm do Google Fonts**; sem rede, a captura cai para Arial Narrow/Impact e
  a tipografia do HUD não é a final. Embutir as duas fontes em base64 no `hud.css`
  deixaria as capturas estáveis. **Isso afeta diretamente a comparação cega.**
- O logo "POROROCA" é Archivo Black inclinada, não o brush script da arte conceito.
  Conserto sem asset binário: traçar o letreiro como paths SVG.
- Cenário é low-poly e lê como manchas; selva, palafitas e barcos precisam de
  silhueta e textura melhores.
- Sombras: quase nada recebe sombra (`waveMesh` e `scenery` estão com
  `receiveShadow=false`), e mesmo assim se paga um depth pass 2048² por frame.
  Ou fazer valer, ou desligar.

### 5.4 Câmera — resíduo medido

`node tools/camsteer.mjs` ainda acusa **5,50 m** de diferença entre duas corridas com
direção oposta. O acoplamento com o *heading* já saiu (as traseiras se ancoram na
tangente do rio). O que sobra são **três termos dependentes de posição**:
1. `river.tangent(pz)` é avaliada onde o jogador está, e o rio serpenteia;
2. `_faceFloor()` empurra o rig para manter distância do lábio;
3. `_clearance()` levanta a câmera conforme a água embaixo dela.

Para ficar realmente imóvel, congele os três ou avalie-os num referencial que não
dependa da posição do jogador.

### 5.5 Pendências menores

- **Pontos de tubo podem estar sendo contados em dobro**: `tube:exit.points` e o
  `trick:land.points` pareado são **o mesmo número**, emitidos em sequência.
  `scoring.js` deve somar uma vez só. O autor de `tricks.js` sinalizou; nunca foi
  confirmado no código.
- **`physics.js` dispara `this.launch(1)` sozinho** em `input.jumpPressed`, e roda
  antes de `tricks.js`. O power fixo=1 vence e o power proporcional à velocidade
  vertical que `tricks.js` calcula é descartado.
- `foam.js` usa `CONFIG.look.sunElevation/sunAzimuth` em vez da direção real do sol
  criada por `sky.js` — a bruma acende no ângulo errado se os dois divergirem.
- Ninguém validou o jogo com **gamepad**.
- `versions/` e `shots/` estão no `.gitignore`; o usuário pediu capturas por versão
  (v1, v2, v3…) para acompanhar a evolução — decida com ele se entram no repositório.

---

## 6. Regras do projeto (não quebre)

1. **Determinismo**: zero `Math.random()` em simulação ou geração de mundo. Só o RNG
   semeado de `src/core/rng.js`. É o que faz duas capturas no mesmo instante serem
   comparáveis entre versões — sem isso o loop da Fase 2 avalia sorte, não progresso.
2. **Paridade CPU/GPU da onda**: `bore.js` é a única fonte de verdade e exporta o GLSL
   espelhado. `waveMesh.js` nunca reimplementa a onda.
3. **Sem CDN e sem dependência nova em runtime.** Texturas são procedurais. As duas
   únicas imagens são `assets/*.webp` (360 KB), da tela de história.
4. **Tudo integrado por `dt`.** Nada dependente de framerate.
5. Código e nomes em inglês; **todo texto de tela em português do Brasil**.
6. `src/main.js`, `src/capture.js`, `src/config.js` e `src/core/*` são do integrador —
   agentes de módulo não editam.
7. Orçamento: < 400 draw calls, malha da onda < 260k triângulos. O harness de captura
   roda em GL por **software**; algo caro demais inviabiliza todo o loop de revisão.

## 7. Pedidos originais do usuário, para conferir no fim

- Jogo de surf na pororoca do norte do Brasil, com **tubos e manobras** ✅ (tubo e
  manobras existem em código; na prática dependem de 5.1)
- Qualidade **AAA** em tudo ❌ (é a Fase 2, item 5.3)
- **Three.js** ✅
- Trabalho **distribuído entre subagentes** ✅
- Um **avaliador visual rigoroso**, comparação **cega lado a lado** ❌ (item 5.3)
- **Shots por versão** (v1, v2, v3…) ❌ (ferramenta pronta, nunca rodado o ciclo)
- **Validar a mecânica com o usuário antes do polimento gráfico** ✅ (feito, e foi
  assim que o problema 5.1 apareceu)
- Interface em **português** ✅
