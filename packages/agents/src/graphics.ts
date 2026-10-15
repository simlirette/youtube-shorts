import { significantTokens } from '@shorts/core';
import type { GraphicSpec } from '@shorts/schemas';

/**
 * Locally rendered motion graphics (Blender) for clauses stock footage cannot show. A graphic may
 * only restate its clause: every number must be spoken in that beat and every content word must
 * occur in the scene narration, so a graphic can never introduce a fact the fact-checker has not
 * seen. Enforced when the beat plan is written and again by content QA on the selected assets.
 */

export const GRAPHIC_TEMPLATES = ['stat', 'compare', 'process', 'keyword'] as const;

/** Renders a graphic to an H.264 1080x1920 MP4 of the given length. */
export interface GraphicRenderer {
  readonly version: string;
  render(spec: GraphicSpec, seconds: number, outPath: string): Promise<void>;
}

/** All text a graphic puts on screen. */
export function graphicText(spec: GraphicSpec): string[] {
  switch (spec.template) {
    case 'stat':
      return [spec.value, spec.label];
    case 'compare':
      return spec.items.flatMap((i) => [i.label, i.display]);
    case 'process':
      return spec.steps;
    case 'keyword':
      return [spec.text];
  }
}

/** Numbers as spoken digits ("617,000" → "617000"; "1.5" stays "1.5"). */
export function numbersIn(text: string): string[] {
  return [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => m[0].replace(/,/g, '').replace(/\.0+$/, ''));
}

export function validateGraphic(spec: GraphicSpec, beatText: string, sceneNarration: string): string[] {
  const v: string[] = [];
  const spoken = new Set(numbersIn(beatText));
  const words = new Set(significantTokens(sceneNarration));
  for (const t of graphicText(spec)) {
    for (const n of numbersIn(t)) if (!spoken.has(n)) v.push(`graphic shows "${n}", which this beat does not say (graphics may only repeat numbers spoken in their clause)`);
    const unknown = significantTokens(t.replace(/\d[\d,.]*/g, ' ')).filter((w) => !words.has(w));
    if (unknown.length) v.push(`graphic text "${t}" uses word(s) not in the narration: ${unknown.map((w) => `"${w}"`).join(', ')}`);
  }
  if (spec.template === 'compare') {
    for (const it of spec.items) {
      const shown = numbersIn(it.display)[0];
      if (shown !== undefined && Number(shown) !== it.value) v.push(`compare item "${it.label}": bar value ${it.value} does not match its label "${it.display}"`);
    }
  }
  if (spec.template === 'stat' && numbersIn(spec.value).length === 0) v.push('a "stat" graphic needs a number spoken in the beat; use "keyword" for a term');
  return [...new Set(v)];
}
