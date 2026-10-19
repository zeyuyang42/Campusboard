/** Small color helpers: hex <-> rgb, relative luminance, WCAG contrast, OKLCH lightness steps. */
export type RGB = { r: number; g: number; b: number };

export function hexToRgb(hex: string): RGB {
  const h = hex.replace("#", "");
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

export function rgbToHex({ r, g, b }: RGB): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

function lin(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function luminance({ r, g, b }: RGB): number {
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(a: RGB, b: RGB): number {
  const la = luminance(a), lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// --- OKLCH (via OKLab) ---
export type OKLCH = { L: number; C: number; h: number };

export function rgbToOklch(rgb: RGB): OKLCH {
  const r = lin(rgb.r), g = lin(rgb.g), b = lin(rgb.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const C = Math.hypot(a, bb);
  let h = (Math.atan2(bb, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { L, C, h };
}

export function oklchToRgb({ L, C, h }: OKLCH): RGB {
  const a = C * Math.cos((h * Math.PI) / 180);
  const bb = C * Math.sin((h * Math.PI) / 180);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * bb;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * bb;
  const s_ = L - 0.0894841775 * a - 1.291485548 * bb;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const b = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  const gam = (v: number) => {
    const c = Math.max(0, Math.min(1, v));
    return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  };
  return { r: gam(r), g: gam(g), b: gam(b) };
}

/** True when the color is in sRGB gamut (before clamping). */
function inGamut({ L, C, h }: OKLCH): boolean {
  const a = C * Math.cos((h * Math.PI) / 180), bb = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * bb) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * bb) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * bb) ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const b = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return [r, g, b].every((v) => v >= -0.0005 && v <= 1.0005);
}

/** Reduce chroma until the color fits in sRGB. */
export function toGamut(c: OKLCH): OKLCH {
  let { C } = c;
  let out = { ...c };
  for (let i = 0; i < 24 && !inGamut(out); i++) {
    C *= 0.85;
    out = { ...c, C };
  }
  return inGamut(out) ? out : { ...c, C: 0 };
}

/**
 * Move a color's lightness away from the surface until the contrast ratio is met.
 * Hue is preserved; chroma is reduced only when needed to stay in gamut.
 */
export function ensureContrast(color: RGB, surface: RGB, minRatio: number): RGB {
  if (contrast(color, surface) >= minRatio) return color;
  const base = rgbToOklch(color);
  const surfaceL = rgbToOklch(surface).L;
  const dir = surfaceL > 0.5 ? -1 : 1; // light surface: darken; dark surface: lighten
  for (let step = 1; step <= 40; step++) {
    const L = Math.max(0, Math.min(1, base.L + dir * step * 0.02));
    // Rounded to whole channels, as it will be painted (hex), so the ratio holds after rounding.
    const candidate = hexToRgb(rgbToHex(oklchToRgb(toGamut({ ...base, L }))));
    if (contrast(candidate, surface) >= minRatio) return candidate;
  }
  return dir > 0 ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
}

export function textOn(bg: RGB): "#000000" | "#ffffff" {
  return contrast(bg, { r: 0, g: 0, b: 0 }) >= contrast(bg, { r: 255, g: 255, b: 255 }) ? "#000000" : "#ffffff";
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}
