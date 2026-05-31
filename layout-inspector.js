const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DEFAULT_BREAKPOINTS = [320, 480, 640, 768, 1024, 1280, 1536, 1920];
const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };
const DEFAULT_TIMEOUT = 30000;

class LayoutInspector {
  constructor(options) {
    this.url = options.url;
    this.timeout = options.timeout || DEFAULT_TIMEOUT;
    this.viewport = options.viewport || { ...DEFAULT_VIEWPORT };
    this.breakpoints = options.breakpoints || [...DEFAULT_BREAKPOINTS];
    this.skipResponsive = options.skipResponsive || false;
    this.browser = null;
    this.page = null;

    const hostname = new URL(this.url).hostname.replace(/^www\./, '');
    const baseDir = options.outputDir || path.join(path.dirname(__filename), 'output');
    this.outputDir = path.join(baseDir, hostname);
    fs.mkdirSync(this.outputDir, { recursive: true });
  }

  async run() {
    try {
      await this.launch();
      console.log(`Analyzing layout: ${this.url}`);

      const layoutTree = await this.analyze();
      console.log(`Found ${this.countNodes(layoutTree)} layout containers`);

      let responsive = { breakpoints: [] };
      if (!this.skipResponsive) {
        console.log('Detecting responsive breakpoints...');
        responsive = await this.detectBreakpoints(layoutTree);
        await this.page.setViewportSize(this.viewport);
        await this.settle();
      }

      console.log('Extracting design tokens...');
      const tokens = await this.extractDesignTokens();

      console.log('Extracting content map...');
      const contentMap = await this.extractContentMap();

      console.log('Extracting interactive states...');
      const interactiveStates = await this.extractInteractiveStates();

      console.log('Rendering overlay and capturing screenshot...');
      await this.renderOverlay(layoutTree);
      await this.screenshot();

      const report = this.generateReport(layoutTree, responsive);
      report.designTokens = tokens;
      report.contentMap = contentMap;
      report.interactiveStates = interactiveStates;
      const jsonPath = path.join(this.outputDir, 'layout-report.json');
      fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf-8');

      const blueprint = this.generateBlueprint(layoutTree);
      const cssPath = path.join(this.outputDir, 'layout-blueprint.css');
      fs.writeFileSync(cssPath, blueprint, 'utf-8');

      const tokensPath = path.join(this.outputDir, 'design-tokens.json');
      fs.writeFileSync(tokensPath, JSON.stringify(tokens, null, 2), 'utf-8');

      const contentPath = path.join(this.outputDir, 'content-map.json');
      fs.writeFileSync(contentPath, JSON.stringify(contentMap, null, 2), 'utf-8');

      console.log(`Report saved: ${jsonPath}`);
      console.log(`Blueprint saved: ${cssPath}`);
      console.log(`Tokens saved: ${tokensPath}`);
      console.log(`Content map saved: ${contentPath}`);
      console.log(`Screenshot saved: ${path.join(this.outputDir, 'layout-screenshot.png')}`);
    } finally {
      await this.cleanup();
    }
  }

  async launch() {
    this.browser = await chromium.launch({ headless: true });
    const context = await this.browser.newContext({ viewport: this.viewport });
    this.page = await context.newPage();
    await this.page.goto(this.url, { waitUntil: 'networkidle', timeout: this.timeout }).catch(() =>
      this.page.goto(this.url, { waitUntil: 'domcontentloaded', timeout: this.timeout })
    );
    await this.settle();
  }

  async extractDesignTokens() {
    return this.page.evaluate(() => {
      const fonts = new Map();
      const colors = new Map();
      const bgColors = new Map();
      const shadows = new Set();
      const borders = new Set();
      const radii = new Set();
      const transitions = new Set();
      const gradients = new Set();

      const els = document.querySelectorAll('body *');
      for (const el of els) {
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') continue;

        const fontKey = `${s.fontFamily}|${s.fontSize}|${s.fontWeight}|${s.lineHeight}|${s.letterSpacing}`;
        if (!fonts.has(fontKey)) {
          fonts.set(fontKey, {
            fontFamily: s.fontFamily,
            fontSize: s.fontSize,
            fontWeight: s.fontWeight,
            lineHeight: s.lineHeight,
            letterSpacing: s.letterSpacing,
            count: 0,
            sampleTag: el.tagName.toLowerCase(),
            sampleText: el.textContent.trim().slice(0, 40),
          });
        }
        fonts.get(fontKey).count++;

        if (s.color && s.color !== 'rgba(0, 0, 0, 0)') colors.set(s.color, (colors.get(s.color) || 0) + 1);
        if (s.backgroundColor && s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent') {
          bgColors.set(s.backgroundColor, (bgColors.get(s.backgroundColor) || 0) + 1);
        }
        if (s.backgroundImage && s.backgroundImage !== 'none' && s.backgroundImage.includes('gradient')) {
          gradients.add(s.backgroundImage);
        }
        if (s.boxShadow && s.boxShadow !== 'none') shadows.add(s.boxShadow);
        if (s.borderRadius && s.borderRadius !== '0px') radii.add(s.borderRadius);
        if (s.transition && s.transition !== 'all 0s ease 0s' && s.transition !== 'none') transitions.add(s.transition);
        const border = `${s.borderWidth} ${s.borderStyle} ${s.borderColor}`;
        if (s.borderStyle !== 'none' && s.borderWidth !== '0px') borders.add(border);
      }

      const sortedFonts = [...fonts.values()].sort((a, b) => b.count - a.count).slice(0, 20);
      const sortedColors = [...colors.entries()].sort((a, b) => b[1] - a[1]).map(([color, count]) => ({ color, count })).slice(0, 20);
      const sortedBgColors = [...bgColors.entries()].sort((a, b) => b[1] - a[1]).map(([color, count]) => ({ color, count })).slice(0, 20);

      // Extract @keyframes and animation properties from stylesheets
      const animations = [];
      const keyframes = {};
      try {
        for (const sheet of document.styleSheets) {
          try {
            const rules = sheet.cssRules || sheet.rules;
            for (const rule of rules) {
              if (rule.type === CSSRule.KEYFRAMES_RULE) {
                const frames = [];
                for (const kf of rule.cssRules) {
                  frames.push({ offset: kf.keyText, style: kf.cssText });
                }
                keyframes[rule.name] = frames;
              }
            }
          } catch (e) {}
        }
      } catch (e) {}

      for (const el of els) {
        const s = getComputedStyle(el);
        if (s.animationName && s.animationName !== 'none') {
          const key = `${s.animationName}|${s.animationDuration}|${s.animationTimingFunction}`;
          if (!animations.find(a => a.name === s.animationName)) {
            animations.push({
              name: s.animationName,
              duration: s.animationDuration,
              timingFunction: s.animationTimingFunction,
              delay: s.animationDelay,
              iterationCount: s.animationIterationCount,
              direction: s.animationDirection,
              fillMode: s.animationFillMode,
              element: el.tagName.toLowerCase() + (el.className ? '.' + el.className.toString().split(' ')[0] : ''),
            });
          }
        }
      }

      // Detect scroll-triggered animations by finding elements with non-default initial state
      const scrollAnimated = [];
      const allEls = document.querySelectorAll('section *, main *, header *, nav *, footer *');
      for (const el of allEls) {
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') continue;
        const hasOpacity = s.opacity !== '1';
        const hasTransform = s.transform !== 'none' && s.transform !== '';
        if (!hasOpacity && !hasTransform) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 20) continue;

        let animationType = 'unknown';
        const matrix = s.transform;
        if (hasOpacity && hasTransform) {
          if (matrix.includes(', 50,') || matrix.includes(', 50)')) animationType = 'fade-in-from-right';
          else if (matrix.includes(', -50,') || matrix.includes(', -50)')) animationType = 'fade-in-from-left';
          else if (matrix.includes(', 0, 0, 1, 0, 50')) animationType = 'fade-in-from-bottom';
          else if (matrix.includes('0.8')) animationType = 'fade-in-scale-up';
          else animationType = 'fade-in-with-transform';
        } else if (hasOpacity) {
          animationType = 'fade-in';
        } else if (hasTransform) {
          if (matrix.includes(', 50)') || matrix.includes(', 50,')) animationType = 'slide-from-right';
          else if (matrix.includes(', -50)') || matrix.includes(', -50,')) animationType = 'slide-from-left';
          else if (matrix.includes('-75')) animationType = 'slide-from-left';
          else animationType = 'transform-animation';
        }

        const cls = el.className ? el.className.toString().slice(0, 60) : '';
        if (!scrollAnimated.find(a => a.className === cls)) {
          scrollAnimated.push({
            className: cls,
            tag: el.tagName.toLowerCase(),
            animationType,
            initialState: { opacity: s.opacity, transform: s.transform },
          });
        }
      }

      return {
        typography: sortedFonts,
        colors: { text: sortedColors, background: sortedBgColors, gradients: [...gradients].slice(0, 10) },
        effects: { shadows: [...shadows].slice(0, 15), borders: [...borders].slice(0, 15), borderRadii: [...radii], transitions: [...transitions].slice(0, 15) },
        animations: { keyframes, usedAnimations: animations, scrollTriggered: scrollAnimated },
      };
    });
  }

  async extractContentMap() {
    return this.page.evaluate(() => {
      const sections = [];
      const topLevelEls = document.querySelectorAll('nav, .w-nav, [class*="navbar"], [class*="nav-"], body > div > header, body > div > nav, body > div > main, body > div > section, body > div > footer, body > header, body > nav, body > main, body > section, body > footer, main > section, [id*="ection"], [id*="ero"]');
      const seen = new Set();
      const processed = new Set();

      for (const el of topLevelEls) {
        if (seen.has(el)) continue;
        let dominated = false;
        for (const other of seen) {
          if (other.contains(el)) { dominated = true; break; }
        }
        if (dominated) continue;
        seen.add(el);

        const rect = el.getBoundingClientRect();
        if (rect.width < 200 || rect.height < 50) continue;

        const s = getComputedStyle(el);
        const section = {
          tag: el.tagName.toLowerCase(),
          id: el.id || null,
          className: el.className ? el.className.toString().slice(0, 100) : null,
          dimensions: { width: Math.round(rect.width), height: Math.round(rect.height), top: Math.round(rect.top) },
          style: { backgroundColor: s.backgroundColor, backgroundImage: s.backgroundImage !== 'none' ? s.backgroundImage.slice(0, 300) : null, position: s.position !== 'static' ? s.position : null },
          headings: [],
          paragraphs: [],
          links: [],
          images: [],
          buttons: [],
        };

        const headings = el.querySelectorAll('h1, h2, h3, h4, h5, h6');
        for (const h of headings) {
          if (processed.has(h)) continue;
          processed.add(h);
          const text = h.textContent.trim();
          if (text) section.headings.push({ tag: h.tagName.toLowerCase(), text: text.slice(0, 200) });
        }

        const paragraphs = el.querySelectorAll('p');
        for (const p of paragraphs) {
          if (processed.has(p)) continue;
          processed.add(p);
          const text = p.textContent.trim();
          if (text) section.paragraphs.push(text.slice(0, 300));
        }

        const links = el.querySelectorAll('a[href]');
        for (const a of links) {
          if (processed.has(a)) continue;
          processed.add(a);
          const text = a.textContent.trim();
          if (text && a.href) section.links.push({ text: text.slice(0, 100), href: a.href });
        }

        const imgs = el.querySelectorAll('img, video, svg');
        let logoFound = false;
        for (const img of imgs) {
          if (processed.has(img)) continue;
          processed.add(img);
          if (img.tagName === 'IMG') {
            const imgRect = img.getBoundingClientRect();
            const isLogo = !logoFound && (section.tag === 'nav' || section.className?.includes('nav')) && imgRect.width > 50 && imgRect.height > 20;
            if (isLogo) logoFound = true;
            section.images.push({ type: isLogo ? 'logo' : 'img', src: img.src || img.dataset.src || '', alt: img.alt || '', width: img.naturalWidth || Math.round(imgRect.width), height: img.naturalHeight || Math.round(imgRect.height) });
          } else if (img.tagName === 'VIDEO') {
            section.images.push({ type: 'video', src: img.src || img.querySelector('source')?.src || '' });
          } else if (img.tagName === 'SVG') {
            section.images.push({ type: 'svg', viewBox: img.getAttribute('viewBox') || '', width: Math.round(img.getBoundingClientRect().width) });
          }
        }

        const bgEls = el.querySelectorAll('[style*="background-image"]');
        for (const bgEl of bgEls) {
          if (processed.has(bgEl)) continue;
          processed.add(bgEl);
          const bg = getComputedStyle(bgEl).backgroundImage;
          if (bg && bg !== 'none' && !bg.includes('gradient')) section.images.push({ type: 'background', src: bg.slice(4, -1).replace(/['"]/g, '') });
        }

        const btns = el.querySelectorAll('button, [class*="btn"], [class*="button"], [class*="cta"], a[role="button"]');
        for (const btn of btns) {
          if (processed.has(btn)) continue;
          processed.add(btn);
          const bs = getComputedStyle(btn);
          section.buttons.push({
            text: btn.textContent.trim().slice(0, 60),
            href: btn.href || null,
            style: { backgroundColor: bs.backgroundColor, color: bs.color, borderRadius: bs.borderRadius, padding: bs.padding, fontSize: bs.fontSize, fontWeight: bs.fontWeight },
          });
        }

        if (section.headings.length || section.paragraphs.length || section.images.length || section.buttons.length || section.links.length) {
          sections.push(section);
        }
      }
      return sections;
    });
  }

  async extractInteractiveStates() {
    const elements = await this.page.$$('a, button, [class*="btn"], [class*="button"], [class*="cta"], [role="button"], input[type="submit"]');
    const states = [];
    const seen = new Set();

    for (const el of elements.slice(0, 40)) {
      const info = await el.evaluate(node => {
        const rect = node.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 20) return null;
        const s = getComputedStyle(node);
        const text = node.textContent.trim().slice(0, 60);
        if (!text) return null;
        return {
          text,
          tag: node.tagName.toLowerCase(),
          href: node.href || null,
          selector: node.id ? `#${node.id}` : (node.className ? `.${node.className.toString().split(' ')[0]}` : node.tagName.toLowerCase()),
          normal: {
            backgroundColor: s.backgroundColor,
            color: s.color,
            borderColor: s.borderColor,
            borderRadius: s.borderRadius,
            padding: s.padding,
            fontSize: s.fontSize,
            fontWeight: s.fontWeight,
            transform: s.transform,
            boxShadow: s.boxShadow !== 'none' ? s.boxShadow : null,
            transition: s.transition !== 'all 0s ease 0s' ? s.transition : null,
          },
        };
      });
      if (!info || seen.has(info.text)) continue;
      seen.add(info.text);

      await el.hover().catch(() => {});
      await this.page.waitForTimeout(300);

      const hoverState = await el.evaluate(node => {
        const s = getComputedStyle(node);
        return {
          backgroundColor: s.backgroundColor,
          color: s.color,
          borderColor: s.borderColor,
          transform: s.transform,
          boxShadow: s.boxShadow !== 'none' ? s.boxShadow : null,
        };
      });

      const hasChange = info.normal.backgroundColor !== hoverState.backgroundColor ||
        info.normal.color !== hoverState.color ||
        info.normal.transform !== hoverState.transform ||
        info.normal.boxShadow !== hoverState.boxShadow;

      if (hasChange) {
        info.hover = hoverState;
      }
      states.push(info);
    }

    await this.page.mouse.move(0, 0);
    return states;
  }

  async settle() {
    await this.page.evaluate(() => new Promise(r => requestAnimationFrame(() => setTimeout(r, 500))));
  }

  async analyze(viewport) {
    if (viewport) {
      await this.page.setViewportSize(viewport);
      await this.settle();
    }
    return this.page.evaluate(() => {
      function isLayoutContainer(el, style) {
        const display = style.display;
        if (display === 'none' || style.visibility === 'hidden') return false;
        if (['grid', 'inline-grid', 'flex', 'inline-flex'].includes(display)) return true;
        const pos = style.position;
        if (['absolute', 'fixed', 'sticky'].includes(pos)) return true;
        const landmarks = ['body','main','nav','header','footer','section','article','aside'];
        if (landmarks.includes(el.tagName.toLowerCase())) return true;
        if (['block', 'inline-block', 'table'].includes(display)) {
          const hasChildElements = Array.from(el.children).some(c => {
            const cs = getComputedStyle(c);
            return cs.display !== 'none';
          });
          if (hasChildElements) return true;
        }
        return false;
      }

      function getSelector(el) {
        const parts = [];
        let current = el;
        while (current && current !== document.documentElement) {
          let seg = current.tagName.toLowerCase();
          if (current.id) {
            seg += `#${current.id}`;
            parts.unshift(seg);
            break;
          }
          const parent = current.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
            if (siblings.length > 1) {
              seg += `:nth-of-type(${siblings.indexOf(current) + 1})`;
            }
          }
          parts.unshift(seg);
          current = current.parentElement;
        }
        return parts.join(' > ');
      }

      function extractLayout(style) {
        const display = style.display;
        const base = {
          display,
          width: style.width,
          maxWidth: style.maxWidth,
          minWidth: style.minWidth,
          height: style.height,
          padding: style.padding,
          margin: style.margin,
          position: style.position,
          zIndex: style.zIndex,
          overflow: style.overflow,
          boxSizing: style.boxSizing,
          borderRadius: style.borderRadius,
        };
        if (display === 'grid' || display === 'inline-grid') {
          Object.assign(base, {
            gridTemplateColumns: style.gridTemplateColumns,
            gridTemplateRows: style.gridTemplateRows,
            gridAutoFlow: style.gridAutoFlow,
            gap: style.gap,
            placeItems: style.placeItems,
            placeContent: style.placeContent,
          });
        }
        if (display === 'flex' || display === 'inline-flex') {
          Object.assign(base, {
            flexDirection: style.flexDirection,
            flexWrap: style.flexWrap,
            justifyContent: style.justifyContent,
            alignItems: style.alignItems,
            alignContent: style.alignContent,
            gap: style.gap,
          });
        }
        return base;
      }

      function traverse(el, depth = 0) {
        if (depth > 20) return null;
        const style = getComputedStyle(el);
        if (!isLayoutContainer(el, style)) return null;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return null;

        const node = {
          tag: el.tagName.toLowerCase(),
          selector: getSelector(el),
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
          layout: extractLayout(style),
          children: [],
        };

        for (const child of el.children) {
          const childNode = traverse(child, depth + 1);
          if (childNode) node.children.push(childNode);
        }
        return node;
      }

      return traverse(document.body) || { tag: 'body', selector: 'body', rect: {x:0,y:0,width:0,height:0}, layout: {display:'block'}, children: [] };
    });
  }

  async detectBreakpoints(baseTree) {
    const results = { breakpoints: [] };
    const baseFlat = this.flattenTree(baseTree);

    for (const width of this.breakpoints) {
      if (width === this.viewport.width) continue;
      const tree = await this.analyze({ width, height: this.viewport.height });
      const flat = this.flattenTree(tree);
      const changes = this.diffLayouts(baseFlat, flat);
      if (changes.length > 0) {
        results.breakpoints.push({ width, changes });
      }
    }
    return results;
  }

  flattenTree(node, map = new Map()) {
    if (!node) return map;
    map.set(node.selector, node.layout);
    for (const child of node.children || []) {
      this.flattenTree(child, map);
    }
    return map;
  }

  diffLayouts(baseMap, compareMap) {
    const changes = [];
    const keys = ['display', 'flexDirection', 'gridTemplateColumns', 'gridTemplateRows', 'gap', 'justifyContent', 'alignItems'];
    for (const [selector, baseLayout] of baseMap) {
      const cmpLayout = compareMap.get(selector);
      if (!cmpLayout) continue;
      const diffs = {};
      let hasDiff = false;
      for (const key of keys) {
        if (baseLayout[key] && cmpLayout[key] && baseLayout[key] !== cmpLayout[key]) {
          diffs[key] = { from: baseLayout[key], to: cmpLayout[key] };
          hasDiff = true;
        }
      }
      if (hasDiff) changes.push({ selector, ...diffs });
    }
    return changes;
  }

  async renderOverlay(tree) {
    await this.page.evaluate((tree) => {
      const overlay = document.createElement('div');
      overlay.id = '__layout_overlay__';
      overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:999999;';
      document.body.appendChild(overlay);

      const MIN_WIDTH = 200;
      const MIN_HEIGHT = 80;
      const MAX_DEPTH = 5;

      function getColor(layout) {
        const d = layout.display;
        if (d === 'grid' || d === 'inline-grid') return { border: '#3b82f6', bg: 'rgba(59,130,246,0.08)', label: 'GRID' };
        if (d === 'flex' || d === 'inline-flex') return { border: '#22c55e', bg: 'rgba(34,197,94,0.08)', label: 'FLEX' };
        if (['absolute','fixed','sticky'].includes(layout.position)) return { border: '#f97316', bg: 'rgba(249,115,22,0.08)', label: layout.position.toUpperCase() };
        return null;
      }

      function shouldRender(node, depth) {
        if (depth > MAX_DEPTH) return false;
        if (node.rect.width < MIN_WIDTH || node.rect.height < MIN_HEIGHT) return false;
        const color = getColor(node.layout);
        if (!color) return false;
        if (node.layout.position === 'fixed' && node.rect.width < 500) return false;
        return true;
      }

      function getLayoutDetail(layout) {
        const d = layout.display;
        if (d === 'grid' || d === 'inline-grid') {
          const cols = layout.gridTemplateColumns || '';
          const colCount = cols.split(' ').filter(Boolean).length;
          return colCount > 0 ? `${colCount} cols` : '';
        }
        if (d === 'flex' || d === 'inline-flex') {
          const dir = layout.flexDirection === 'column' ? 'col' : 'row';
          return dir;
        }
        return '';
      }

      function renderNode(node, depth) {
        if (shouldRender(node, depth)) {
          const { rect, layout } = node;
          const color = getColor(layout);
          const div = document.createElement('div');
          div.style.cssText = `position:absolute;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;border:3px solid ${color.border};background:${color.bg};box-sizing:border-box;border-radius:4px;`;
          const detail = getLayoutDetail(layout);
          const labelText = `${node.tag} ${color.label}${detail ? ' · ' + detail : ''}`;
          const label = document.createElement('span');
          label.textContent = labelText;
          label.style.cssText = `position:absolute;top:-1px;left:-1px;background:${color.border};color:#fff;font:bold 11px/1 system-ui,sans-serif;padding:3px 6px;border-radius:0 0 4px 0;white-space:nowrap;`;
          div.appendChild(label);
          overlay.appendChild(div);
        }
        for (const child of node.children || []) renderNode(child, depth + 1);
      }
      renderNode(tree, 0);
    }, tree);
  }

  async screenshot() {
    const filePath = path.join(this.outputDir, 'layout-screenshot.png');
    await this.page.screenshot({ path: filePath, fullPage: true });
  }

  generateBlueprint(tree) {
    const sections = [];
    const MIN_WIDTH = 200;
    const MIN_HEIGHT = 80;
    const MAX_DEPTH = 10;
    const usedNames = new Map();

    const walk = (node, depth, parentName) => {
      if (!node || depth > MAX_DEPTH) return;
      if (node.rect.width < MIN_WIDTH || node.rect.height < MIN_HEIGHT) {
        for (const child of node.children || []) walk(child, depth + 1, parentName);
        return;
      }
      const d = node.layout.display;
      const isGridOrFlex = ['grid','inline-grid','flex','inline-flex'].includes(d);
      const isPositioned = ['absolute','fixed','sticky'].includes(node.layout.position);
      const isLayout = isGridOrFlex || isPositioned;
      if (!isLayout) {
        for (const child of node.children || []) walk(child, depth + 1, parentName);
        return;
      }

      if (node.layout.position === 'fixed' && node.rect.width < 500) return;
      if (isPositioned && !isGridOrFlex) {
        for (const child of node.children || []) walk(child, depth + 1, parentName);
        return;
      }

      let name = this.generateClassName(node, depth, parentName);
      const count = usedNames.get(name) || 0;
      usedNames.set(name, count + 1);
      if (count > 0) name = `${name}-${count + 1}`;

      const css = this.layoutToCSS(node.layout);
      if (css) {
        sections.push({ name, selector: node.selector, css, depth, childCount: (node.children || []).length });
      }
      for (const child of node.children || []) walk(child, depth + 1, name);
    };
    walk(tree, 0, 'page');

    let output = `/* Layout Blueprint - ${this.url} */\n`;
    output += `/* Generated: ${new Date().toISOString()} */\n`;
    output += `/* Viewport: ${this.viewport.width}x${this.viewport.height} */\n\n`;

    for (const section of sections) {
      output += `/* ${section.selector} (${section.childCount} children) */\n`;
      output += `.${section.name} {\n`;
      for (const line of section.css.split('\n')) {
        output += `  ${line}\n`;
      }
      output += `}\n\n`;
    }
    return output;
  }

  generateClassName(node, depth, parentName) {
    const tag = node.tag;
    const d = node.layout.display;
    let type = 'container';
    if (d === 'grid' || d === 'inline-grid') type = 'grid';
    else if (d === 'flex' || d === 'inline-flex') type = 'flex';
    else if (['absolute','fixed','sticky'].includes(node.layout.position)) type = node.layout.position;

    const landmarks = { header: 'header', nav: 'nav', main: 'main', footer: 'footer', section: 'section', aside: 'sidebar', article: 'article' };
    const semantic = landmarks[tag] || '';
    const base = semantic || `${parentName}-${type}`;
    return base.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
  }

  layoutToCSS(layout) {
    const lines = [];
    const d = layout.display;
    if (d === 'grid' || d === 'inline-grid') {
      lines.push(`display: grid;`);
      if (layout.gridTemplateColumns && layout.gridTemplateColumns !== 'none') {
        lines.push(`grid-template-columns: ${this.simplifyGridTemplate(layout.gridTemplateColumns)};`);
      }
      if (layout.gridTemplateRows && layout.gridTemplateRows !== 'none') {
        lines.push(`grid-template-rows: ${this.simplifyGridTemplate(layout.gridTemplateRows)};`);
      }
      if (layout.gap && layout.gap !== 'normal' && layout.gap !== '0px') lines.push(`gap: ${layout.gap};`);
      if (layout.placeItems && layout.placeItems !== 'normal' && layout.placeItems !== 'normal normal') lines.push(`place-items: ${layout.placeItems};`);
      if (layout.placeContent && layout.placeContent !== 'normal' && layout.placeContent !== 'normal normal') lines.push(`place-content: ${layout.placeContent};`);
    } else if (d === 'flex' || d === 'inline-flex') {
      lines.push(`display: flex;`);
      if (layout.flexDirection && layout.flexDirection !== 'row') lines.push(`flex-direction: ${layout.flexDirection};`);
      if (layout.flexWrap && layout.flexWrap !== 'nowrap') lines.push(`flex-wrap: ${layout.flexWrap};`);
      if (layout.justifyContent && layout.justifyContent !== 'normal' && layout.justifyContent !== 'flex-start') lines.push(`justify-content: ${layout.justifyContent};`);
      if (layout.alignItems && layout.alignItems !== 'normal' && layout.alignItems !== 'stretch') lines.push(`align-items: ${layout.alignItems};`);
      if (layout.gap && layout.gap !== 'normal' && layout.gap !== '0px') lines.push(`gap: ${layout.gap};`);
    }
    if (['absolute','fixed','sticky'].includes(layout.position)) lines.push(`position: ${layout.position};`);
    if (layout.zIndex && layout.zIndex !== 'auto') lines.push(`z-index: ${layout.zIndex};`);
    if (layout.maxWidth && layout.maxWidth !== 'none') lines.push(`max-width: ${layout.maxWidth};`);
    if (layout.padding && layout.padding !== '0px') lines.push(`padding: ${layout.padding};`);
    if (layout.margin && layout.margin !== '0px') lines.push(`margin: ${layout.margin};`);
    if (layout.overflow && layout.overflow !== 'visible') lines.push(`overflow: ${layout.overflow};`);
    if (layout.borderRadius && layout.borderRadius !== '0px') lines.push(`border-radius: ${layout.borderRadius};`);
    return lines.join('\n');
  }

  simplifyGridTemplate(value) {
    const parts = value.split(' ').filter(Boolean);
    if (parts.length <= 1) return value;
    const rounded = parts.map(p => {
      const num = parseFloat(p);
      if (isNaN(num)) return p;
      return Math.round(num) + 'px';
    });
    const allSame = rounded.every(v => v === rounded[0]);
    if (allSame && parts.length > 2) {
      const size = rounded[0];
      return `repeat(${parts.length}, ${size})`;
    }
    return rounded.join(' ');
  }

  generateReport(layoutTree, responsive) {
    return {
      url: this.url,
      timestamp: new Date().toISOString(),
      viewport: this.viewport,
      layoutTree,
      responsive,
      summary: this.buildSummary(layoutTree),
    };
  }

  buildSummary(tree) {
    let total = 0, grid = 0, flex = 0, positioned = 0, maxDepth = 0;
    function walk(node, depth) {
      if (!node) return;
      total++;
      maxDepth = Math.max(maxDepth, depth);
      const d = node.layout.display;
      if (d === 'grid' || d === 'inline-grid') grid++;
      if (d === 'flex' || d === 'inline-flex') flex++;
      if (['absolute','fixed','sticky'].includes(node.layout.position)) positioned++;
      for (const child of node.children || []) walk(child, depth + 1);
    }
    walk(tree, 0);
    return { totalContainers: total, gridContainers: grid, flexContainers: flex, positionedElements: positioned, maxNestingDepth: maxDepth };
  }

  countNodes(tree) {
    if (!tree) return 0;
    return 1 + (tree.children || []).reduce((sum, c) => sum + this.countNodes(c), 0);
  }

  async cleanup() {
    if (this.browser) await this.browser.close();
  }
}

// --- CLI ---
function parseArgs(args) {
  const options = {};
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--output' || arg === '-o') { options.outputDir = args[++i]; }
    else if (arg === '--timeout' || arg === '-t') { options.timeout = parseInt(args[++i], 10); }
    else if (arg === '--no-responsive') { options.skipResponsive = true; }
    else if (arg === '--viewport') {
      const [w, h] = args[++i].split('x').map(Number);
      options.viewport = { width: w, height: h };
    }
    else if (arg === '--breakpoints') { options.breakpoints = args[++i].split(',').map(Number); }
    else if (!arg.startsWith('-')) { options.url = arg; }
    i++;
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.url) {
    console.error('Usage: node layout-inspector.js <url> [--output dir] [--timeout ms] [--no-responsive] [--viewport WxH]');
    process.exit(1);
  }
  try { new URL(options.url); } catch {
    console.error(`Invalid URL: ${options.url}`);
    process.exit(1);
  }
  const inspector = new LayoutInspector(options);
  await inspector.run();
}

main().catch(err => { console.error(err.message); process.exit(1); });
