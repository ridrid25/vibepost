import { spawnSync } from "node:child_process";

const files = [
  "scripts/meta-first-closed-loop.test.mjs",
  "scripts/creative-mutation-lineage.test.mjs",
  "scripts/lesson-effective-weight.test.mjs",
];
const run = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(run.status ?? 1);
