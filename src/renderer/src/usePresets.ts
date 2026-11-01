import { useEffect, useLayoutEffect, useState } from "react";
import { type Preset, paletteOf, presetCss, resolvePresets, safePaletteOf, toneBaseOf } from "./model/presets";
import { hardToRead, PALETTE_VARS, type Palette } from "./model/themeRules";
import { THEMES } from "./model/themes";

const CACHE = "moire.presets";

function readPalette(id: string, cvd: boolean): Palette {
  const probe = document.createElement("span");
  probe.dataset.theme = id;
  probe.dataset.cvd = cvd ? "on" : "off";
  probe.hidden = true;
  document.body.append(probe);
  const css = getComputedStyle(probe);
  const palette = Object.fromEntries(PALETTE_VARS.map((key) => [key, css.getPropertyValue(`--${key}`).trim()]));
  probe.remove();
  return palette;
}

function build(presets: Preset[], problems: string[]) {
  const warnings: Record<string, string[]> = {};
  const sheet = presets.map((preset) => {
    const palette = paletteOf(readPalette(toneBaseOf(preset), false), preset.colors, preset.tone);
    const safe = safePaletteOf(readPalette(toneBaseOf(preset), true), palette, preset.colors, preset.tone);
    const missed = hardToRead(palette);
    const list = missed.length ? missed : hardToRead(safe).map((problem) => `With colour-blind plates, ${problem}`);
    if (list.length) warnings[preset.id] = list;
    return presetCss(preset, palette, safe);
  });
  return { themes: [...THEMES, ...presets], sheet: sheet.join("\n"), problems, warnings };
}

// The file loads asynchronously, so the last good copy is kept here to colour the first frame.
function firstBuild() {
  const { presets, problems } = resolvePresets(localStorage.getItem(CACHE));
  return build(presets ?? [], problems);
}

export function usePresets() {
  const [built, setBuilt] = useState(firstBuild);

  useLayoutEffect(() => {
    const style =
      document.getElementById("moire-presets") ?? document.head.appendChild(Object.assign(document.createElement("style"), { id: "moire-presets" }));
    style.textContent = built.sheet;
  }, [built.sheet]);

  useEffect(() => {
    const load = () => {
      window.moire.themes().then(
        (text) => {
          const { presets, problems } = resolvePresets(text);
          if (!presets) {
            setBuilt((last) => ({ ...last, problems }));
            return;
          }
          if (text === null) localStorage.removeItem(CACHE);
          else localStorage.setItem(CACHE, text);
          setBuilt(build(presets, problems));
        },
        (e) => setBuilt((last) => ({ ...last, problems: [`It can't be read, so the last themes stay (${(e as Error).message}).`] })),
      );
    };
    load();
    return window.moire.onThemesChanged(load);
  }, []);

  return built;
}
