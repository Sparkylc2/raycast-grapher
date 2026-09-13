/**
 * Prints the themes.ray.so install link for a Raycast theme JSON file.
 *
 * Raycast does not read theme files off disk; custom themes arrive through this
 * link, which encodes the palette in the query string. The format mirrors the
 * serialiser inside Raycast 2.3, including the positional colour order.
 * Generating it from the JSON keeps the shared link and the file from drifting.
 *
 * Usage: node scripts/theme-url.mjs themes/kanagawa-dragon.json
 */
import { readFileSync } from "node:fs";

/** Order is significant: themes.ray.so reads the colours positionally. */
const ORDER = [
  "background",
  "backgroundSecondary",
  "text",
  "selection",
  "loader",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "magenta",
];

const path = process.argv[2];
if (!path) {
  console.error("usage: node scripts/theme-url.mjs <theme.json>");
  process.exit(1);
}

const theme = JSON.parse(readFileSync(path, "utf8"));
const missing = ORDER.filter((key) => !theme.colors?.[key]);
if (missing.length) {
  console.error(`theme is missing colours: ${missing.join(", ")}`);
  process.exit(1);
}

// Built by hand rather than with URLSearchParams: that encodes spaces as "+"
// and commas as "%2C", and the links Raycast publishes use "%20" and literal
// commas. Matching the published shape avoids depending on how it parses.
const colors = ORDER.map((key) => encodeURIComponent(theme.colors[key])).join(",");
const parts = [
  `version=${encodeURIComponent(String(theme.version ?? 1))}`,
  `name=${encodeURIComponent(theme.name)}`,
  `colors=${colors}`,
  `appearance=${encodeURIComponent(theme.appearance ?? "dark")}`,
  // Raycast's own "Copy as URL" appends this flag; it is what makes the page
  // offer the import straight away.
  "addToRaycast",
];

console.log(`https://themes.ray.so?${parts.join("&")}`);
