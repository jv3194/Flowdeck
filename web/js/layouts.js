// Where a cover sits in each cover-flow style. Pure math, so every style can be tested without a browser.
//   d     signed distance from the focused card in card units (fractional while the shelf is moving)
//   cw    card width in px
//   tilt  the style's angle control, in degrees (30..75)
// Returns { x, y, z, rotY, rotZ, scale, opacity, shade, origin }: px/deg values for a CSS transform, opacity 0..1,
// `shade` (0..1) darkens covers away from the centre, `origin` is the transform-origin to use.

export const LAYOUTS = [
  ['slab', 'Cover flow'],
  ['carousel', 'Carousel'],
  ['stack', 'Stack'],
  ['fan', 'Fan'],
  ['flat', 'Flat row'],
];

export const REACH = 8; // covers drawn on each side of the focus

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fade = (ad, from, span) => (ad > from ? clamp(1 - (ad - from) / span, 0, 1) : 1);

export function placement(style, d, cw, tilt = 58) {
  const ad = Math.abs(d);
  const s = Math.sign(d);
  const c = Math.min(ad, 1);
  const far = Math.max(ad - 1, 0);
  const out = { x: 0, y: 0, z: 0, rotY: 0, rotZ: 0, scale: 1, opacity: 1, shade: 0, origin: '' };

  switch (style) {
    case 'carousel': {
      // Covers on a ring, each turned to face outward.
      const theta = clamp(d * (24 + (tilt - 30) * 0.2), -92, 92);
      const rad = (theta * Math.PI) / 180;
      const R = cw * 2.3;
      out.x = R * Math.sin(rad);
      out.z = R * (Math.cos(rad) - 1);
      out.rotY = -theta;
      out.opacity = clamp(1 - (Math.abs(theta) - 52) / 34, 0, 1);
      out.shade = clamp(Math.abs(theta) / 95, 0, 0.7);
      break;
    }
    case 'stack': {
      // A deck: neighbours tuck behind the focused card and peek out to each side.
      out.x = s * (c * cw * 0.58 + far * cw * 0.1);
      out.z = -ad * 40;
      out.rotY = -s * c * tilt * 0.22;
      out.scale = 1 - 0.1 * Math.min(ad, 3) + 0.04 * (1 - c);
      out.opacity = fade(ad, 4, 3);
      out.shade = Math.min(ad, 3) * 0.16;
      break;
    }
    case 'fan': {
      // Cards in a hand: rotated about a point well below the shelf.
      out.rotZ = clamp(d * 8 * (tilt / 58), -70, 70);
      out.z = -ad * 20;
      out.scale = 1 - 0.04 * Math.min(ad, 4) + 0.04 * (1 - c);
      out.opacity = fade(ad, 3.5, 3);
      out.shade = c * 0.3 + Math.min(far, 3) * 0.08;
      out.origin = '50% 165%';
      break;
    }
    case 'flat': {
      out.x = d * cw * 1.1 + s * c * cw * 0.08;
      out.z = -c * 30;
      out.scale = 1.08 - 0.22 * Math.min(ad, 1);
      out.opacity = fade(ad, 3, 3.5);
      out.shade = c * 0.35 + Math.min(far, 4) * 0.05;
      break;
    }
    default: {
      // 'slab': the classic cover flow, with the side covers swung toward the viewer by `tilt`.
      out.x = s * (c * cw * 0.68 + far * cw * 0.3);
      out.z = -(c * cw * 0.66 + far * cw * 0.1);
      out.rotY = -s * c * tilt;
      out.scale = 1 + (1 - c) * 0.05;
      out.opacity = fade(ad, 3.4, REACH - 3.7);
      out.shade = c * 0.46 + Math.min(far, 3) * 0.08;
    }
  }
  for (const k of ['x', 'y', 'z', 'rotY', 'rotZ']) out[k] += 0; // turns -0 into 0
  return out;
}
