import { createRequire } from "node:module";
import opentype, { type Font } from "opentype.js";
import sharp from "sharp";

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;
// Bump when the card's look changes so crawlers see a new ETag.
export const OG_CARD_REVISION = 1;

export type OgCard = {
  title: string;
  description: string | null;
  slug: string;
  domain: string;
  version: number;
};

type TextStyle = { font: Font; size: number; tracking: number; color: string };
type Styles = Record<"wordmark" | "chip" | "slug" | "domain" | "title" | "description", TextStyle>;

const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const LINK_MARK = [
  "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71",
  "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
];
const MAX_INPUT = 300;
const TITLE = { left: 126, top: 238, maxWidth: 940, maxLines: 3, lineHeight: 1.1 };
const DESCRIPTION = { gap: 18, maxWidth: 900, maxLines: 2, lineHeight: 1.4 };

let styles: Styles | undefined;

function loadStyles(): Styles {
  if (!styles) {
    const require = createRequire(import.meta.url);
    const load = (path: string) => opentype.loadSync(require.resolve(`@ibm/${path}`));
    const mono = load("plex-mono/fonts/complete/woff/IBMPlexMono-Regular.woff");
    styles = {
      wordmark: { font: load("plex-sans/fonts/complete/woff/IBMPlexSans-Bold.woff"), size: 30, tracking: -0.03, color: INK },
      chip: { font: load("plex-mono/fonts/complete/woff/IBMPlexMono-Medium.woff"), size: 22, tracking: 0, color: "#9a4b12" },
      slug: { font: mono, size: 22, tracking: 0, color: MUTED },
      domain: { font: mono, size: 22, tracking: 0, color: INK },
      title: { font: load("plex-sans/fonts/complete/woff/IBMPlexSans-SemiBold.woff"), size: 62, tracking: -0.02, color: INK },
      description: { font: load("plex-sans/fonts/complete/woff/IBMPlexSans-Regular.woff"), size: 26, tracking: 0, color: MUTED },
    };
  }
  return styles;
}

function measure(text: string, style: TextStyle): number {
  return style.font.getAdvanceWidth(text, style.size, { kerning: true, letterSpacing: style.tracking });
}

function drawText(text: string, x: number, baseline: number, style: TextStyle): string {
  const path = style.font.getPath(text, x, baseline, style.size, { kerning: true, letterSpacing: style.tracking });
  const d = path.toPathData(2);
  return d === "" ? "" : `<path d="${d}" fill="${style.color}"/>`;
}

/** Baseline that vertically centres a CSS-style line box of the given height starting at `top`. */
function baselineIn(style: TextStyle, top: number, lineHeight: number): number {
  const scale = style.size / style.font.unitsPerEm;
  const ascent = style.font.ascender * scale;
  const descent = -style.font.descender * scale;
  return top + (lineHeight - (ascent + descent)) / 2 + ascent;
}

/** Drops characters the font can't draw (emoji, CJK) instead of rendering tofu boxes. */
function drawableText(text: string, font: Font): string {
  return Array.from(text)
    .filter((ch) => /\s/.test(ch) || font.charToGlyphIndex(ch) > 0)
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_INPUT);
}

function ellipsize(line: string, style: TextStyle, maxWidth: number): string {
  let text = line.trimEnd();
  while (text.length > 0 && measure(`${text}…`, style) > maxWidth) {
    text = text.slice(0, -1).trimEnd();
  }
  const midWord = text.length < line.trimEnd().length && line.charAt(text.length) !== " ";
  const space = text.lastIndexOf(" ");
  if (midWord && space > text.length * 0.6) {
    text = text.slice(0, space);
  }
  return `${text.replace(/[\s.,;:!?-]+$/, "")}…`;
}

function wrapText(text: string, style: TextStyle, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (measure(candidate, style) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current !== "") {
      lines.push(current);
    }
    current = word;
    while (measure(current, style) > maxWidth && lines.length <= maxLines) {
      let cut = current.length - 1;
      while (cut > 1 && measure(current.slice(0, cut), style) > maxWidth) {
        cut -= 1;
      }
      lines.push(current.slice(0, cut));
      current = current.slice(cut);
    }
    if (lines.length > maxLines) {
      break;
    }
  }
  if (current !== "") {
    lines.push(current);
  }
  if (lines.length <= maxLines) {
    return lines;
  }
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = ellipsize(kept[maxLines - 1] ?? "", style, maxWidth);
  return kept;
}

/** The title and description lines the card draws, after wrapping and clamping. */
export function cardLines(card: Pick<OgCard, "title" | "description">): { title: string[]; description: string[] } {
  const s = loadStyles();
  const title = drawableText(card.title, s.title.font) || "Untitled draft";
  const description = card.description === null ? "" : drawableText(card.description, s.description.font);
  return {
    title: wrapText(title, s.title, TITLE.maxWidth, TITLE.maxLines),
    description: description === "" ? [] : wrapText(description, s.description, DESCRIPTION.maxWidth, DESCRIPTION.maxLines),
  };
}

function linkMark(x: number, y: number, size: number, color: string): string {
  const paths = LINK_MARK.map((d) => `<path d="${d}"/>`).join("");
  return `<g transform="translate(${x} ${y}) scale(${size / 24})" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${paths}</g>`;
}

function ogCardSvg(card: OgCard): string {
  const s = loadStyles();
  const parts = [`<rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="#ebe9e3"/>`];

  parts.push(drawText("Postplan", 72, baselineIn(s.wordmark, 36, 40), s.wordmark));
  const chipLabel = `v${card.version}`;
  const chipWidth = measure(chipLabel, s.chip) + 32;
  parts.push(`<rect x="${1128 - chipWidth}" y="36" width="${chipWidth}" height="40" rx="20" fill="#fff1e0"/>`);
  parts.push(drawText(chipLabel, 1128 - chipWidth + 16, baselineIn(s.chip, 36, 40), s.chip));

  parts.push(`<rect x="73" y="113" width="1054" height="600" rx="15" fill="#ffffff" stroke="#d4d1c9" stroke-width="2"/>`);

  const domainText = `.${card.domain}`;
  const slugWidth = measure(card.slug, s.slug);
  const pillWidth = 1 + 16 + 26 + 12 + slugWidth + measure(domainText, s.domain) + 22 + 1;
  parts.push(`<rect x="126.5" y="154.5" width="${pillWidth - 1}" height="49" rx="24.5" fill="#f6f5f2" stroke="#e4e2dc" stroke-width="1"/>`);
  parts.push(linkMark(143, 166, 26, "#16a34a"));
  const hostBaseline = baselineIn(s.slug, 154, 50);
  parts.push(drawText(card.slug, 181, hostBaseline, s.slug));
  parts.push(drawText(domainText, 181 + slugWidth, hostBaseline, s.domain));

  const lines = cardLines(card);
  const titleLineHeight = s.title.size * TITLE.lineHeight;
  lines.title.forEach((line, i) => {
    const top = TITLE.top + i * titleLineHeight;
    parts.push(drawText(line, TITLE.left, baselineIn(s.title, top, titleLineHeight), s.title));
  });
  const descriptionLineHeight = s.description.size * DESCRIPTION.lineHeight;
  const descriptionTop = TITLE.top + lines.title.length * titleLineHeight + DESCRIPTION.gap;
  lines.description.forEach((line, i) => {
    const top = descriptionTop + i * descriptionLineHeight;
    parts.push(drawText(line, TITLE.left, baselineIn(s.description, top, descriptionLineHeight), s.description));
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_WIDTH}" height="${OG_HEIGHT}" viewBox="0 0 ${OG_WIDTH} ${OG_HEIGHT}">${parts.join("")}</svg>`;
}

export async function renderOgCard(card: OgCard): Promise<Buffer> {
  return sharp(Buffer.from(ogCardSvg(card))).png({ palette: true }).toBuffer();
}
