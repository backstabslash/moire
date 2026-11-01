import plex from "@fontsource/ibm-plex-sans-condensed/files/ibm-plex-sans-condensed-latin-400-normal.woff2?inline";
import mermaid from "mermaid";
import type { DiagramResult } from "../../shared/types";

const FONT = '"IBM Plex Sans Condensed", sans-serif';
const FACE = `@font-face{font-family:"IBM Plex Sans Condensed";font-weight:400;src:url(${plex}) format("woff2")}`;
document.head.append(Object.assign(document.createElement("style"), { textContent: FACE }));

const GANTT_WIDTH = 1000;

let nextId = 0;

// Mermaid returns HTML, and an image only loads well-formed XML: an &nbsp; or a link's xlink:href would stop it decoding.
const asXml = (svg: string) => new XMLSerializer().serializeToString(new DOMParser().parseFromString(svg, "text/html").querySelector("svg")!);

// A diagram is shown as an image, which can't reach the app's fonts, so it carries its own.
const withFont = (svg: string) => svg.replace(/<svg\b[^>]*>/, (tag) => `${tag}<style>${FACE}</style>`);

async function drawDiagram(source: string, themeVariables: Record<string, string | boolean>): Promise<DiagramResult> {
  const id = `moire-diagram-${nextId++}`;
  await document.fonts.load(`14px ${FONT}`);
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    htmlLabels: false,
    fontFamily: FONT,
    theme: "base",
    look: "classic",
    themeVariables,
    // Mermaid sizes a gantt from its container, which has no width here.
    gantt: { useWidth: GANTT_WIDTH },
  });
  try {
    const { svg } = await mermaid.render(id, source);
    return /^<svg\b[^>]*\swidth="0"/.test(svg) ? { error: "it came out with no width" } : { svg: withFont(asXml(svg)) };
  } catch (e) {
    return { error: (e as Error).message };
  } finally {
    document.getElementById(id)?.remove();
  }
}

Object.assign(window, { drawDiagram });
