import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Lit la version dans le premier package.json trouvé en remontant depuis ce module.
function readPackageVersion(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(dir, "package.json"))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("package.json introuvable");
    dir = parent;
  }
  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { version: string };
  return pkg.version;
}

export const APP_VERSION = readPackageVersion();
