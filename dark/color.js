// 다크 모드 색 변환. 원래 색의 색상(hue)은 살리고 명도만 옮겨서, 어두운 배경 위에서 읽히게 만든다.
// 콘텐츠 스크립트(adapt.js)와 개발용 생성기(scripts/icampus-dark-gen.mjs)가 같은 함수를 쓴다.
// 기준 배경은 dark.css의 --icd-surface(#111316)다. 두 파일의 값을 같이 바꾼다.
(() => {
  const SURFACE = { r: 17, g: 19, b: 22 };
  // 기준은 4.5:1(AA)이지만, 어두운 배경의 채도 높은 글자는 4.5에서도 흐리고 번져 보여 7:1(AAA)을 목표로 한다(사용자 지적 2026-10-12)
  const TEXT_MIN = 7;

  function parse(value) {
    const s = String(value || '').trim();
    let m = /^#([0-9a-f]{3,8})$/i.exec(s);
    if (m) {
      let h = m[1];
      if (h.length <= 4) h = [...h].map((c) => c + c).join('');
      const n = (i) => parseInt(h.slice(i, i + 2), 16);
      return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
    }
    m = /^rgba?\(([^)]+)\)$/i.exec(s);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean);
      const v = (x) => (x.endsWith('%') ? (parseFloat(x) * 255) / 100 : parseFloat(x));
      const a = p[3] === undefined ? 1 : p[3].endsWith('%') ? parseFloat(p[3]) / 100 : parseFloat(p[3]);
      return { r: v(p[0]), g: v(p[1]), b: v(p[2]), a };
    }
    return named(s);
  }

  // 색 이름(grey, white 등)과 hsl()은 브라우저의 캔버스로 #rrggbb/rgba()로 바꿔 다시 읽는다(Node 생성기에서는 건너뜀)
  const namedCache = new Map();
  let namedCtx = null;
  function named(s) {
    if (!/^[a-z]+$|^hsla?\(/i.test(s) || /^(inherit|initial|unset|revert|currentcolor|none)$/i.test(s)) return null;
    if (namedCache.has(s)) return namedCache.get(s);
    let out = null;
    if (typeof document === 'object') {
      namedCtx = namedCtx || document.createElement('canvas').getContext('2d');
      namedCtx.fillStyle = '#010203';
      namedCtx.fillStyle = s;
      const v = namedCtx.fillStyle;
      if (v !== '#010203' || /^#010203$/i.test(s)) out = parse(v);
    }
    namedCache.set(s, out);
    return out;
  }

  const lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const gam = (c) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

  function luminance({ r, g, b }) {
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  function contrast(a, b) {
    const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
  }

  function composite(foreground, background) {
    const alpha = foreground.a ?? 1;
    return {
      r: foreground.r * alpha + background.r * (1 - alpha),
      g: foreground.g * alpha + background.g * (1 - alpha),
      b: foreground.b * alpha + background.b * (1 - alpha),
      a: 1,
    };
  }

  function toOklch({ r, g, b }) {
    const [lr, lg, lb] = [lin(r), lin(g), lin(b)];
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    return { L, C: Math.hypot(A, B), H: Math.atan2(B, A) };
  }

  function fromOklch({ L, C, H }) {
    // sRGB 밖이면 채도를 줄여 안으로 넣는다
    for (let c = C; ; c *= 0.9) {
      const A = c * Math.cos(H);
      const B = c * Math.sin(H);
      const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
      const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
      const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
      const rgb = [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
      ];
      if (rgb.every((v) => v >= -0.001 && v <= 1.001) || c < 0.002) {
        const [r, g, b] = rgb.map((v) => Math.round(gam(Math.min(1, Math.max(0, v)))));
        return { r, g, b, a: 1 };
      }
    }
  }

  function format({ r, g, b, a = 1 }) {
    const [R, G, B] = [r, g, b].map(Math.round);
    return a >= 1 ? `rgb(${R}, ${G}, ${B})` : `rgba(${R}, ${G}, ${B}, ${+a.toFixed(3)})`;
  }

  // 글자색: 어두운 배경에서 대비가 TEXT_MIN 이상이 될 때까지 명도만 올린다(색상 유지)
  function text(value, bg = SURFACE, min = TEXT_MIN) {
    const c = parse(value);
    if (!c) return null;
    // 글자 알파를 합성한 뒤의 대비를 본다. 반투명으로 목표 대비가 불가능하면 불투명하게 만든다.
    const backdrop = bg.a === undefined || bg.a >= 1 ? bg : composite(bg, SURFACE);
    const alpha = contrast(composite({ r: 255, g: 255, b: 255, a: c.a }, backdrop), backdrop) >= min ? c.a : 1;
    const effectiveContrast = (rgb) => contrast(composite({ ...rgb, a: alpha }, backdrop), backdrop);
    const finish = (rgb) => {
      let result = format({ ...rgb, a: alpha });
      if (contrast(composite(parse(result), backdrop), backdrop) >= min) return result;
      if (alpha < 1) {
        result = format(rgb);
        if (contrast(parse(result), backdrop) >= min) return result;
      }
      // RGB와 alpha를 소수 자릿수로 출력한 뒤에도 4.5:1을 지킨다.
      const o = toOklch(rgb);
      for (let L = o.L + 0.005; L <= 1.005; L += 0.005) {
        result = format(fromOklch({ ...o, L: Math.min(1, L) }));
        if (contrast(parse(result), backdrop) >= min) return result;
      }
      return result;
    };
    const solid = { ...c, a: 1 };
    if (effectiveContrast(solid) >= min) return finish(solid);
    const o = toOklch(solid);
    // 먼저 명도를 뒤집어 본문 글자가 회색으로 흐려지지 않게 한다(#2d3b45 → 밝은 회색, 남색 → 하늘색)
    const flipped = fromOklch({ ...o, L: Math.max(o.L, 1 - o.L * 0.6) });
    if (effectiveContrast(flipped) >= min) return finish(flipped);
    let lo = o.L;
    let hi = 1;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (effectiveContrast(fromOklch({ ...o, L: mid })) >= min) hi = mid;
      else lo = mid;
    }
    return finish(fromOklch({ ...o, L: hi }));
  }

  // 배경색: 밝은 면은 같은 색상의 어두운 면으로, 진한 색 면(버튼 등)은 흰 글자가 읽히는 정도로 둔다
  function background(value) {
    const c = parse(value);
    if (!c) return null;
    if (c.a === 0) return format(c);
    const o = toOklch(c);
    if (o.L <= 0.42) return format(c);
    if (o.C > 0.09 && o.L < 0.75) {
      return format({ ...fromOklch({ ...o, L: Math.min(o.L, 0.5) }), a: c.a });
    }
    // 형광펜처럼 밝고 진한 색(노랑 #f8f403, #f1c40f 등)은 표면에 묻히지 않게 색감이 남는 어두운 단계로 보낸다
    if (o.C > 0.1) {
      return format({ ...fromOklch({ L: 0.37, C: Math.min(o.C * 0.6, 0.09), H: o.H }), a: c.a });
    }
    // 흰색은 정확히 표면색(--icd-surface)으로, 연한 색일수록 조금 더 밝은 면으로. 무채색은 표면의 남색 기운을 따른다
    const L = SURFACE_O.L + (1 - o.L) * 0.22;
    const tinted = o.C >= 0.02;
    return format({
      ...fromOklch({ L, C: tinted ? Math.min(o.C, 0.06) : SURFACE_O.C, H: tinted ? o.H : SURFACE_O.H }),
      a: c.a,
    });
  }

  // 선 색: 밝은 선은 어두운 선으로, 강조색 선은 글자처럼 읽히게
  function border(value) {
    const c = parse(value);
    if (!c) return null;
    const o = toOklch(c);
    if (o.C > 0.06) return text(value, SURFACE, 3);
    if (o.L > 0.6) return format({ ...fromOklch({ L: 0.38 + (1 - o.L) * 0.2, C: o.C, H: o.H }), a: c.a });
    return format(c);
  }

  // 일정/타임라인의 분류색은 색상과 채도를 지킨다. 원색은 데이터의 구분값이다.
  function category(value) {
    const c = parse(value);
    if (!c) return null;
    const o = toOklch(c);
    const C = Math.max(0.025, o.C * 0.75);
    const bg = fromOklch({ L: 0.31, C: C * 0.7, H: o.H });
    const accent = fromOklch({ L: 0.72, C, H: o.H });
    return { background: format(bg), foreground: format(accent), border: format(accent), bar: format(fromOklch({ L: 0.48, C, H: o.H })) };
  }

  const SURFACE_O = toOklch(SURFACE);
  const api = { parse, luminance, contrast, composite, text, background, border, category, format, toOklch, fromOklch, SURFACE };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else globalThis.ICDColor = api;
})();
