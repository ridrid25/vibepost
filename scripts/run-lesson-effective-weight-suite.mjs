import { spawnSync } from "node:child_process";

const files = [
  "scripts/lesson-effective-weight.test.mjs",
  "scripts/lesson-effective-weight-db.test.mjs",
  "scripts/tiktok-feedback-loop.test.mjs",
  "scripts/youtube-own-learning.test.mjs",
  "scripts/creative-mutation-lineage.test.mjs",
  "scripts/tiktok-market-reference.test.mjs",
  "scripts/tiktok-market-to-idea.test.mjs",
];

const run = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(run.status ?? 1);
