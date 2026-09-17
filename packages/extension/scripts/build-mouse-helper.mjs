// Compiles the mouse helper into assets/, where the extension finds it.
// Built from source on every machine rather than shipped as a binary. A missing
// compiler just leaves mouse input off; a failed compile stops the build loudly.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "swift", "mouse-helper.swift");
const output = join(root, "assets", "mouse-helper");

if (existsSync(output) && statSync(output).mtimeMs >= statSync(source).mtimeMs) process.exit(0);
try {
  execFileSync("swiftc", ["--version"], { stdio: "ignore" });
} catch {
  console.warn("Mouse input is unavailable: building its helper needs swiftc, from Xcode's command line tools.");
  process.exit(0);
}
mkdirSync(dirname(output), { recursive: true });
execFileSync("swiftc", ["-O", source, "-o", output], { stdio: "inherit" });
console.log("built the mouse helper");
