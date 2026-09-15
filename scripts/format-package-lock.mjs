// Read package-lock.json, re-format with tab indent, write back.
// Used by version:* and release.mjs to keep package-lock.json
// in canonical npm-format after bun's install reformats it.
import { readFileSync, writeFileSync } from "node:fs";
const lockfile = "package-lock.json";
const data = JSON.parse(readFileSync(lockfile, "utf8"));
writeFileSync(lockfile, JSON.stringify(data, null, "\t") + "\n");
console.log(`format-package-lock: reformatted ${lockfile}`);