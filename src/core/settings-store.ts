import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_HIGHLIGHT_PALETTE,
  DEFAULT_LINE_BREAK_MODE,
  HIGHLIGHT_PALETTES,
  LINE_BREAK_MODES,
  type GuiSettings,
} from "../../shared/model.js";
import { GateError } from "./errors.js";
import { readJson, withFileLock, writeJsonAtomic } from "./files.js";

interface SettingSpec<T extends string> {
  allowed: readonly T[];
  fallback: T;
  label: string;
}

const SPECS: { [K in keyof GuiSettings]: SettingSpec<GuiSettings[K]> } = {
  palette: { allowed: HIGHLIGHT_PALETTES, fallback: DEFAULT_HIGHLIGHT_PALETTE, label: "Palette inconnue" },
  lineBreaks: { allowed: LINE_BREAK_MODES, fallback: DEFAULT_LINE_BREAK_MODE, label: "Mode de coupure inconnu" },
};

/** Réglages de l'interface : `<DATA_DIR>/settings.json`. Un réglage absent prend sa valeur par défaut. */
export class SettingsStore {
  private readonly file: string;
  private readonly lockFile: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "settings.json");
    this.lockFile = `${this.file}.lock`;
  }

  get(): GuiSettings {
    const stored = fs.existsSync(this.file) ? readJson<Record<string, unknown>>(this.file) : {};
    const read = <K extends keyof GuiSettings>(key: K): GuiSettings[K] => {
      const spec = SPECS[key];
      const value = stored[key];
      if (value === undefined) return spec.fallback;
      if (!spec.allowed.includes(value as GuiSettings[K])) {
        throw new GateError(`settings.json contient une valeur inconnue pour ${key} : « ${String(value)} ».`);
      }
      return value as GuiSettings[K];
    };
    return { palette: read("palette"), lineBreaks: read("lineBreaks") };
  }

  set<K extends keyof GuiSettings>(key: K, value: unknown): GuiSettings {
    const spec = SPECS[key];
    if (!spec.allowed.includes(value as GuiSettings[K])) {
      throw new GateError(`${spec.label} : « ${String(value)} ». Valeurs possibles : ${spec.allowed.join(", ")}.`);
    }
    return withFileLock(this.lockFile, "settings.json", () => {
      const settings = { ...this.get(), [key]: value };
      writeJsonAtomic(this.file, settings);
      return settings;
    });
  }
}
