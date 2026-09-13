/**
 * The Raycast CLI looks for `./node_modules/.bin/tsc` relative to the extension
 * directory, but npm workspaces hoist that binary to the repo root. Without
 * this link `ray build` and `ray develop` fail at the type-check step.
 */
import { existsSync, mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extensionDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localBin = join(extensionDir, "node_modules", ".bin");
const target = resolve(extensionDir, "..", "..", "node_modules", ".bin", "tsc");
const link = join(localBin, "tsc");

if (!existsSync(target)) {
  console.warn("link-tsc: no hoisted tsc found, skipping");
  process.exit(0);
}

mkdirSync(localBin, { recursive: true });
try {
  unlinkSync(link);
} catch {
  // Nothing to replace.
}
symlinkSync(relative(localBin, target), link);
