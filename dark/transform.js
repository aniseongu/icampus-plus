// 다크 모드 규칙 변환(단일 정본): CSS 선언 하나(속성, 값)와 같은 규칙의 다른 선언들, 선택자를 받아 다크 값을 돌려준다.
// 정적 생성기(scripts/icampus-dark-sheets.mjs)와 실행 중 변환(dark/styles.js)이 이 파일만 쓴다. 색 계산은 color.js(OKLCH)에 맡긴다.
// 브라우저(전역 ICDTransform)와 Node(module.exports) 모두 동작한다. DOM을 읽지 않는 순수 함수다.
//
// 규칙(스킬 icampus-dark-theme §3-1, 계획 문서 2단계 표):
//   배경: 흰색(L>=.97, C<.02)  -> 테두리·그림자가 같은 규칙에 있으면 --icd-surface, 없으면 --icd-bg (html/body는 항상 bg, 입력 계열은 raised)
//         연회색(.88<=L<.97)   -> --icd-raised (html/body는 bg)
//         위 둘 + :hover/:focus -> --icd-hover, .active/.selected/[aria-selected] -> --icd-brand-soft
//         그 밖                -> color.background (형광펜·분류 색 보존)
//   글자: color.text(7:1). 같은 규칙의 배경이 변환 후에도 진한 색 면이면 --icd-on-accent, 링크 모양의 남색은 --icd-link
//   선:   밝은 무채색 -> --icd-line(컨트롤은 --icd-control-line), 채도 있는 색 -> color.border (색상 유지)
//   그림자: 어두운 그림자는 그대로, 밝은 무채색 그림자(선 대용·글로우) -> --icd-line
//   url() 이미지는 건드리지 않는다. !important는 호출자가 원래 값을 그대로 유지한다.
(() => {
  const C = typeof module === 'object' && module.exports ? require('./color.js') : globalThis.ICDColor;

  // 토큰 값(dark.css §1과 같이 바꾼다). 변환 결과가 var()로 나가는 면의 색을 글자 대비 계산에 쓴다.
  const TOKENS = {
    bg: '#000000',
    surface: '#111316',
    raised: '#1a1d22',
    hover: '#24282e',
    'brand-soft': '#13304f',
    'on-accent': '#f7f9fc',
  };

  const NAMED = Object.fromEntries('aliceblue:f0f8ff,antiquewhite:faebd7,aqua:00ffff,aquamarine:7fffd4,azure:f0ffff,beige:f5f5dc,bisque:ffe4c4,black:000000,blanchedalmond:ffebcd,blue:0000ff,blueviolet:8a2be2,brown:a52a2a,burlywood:deb887,cadetblue:5f9ea0,chartreuse:7fff00,chocolate:d2691e,coral:ff7f50,cornflowerblue:6495ed,cornsilk:fff8dc,crimson:dc143c,cyan:00ffff,darkblue:00008b,darkcyan:008b8b,darkgoldenrod:b8860b,darkgray:a9a9a9,darkgreen:006400,darkgrey:a9a9a9,darkkhaki:bdb76b,darkmagenta:8b008b,darkolivegreen:556b2f,darkorange:ff8c00,darkorchid:9932cc,darkred:8b0000,darksalmon:e9967a,darkseagreen:8fbc8f,darkslateblue:483d8b,darkslategray:2f4f4f,darkslategrey:2f4f4f,darkturquoise:00ced1,darkviolet:9400d3,deeppink:ff1493,deepskyblue:00bfff,dimgray:696969,dimgrey:696969,dodgerblue:1e90ff,firebrick:b22222,floralwhite:fffaf0,forestgreen:228b22,fuchsia:ff00ff,gainsboro:dcdcdc,ghostwhite:f8f8ff,gold:ffd700,goldenrod:daa520,gray:808080,green:008000,greenyellow:adff2f,grey:808080,honeydew:f0fff0,hotpink:ff69b4,indianred:cd5c5c,indigo:4b0082,ivory:fffff0,khaki:f0e68c,lavender:e6e6fa,lavenderblush:fff0f5,lawngreen:7cfc00,lemonchiffon:fffacd,lightblue:add8e6,lightcoral:f08080,lightcyan:e0ffff,lightgoldenrodyellow:fafad2,lightgray:d3d3d3,lightgreen:90ee90,lightgrey:d3d3d3,lightpink:ffb6c1,lightsalmon:ffa07a,lightseagreen:20b2aa,lightskyblue:87cefa,lightslategray:778899,lightslategrey:778899,lightsteelblue:b0c4de,lightyellow:ffffe0,lime:00ff00,limegreen:32cd32,linen:faf0e6,magenta:ff00ff,maroon:800000,mediumaquamarine:66cdaa,mediumblue:0000cd,mediumorchid:ba55d3,mediumpurple:9370db,mediumseagreen:3cb371,mediumslateblue:7b68ee,mediumspringgreen:00fa9a,mediumturquoise:48d1cc,mediumvioletred:c71585,midnightblue:191970,mintcream:f5fffa,mistyrose:ffe4e1,moccasin:ffe4b5,navajowhite:ffdead,navy:000080,oldlace:fdf5e6,olive:808000,olivedrab:6b8e23,orange:ffa500,orangered:ff4500,orchid:da70d6,palegoldenrod:eee8aa,palegreen:98fb98,paleturquoise:afeeee,palevioletred:db7093,papayawhip:ffefd5,peachpuff:ffdab9,peru:cd853f,pink:ffc0cb,plum:dda0dd,powderblue:b0e0e6,purple:800080,rebeccapurple:663399,red:ff0000,rosybrown:bc8f8f,royalblue:4169e1,saddlebrown:8b4513,salmon:fa8072,sandybrown:f4a460,seagreen:2e8b57,seashell:fff5ee,sienna:a0522d,silver:c0c0c0,skyblue:87ceeb,slateblue:6a5acd,slategray:708090,slategrey:708090,snow:fffafa,springgreen:00ff7f,steelblue:4682b4,tan:d2b48c,teal:008080,thistle:d8bfd8,tomato:ff6347,turquoise:40e0d0,violet:ee82ee,wheat:f5deb3,white:ffffff,whitesmoke:f5f5f5,yellow:ffff00,yellowgreen:9acd32'.split(',').map((p) => p.split(':')));

  const FN = '(?:rgba?|hsla?)\\((?:[^()]|\\([^()]*\\))*\\)';
  const TOKEN_RE = new RegExp(
    `url\\((?:[^()]|\\([^()]*\\))*\\)|"[^"]*"|'[^']*'|(?:var|env|attr|calc|color-mix|light-dark)\\((?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))*\\)|(${FN})|(#[0-9a-f]{3,8})(?![\\w-])|(?<![\\w#.-])([a-z]+)(?![\\w(-])`,
    'gi',
  );

  // 값 안의 색 토큰마다 fn(토큰)을 불러 바꾼 문자열을 돌려준다. url(), 문자열, var() 등은 건드리지 않는다.
  // 바뀐 것이 없으면 null.
  function mapColors(value, fn) {
    if (/color-mix\(|light-dark\(|\bfrom\b/i.test(value)) return null;
    let changed = false;
    const out = String(value).replace(TOKEN_RE, (m, func, hex, word) => {
      const token = func || hex || (word && NAMED[word.toLowerCase()] ? word : null);
      if (!token) return m;
      const r = fn(token);
      if (r === null || r === undefined || r === m) return m;
      changed = true;
      return r;
    });
    return changed ? out : null;
  }

  function hslToRgbString(value) {
    const m = /^hsla?\(([^)]+)\)$/i.exec(value.trim());
    if (!m) return value;
    const p = m[1].split(/[\s,/]+/).filter(Boolean);
    const hue = parseFloat(p[0]);
    const h = (((hue % 360) + 360) % 360) / 360;
    const pct = (x) => (x.endsWith('%') ? parseFloat(x) / 100 : parseFloat(x));
    const s = pct(p[1]);
    const l = pct(p[2]);
    const a = p[3] === undefined ? 1 : p[3].endsWith('%') ? parseFloat(p[3]) / 100 : parseFloat(p[3]);
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const k = 2 * l - q;
    const f = (t) => {
      t = (t + 1) % 1;
      if (t < 1 / 6) return k + (q - k) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return k + (q - k) * (2 / 3 - t) * 6;
      return k;
    };
    return C.format({ r: f(h + 1 / 3) * 255, g: f(h) * 255, b: f(h - 1 / 3) * 255, a });
  }

  // 토큰(hex, rgb(), hsl(), 색 이름, var(--icd-*))을 {r,g,b,a}로 읽는다
  function parseToken(token) {
    const t = String(token).trim();
    const tok = /^var\(--icd-([a-z-]+)\)$/.exec(t);
    if (tok) return TOKENS[tok[1]] ? C.parse(TOKENS[tok[1]]) : null;
    const lower = t.toLowerCase();
    if (NAMED[lower]) return C.parse(`#${NAMED[lower]}`);
    if (/^hsla?\(/i.test(t)) return C.parse(hslToRgbString(t));
    return C.parse(t);
  }

  const same = (a, b) => !!a && !!b && Math.round(a.r) === Math.round(b.r) && Math.round(a.g) === Math.round(b.g) && Math.round(a.b) === Math.round(b.b) && Math.abs((a.a ?? 1) - (b.a ?? 1)) < 0.01;

  // ---- 선택자 사실 ----
  const stripNot = (s) => String(s).replace(/:(?:not|where)\((?:[^()]|\([^()]*\))*\)/g, '');
  const facts = (selector) => {
    const s = stripNot(selector);
    const last = s.trim().split(/[\s>+~]+/).filter(Boolean).pop() || '';
    return {
      hover: /:(hover|focus|focus-visible|focus-within|active)\b/.test(s),
      selected: /\.(active|selected|current|is-active|is-selected|is-current|ui-state-active)(?![\w-])|\[aria-(selected|current|pressed|expanded)(?!=["']?false)|:checked/.test(s),
      link: /(^|[\s>+~,(])a(?![\w-])|\.Button--link|\[role=["']?link|\.btn-link|(^|[^\w-])\.link(?![\w-])/.test(s),
      control: /(^|[\s>+~,(])(input|select|textarea)(?![\w-])|\[type=["']?(checkbox|radio|text|password|email|search|number|tel|url|date)|\.ic-Input|\.form-control|\.ui-selectmenu|\.ic-Form-control|\.ui-widget-content/.test(s),
      page: /^(html|body|:root)(?![\w-])/i.test(last),
      // 떠 있는 면(모달, 팝오버, 메뉴 등)은 테두리·그림자가 같은 규칙에 없어도 면(surface)이다
      floating: /(modal|dialog|popover|popup|dropdown|tooltip|flyout|overlay)|[-_.#](tray|menu)(?![a-z])/i.test(s),
    };
  };

  // ---- 선언 사실 ----
  const NONE = /^\s*(none|initial|inherit|unset|hidden)\s*$/i;
  const BORDER_NONE = /^\s*(none|initial|inherit|unset|hidden)\b|^\s*0(px|em|rem|pt)?(\s|$)/i;
  function declMap(decls) {
    const map = new Map();
    for (const d of decls) map.set(d.prop.toLowerCase(), d.value);
    return map;
  }

  function widthZero(value) {
    const m = /(^|\s)(-?[\d.]+)(px|em|rem|pt)?(?=\s|$)/.exec(String(value));
    return !!m && parseFloat(m[2]) === 0;
  }

  function hasBorder(map) {
    for (const side of ['', '-top', '-right', '-bottom', '-left', '-block-start', '-block-end', '-inline-start', '-inline-end']) {
      const sh = map.get(`border${side}`);
      if (sh && !BORDER_NONE.test(sh) && !widthZero(sh)) return true;
      const style = map.get(`border${side}-style`);
      if (style && !/^\s*(none|hidden|initial)/i.test(style)) {
        const w = map.get(`border${side}-width`);
        if (w === undefined || (!/^\s*(initial)/i.test(w) && !widthZero(w))) return true;
      }
    }
    return false;
  }

  const hasShadow = (map) => {
    const v = map.get('box-shadow') || map.get('-webkit-box-shadow');
    return !!v && !NONE.test(v);
  };

  // ---- 색별 변환 ----
  // 흰색 기준: 계획은 L>=.97이지만 #f5f5f5(L=.9702)는 연회색(raised)이어야 하므로 .98(#f7f7f7 근처)로 둔다
  const WHITE_L = 0.98;
  const oklch = (c) => C.toOklch(c);
  const isNeutral = (o, max = 0.03) => o.C < max;
  const BLUE = (h) => {
    const deg = ((h * 180) / Math.PI + 360) % 360;
    return deg >= 195 && deg <= 295;
  };

  // 배경 토큰 하나 -> 다크 값(문자열) 또는 null(그대로)
  function background(token, ctx) {
    const c = parseToken(token);
    if (!c || c.a === 0) return null;
    if (/^var\(/i.test(token)) return null;
    const o = oklch(c);
    const f = ctx.facts;
    if (c.a < 0.99) {
      // 어두운 투명 hover 덮개는 어두운 화면에서 안 보이므로 밝은 덮개로 바꾼다(작은 알파만)
      if (f.hover && o.L < 0.42 && isNeutral(o) && c.a <= 0.25) return C.format({ r: 255, g: 255, b: 255, a: c.a });
      // 반투명 밝은 무채색(밝게 덧칠하는 막)은 어두운 면 위에서도 밝게 덧칠하는 역할 그대로 둔다
      if (o.L >= 0.88 && isNeutral(o)) return null;
      const out = C.background(C.format(c));
      const parsed = out && C.parse(out);
      return parsed && !same(parsed, c) ? out : null;
    }
    const light = o.L >= WHITE_L && o.C < 0.02;
    const grey = o.L >= 0.88 && o.L < WHITE_L && o.C < 0.03;
    if (light || grey) {
      if (f.page) return 'var(--icd-bg)';
      if (f.selected) return 'var(--icd-brand-soft)';
      if (f.hover) return 'var(--icd-hover)';
      if (grey) return 'var(--icd-raised)';
      if (f.control) return 'var(--icd-raised)';
      return ctx.border || ctx.shadow || f.floating ? 'var(--icd-surface)' : 'var(--icd-bg)';
    }
    const out = C.background(C.format(c));
    const parsed = out && C.parse(out);
    return parsed && !same(parsed, c) ? out : null;
  }

  // 글자 색 토큰 -> 다크 값
  function text(token, ctx) {
    const c = parseToken(token);
    if (!c || c.a === 0 || /^var\(/i.test(token)) return null;
    const o = oklch(c);
    const f = ctx.facts;
    if (f.link && o.C >= 0.05 && o.L < 0.65 && BLUE(o.H)) return f.hover ? 'var(--icd-link-hover)' : 'var(--icd-link)';
    if (ctx.accent && o.L >= 0.85 && o.C < 0.06) return 'var(--icd-on-accent)';
    const out = C.text(C.format(c), ctx.bgOut || C.SURFACE);
    const parsed = out && C.parse(out);
    return parsed && !same(parsed, c) ? out : null;
  }

  // 선 색 토큰 -> 다크 값
  function border(token, ctx) {
    const c = parseToken(token);
    if (!c || c.a === 0 || /^var\(/i.test(token)) return null;
    const o = oklch(c);
    const f = ctx.facts;
    if (o.C > 0.06) {
      const out = C.border(C.format(c));
      const parsed = out && C.parse(out);
      return parsed && !same(parsed, c) ? out : null;
    }
    if (o.L > 0.6) {
      // 면과 같은 흰색 테두리는 라이트에서 안 보이던 선이다: 같은 규칙의 면 토큰으로 맞춘다
      if (o.L >= 0.985 && ctx.bgToken && /^var\(--icd-(bg|surface)\)$/.test(ctx.bgToken)) return ctx.bgToken;
      return f.control ? 'var(--icd-control-line)' : 'var(--icd-line)';
    }
    // 아주 어두운 선은 어두운 면 위에서 사라지므로 한 단계 밝은 선으로
    // (transparent가 섞인 값은 CSS 삼각형 화살표라서 면 색과 짝이므로 건드리지 않는다)
    if (o.L < 0.2 && isNeutral(o) && c.a >= 0.9 && !ctx.triangle) return 'var(--icd-line-strong)';
    return null;
  }

  // 밑줄 색: 글자처럼 읽히게(밝은 무채색 옅은 밑줄은 선)
  function decoration(token, ctx) {
    const c = parseToken(token);
    if (!c) return null;
    const o = oklch(c);
    if (o.C < 0.06 && o.L > 0.6) return 'var(--icd-line)';
    return text(token, ctx);
  }

  function shadowValue(value, ctx) {
    if (NONE.test(value)) return null;
    return mapColors(value, (token) => {
      const c = parseToken(token);
      if (!c || c.a === 0 || /^var\(/i.test(token)) return null;
      const o = oklch(c);
      return o.L > 0.6 && o.C < 0.06 ? 'var(--icd-line)' : null;
    });
  }

  const BG_PROPS = new Set(['background-color', 'background', 'background-image']);
  const TEXT_PROPS = new Set(['color', '-webkit-text-fill-color', 'fill', 'stroke']);
  const BORDER_PROPS = /^(border(-(top|right|bottom|left|block|inline|block-start|block-end|inline-start|inline-end))?(-color)?|outline(-color)?|column-rule(-color)?)$/;
  const DECORATION_PROPS = new Set(['text-decoration-color', 'text-decoration']);
  const SHADOW_PROPS = new Set(['box-shadow', '-webkit-box-shadow']);
  // LearningX의 단색 검정 SVG는 배경 이미지라 색 토큰 변환으로는 밝아지지 않는다.
  // 파일 이름으로 판별해 styled-components 해시가 바뀌어도 같은 아이콘을 처리한다.
  const DARK_ICON_URL = /\/icon_(?:reply|copy_link|arrow_left_small|plus_black|commons|root)\.svg(?:[?"')]|$)/i;

  // 실행 중 스타일 변환기가 색과 관계없는 규칙을 건너뛸 때도 이 분류를 함께 쓴다.
  const isColorProperty = (prop) => {
    const p = prop.toLowerCase();
    return BG_PROPS.has(p) || TEXT_PROPS.has(p) || BORDER_PROPS.test(p) || DECORATION_PROPS.has(p) || SHADOW_PROPS.has(p);
  };

  // 같은 규칙의 변환 후 배경(글자 대비 계산용): {out: {r,g,b,a}, orig, token}
  function ruleBackground(decls, ctx) {
    let found = null;
    for (const d of decls) {
      const p = d.prop.toLowerCase();
      if (p !== 'background-color' && p !== 'background') continue;
      if (/gradient\(/i.test(d.value)) continue;
      let first = null;
      mapColors(d.value, (t) => { if (!first) first = t; return null; });
      if (!first) continue;
      const orig = parseToken(first);
      if (!orig || orig.a < 0.99) continue;
      const conv = background(first, ctx);
      const outToken = conv || first;
      const out = parseToken(outToken);
      found = { orig, out, token: /^var\(/.test(outToken) ? outToken : null };
    }
    return found;
  }

  // 한 선언의 새 값(문자열) 또는 null(그대로). decls: [{prop, value, important}], selector: 선택자 하나
  function convertDeclaration(prop, value, decls, selector, shared) {
    const p = prop.toLowerCase();
    if (p.startsWith('--') || value == null) return null;
    const ctx = shared || context(decls, selector);
    if (BG_PROPS.has(p)) return mapColors(value, (t) => background(t, ctx));
    if (TEXT_PROPS.has(p)) return /^(none|currentcolor|inherit|initial|unset|transparent)$/i.test(value.trim()) ? null : mapColors(value, (t) => text(t, ctx));
    if (BORDER_PROPS.test(p)) { const c2 = { ...ctx, triangle: /\btransparent\b/i.test(value) }; return mapColors(value, (t) => border(t, c2)); }
    if (DECORATION_PROPS.has(p)) return mapColors(value, (t) => decoration(t, ctx));
    if (SHADOW_PROPS.has(p)) return shadowValue(value, ctx);
    return null;
  }

  function context(decls, selector) {
    const map = declMap(decls);
    const ctx = { facts: facts(selector), border: hasBorder(map), shadow: hasShadow(map) };
    const bg = ruleBackground(decls, ctx);
    if (bg) {
      ctx.bgOut = bg.out;
      ctx.bgToken = bg.token;
      const onAccent = C.parse(TOKENS['on-accent']);
      ctx.accent = !bg.token && !!bg.out && (oklch(bg.orig).C > 0.06 || oklch(bg.orig).L < 0.5) && C.contrast(onAccent, bg.out) >= 4.5;
    }
    return ctx;
  }

  // 규칙 하나(선택자 하나): 바뀌는 선언만 [{prop, value, important}]로 돌려준다
  function convertRule(selector, decls) {
    const ctx = context(decls, selector);
    const out = [];
    for (const d of decls) {
      const value = convertDeclaration(d.prop, d.value, decls, selector, ctx);
      if (value !== null && value !== d.value) out.push({ prop: d.prop, value, important: !!d.important });
    }
    if (!decls.some((d) => d.prop.toLowerCase() === 'filter') &&
        decls.some((d) => /^(background|background-image)$/i.test(d.prop) && DARK_ICON_URL.test(d.value))) {
      out.push({ prop: 'filter', value: 'brightness(0) invert(0.8)', important: false });
    }
    return out;
  }

  // ---- 선택자 접두와 규칙 단위 변환(정적 생성기와 실행 중 변환이 같이 쓴다) ----
  const PREFIX = "[data-icd='on']:not(#icd-a):not(#icd-b)";

  // 최상위 쉼표로 선택자 목록을 나눈다((), [], 문자열 안의 쉼표는 건너뜀)
  function splitSelectors(text) {
    const out = [];
    let depth = 0;
    let quote = '';
    let start = 0;
    const s = String(text);
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (ch === ',' && depth === 0) { out.push(s.slice(start, i).trim()); start = i + 1; }
    }
    out.push(s.slice(start).trim());
    return out.filter(Boolean);
  }

  // html/:root로 시작하면 접두를 합성하고, 아니면 자손으로 붙인다(body 포함). 우선순위는 dark.css(:not(#id) 3개)보다 낮은 2개.
  function prefixSelector(selector) {
    const s = String(selector).trim();
    const m = /^(html|:root)(?![\w-])/i.exec(s);
    return m ? `html${PREFIX}${s.slice(m[0].length)}` : `html${PREFIX} ${s}`;
  }

  const VENDOR = /:{1,2}-(moz|ms|o)-/;
  const keyOf = (decls) => decls.map((d) => `${d.prop}:${d.value}${d.important ? '!' : ''}`).join(';');

  // 규칙 하나(선택자 문자열 목록, 선언 목록) -> [{selectors: 접두가 붙은 선택자[], decls: 바뀐 선언[]}]. 결과가 같은 선택자끼리 합친다.
  function convertSelectors(selectors, decls) {
    if (!selectors.length || !decls.length || selectors.some((s) => VENDOR.test(s) || s.includes('&'))) return [];
    const groups = new Map();
    for (const selector of selectors) {
      const changed = convertRule(selector, decls);
      if (!changed.length) continue;
      const key = keyOf(changed);
      if (!groups.has(key)) groups.set(key, { selectors: [], decls: changed });
      groups.get(key).selectors.push(prefixSelector(selector));
    }
    return [...groups.values()];
  }

  const api = { convertDeclaration, convertRule, convertSelectors, isColorProperty, splitSelectors, prefixSelector, keyOf, mapColors, parseToken, facts, TOKENS, PREFIX };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else globalThis.ICDTransform = api;
})();
