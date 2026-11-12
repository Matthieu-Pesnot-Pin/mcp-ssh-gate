import fs from "node:fs";
import path from "node:path";
import { DEFAULT_HIGHLIGHT_PALETTE, HIGHLIGHT_PALETTES, type GuiSettings, type HighlightPalette } from "../../shared/model.js";
import { GateError } from "./errors.js";
import { readJson, withFileLock, writeJsonAtomic } from "./files.js";

function isPalette(value: unknown): value is HighlightPalette {
  return HIGHLIGHT_PALETTES.includes(value as HighlightPalette);
}

/** Réglages de l'interface : `<DATA_DIR>/settings.json`. Un réglage absent prend sa valeur par défaut. */
export class SettingsStore {
  private readonly file: string;
  private readonly lockFile: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "settings.json");
    this.lockFile = `${this.file}.lock`;
  }

  get(): GuiSettings {
    const stored = fs.existsSync(this.file) ? readJson<Partial<GuiSettings>>(this.file) : {};
    if (stored.palette === undefined) return { palette: DEFAULT_HIGHLIGHT_PALETTE };
    if (!isPalette(stored.palette)) throw new GateError(`settings.json contient une palette inconnue : « ${String(stored.palette)} ».`);
    return { palette: stored.palette };
  }

  setPalette(palette: unknown): GuiSettings {
    if (!isPalette(palette)) {
      throw new GateError(`Palette inconnue : « ${String(palette)} ». Palettes possibles : ${HIGHLIGHT_PALETTES.join(", ")}.`);
    }
    return withFileLock(this.lockFile, "settings.json", () => {
      const settings = { ...this.get(), palette };
      writeJsonAtomic(this.file, settings);
      return settings;
    });
  }
}
