# Layout Inspector

Script Node.js que inspeciona qualquer site via Playwright e extrai informações completas de layout, design e conteúdo — permitindo replicar interfaces web.

## O que extrai

| Categoria | Detalhes |
|-----------|----------|
| **Layout** | Hierarquia de containers flex/grid com todas as propriedades (direction, gap, align, justify, wrap, template-columns/rows) |
| **Tipografia** | Font-family, size, weight, line-height, letter-spacing — rankeados por frequência |
| **Cores** | Text colors, background colors por seção, gradients |
| **Assets** | Imagens (src, alt, dimensões), SVGs, vídeos, backgrounds, logo do nav |
| **Conteúdo** | Headings, parágrafos, links, botões — organizados por seção |
| **Efeitos** | Box-shadows, border-radius, transitions |
| **Hover states** | Cor, transform, shadow antes/depois do hover em botões e links |
| **Animações** | @keyframes CSS, scroll-triggered (tipo inferido: fade-in, slide, scale) |
| **Responsivo** | Detecta breakpoints onde o layout muda (opcional) |

## Outputs

Cada análise gera 5 arquivos em `output/<dominio>/`:

```
output/stripe.com/
├── layout-report.json      # Relatório completo (árvore + tokens + content + animations)
├── layout-blueprint.css    # CSS copiável com classes nomeadas por seção
├── design-tokens.json      # Tipografia, cores, efeitos, animações
├── content-map.json        # Textos, imagens, links, botões por seção
└── layout-screenshot.png   # Screenshot anotado (grid=azul, flex=verde)
```

## Setup

```bash
cd layout-inspector
npm install
npx playwright install chromium
```

## Uso

```bash
node layout-inspector.js <url> [opções]
```

### Exemplos

```bash
# Análise completa (com breakpoints responsivos)
node layout-inspector.js https://stripe.com

# Só desktop, mais rápido
node layout-inspector.js https://stripe.com --no-responsive

# Viewport customizado
node layout-inspector.js https://exemplo.com --viewport 1440x900

# Salvar em outra pasta
node layout-inspector.js https://exemplo.com --output ./meus-reports

# Timeout maior para sites lentos
node layout-inspector.js https://exemplo.com --timeout 60000
```

### Opções

| Flag | Descrição | Default |
|------|-----------|---------|
| `--output`, `-o` | Diretório base de saída | `./output` |
| `--timeout`, `-t` | Timeout de navegação (ms) | `30000` |
| `--no-responsive` | Pular análise de breakpoints | `false` |
| `--viewport` | Viewport inicial (LxA) | `1920x1080` |
| `--breakpoints` | Larguras para testar (separadas por vírgula) | `320,480,640,768,1024,1280,1536,1920` |

## Como usar os outputs

### Para replicar um site

1. **`layout-blueprint.css`** — copie as classes como base da estrutura
2. **`design-tokens.json`** — extraia as fontes (Google Fonts), cores (variáveis CSS), e efeitos
3. **`content-map.json`** — monte o HTML com os textos, imagens (URLs do CDN), e links
4. **`design-tokens.json → animations`** — aplique as animações detectadas (fade-in, slide, scale)
5. **`layout-screenshot.png`** — use como referência visual

### Para estudar padrões de layout

O `layout-report.json` contém a árvore completa de containers. Útil para entender:
- Sistemas de grid (12 colunas, auto-fit, etc.)
- Padrões de espaçamento (gap, padding, margin)
- Hierarquia de componentes
- Breakpoints responsivos reais

## Limitações

- **Shadow DOM** — não penetra Web Components com shadow root fechado
- **Canvas/WebGL** — não extrai conteúdo de canvas (Three.js, jogos)
- **Animações JS runtime** — detecta o padrão (fade-in, slide) mas não o timing exato de animações controladas por JS (Webflow IX2, GSAP)
- **Lazy-load agressivo** — conteúdo que só carrega com scroll infinito pode não ser capturado
- **iframes cross-origin** — conteúdo de iframes externos é inacessível
- **Anti-scraping** — sites com Cloudflare challenge ou CAPTCHAs bloqueiam o acesso

## Tecnologias

- **Node.js** — runtime
- **Playwright** — automação de browser (Chromium headless)
- Zero dependências além do Playwright
