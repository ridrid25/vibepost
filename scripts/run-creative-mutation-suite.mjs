import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const pglite = "tools/post09-db-harness/node_modules/@electric-sql/pglite/dist/index.js";
if (!existsSync(pglite)) {
  const install = spawnSync("npm", ["ci", "--prefix", "tools/post09-db-harness", "--ignore-scripts",
    "--no-audit", "--no-fund"], { stdio: "inherit", shell: process.platform === "win32" });
  if (install.status !== 0) process.exit(install.status ?? 1);
}

const files = [
  "scripts/creative-mutation-lineage.test.mjs",
  "scripts/creative-identity.test.mjs",
  "scripts/tiktok-feedback-loop.test.mjs",
  "scripts/youtube-own-learning.test.mjs",
  "scripts/creative-mutation-lineage-db.test.mjs",
];
const run = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(run.status ?? 1);
