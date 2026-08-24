import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, "dist");
mkdirSync(dest, { recursive: true });
cpSync(join(root, "src", "views"), join(dest, "views"), { recursive: true });
cpSync(join(root, "src", "public"), join(dest, "public"), { recursive: true });
