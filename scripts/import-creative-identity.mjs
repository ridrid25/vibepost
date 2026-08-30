#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  buildMappingArguments,
  CreativeIdentityError,
  readStrictArtifact,
} from "./lib/creative-identity.mjs";

const VIBEPOST_SUPABASE_ORIGIN = "https://rjtyjybwygfkdekdzqbm.supabase.co";
const RPC_TIMEOUT_MS = 10_000;

function parseArguments(argv) {
  const allowed = new Set([
    "handoff", "result", "user-id", "platform", "video-idea-id",
    "incoming-video-id", "tiktok-video-row-id", "youtube-short-row-id",
  ]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const token = argv[index];
    const value = argv[index + 1];
    if (!token?.startsWith("--") || value === undefined) throw new CreativeIdentityError("CREATIVE_IDENTITY_ARGUMENT_INVALID");
    const key = token.slice(2);
    if (!allowed.has(key) || key in values) throw new CreativeIdentityError("CREATIVE_IDENTITY_ARGUMENT_INVALID");
    values[key] = value;
  }
  for (const required of ["handoff", "result", "user-id", "platform"]) {
    if (!(required in values)) throw new CreativeIdentityError("CREATIVE_IDENTITY_ARGUMENT_INVALID");
  }
  return values;
}

export async function runImport(argv, environment = process.env, fetchImpl = globalThis.fetch) {
  const values = parseArguments(argv);
  const url = environment.SUPABASE_URL?.replace(/\/$/, "");
  const serviceKey = environment.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey || typeof fetchImpl !== "function") throw new CreativeIdentityError("CREATIVE_IDENTITY_ENV_MISSING");
  let endpoint;
  try {
    endpoint = new URL(url);
  } catch {
    throw new CreativeIdentityError("CREATIVE_IDENTITY_ENV_INVALID");
  }
  const localHttp = endpoint.protocol === "http:" && ["127.0.0.1", "localhost"].includes(endpoint.hostname);
  const cleanOrigin = endpoint.username === "" && endpoint.password === "" &&
    endpoint.pathname === "/" && endpoint.search === "" && endpoint.hash === "";
  if (!cleanOrigin || (endpoint.origin !== VIBEPOST_SUPABASE_ORIGIN && !localHttp)) {
    throw new CreativeIdentityError("CREATIVE_IDENTITY_ENV_INVALID");
  }
  const handoff = readStrictArtifact(values.handoff);
  const result = readStrictArtifact(values.result);
  const body = buildMappingArguments({
    handoff,
    result,
    userId: values["user-id"],
    platform: values.platform,
    videoIdeaId: values["video-idea-id"] ?? null,
    incomingVideoId: values["incoming-video-id"] ?? null,
    tiktokVideoRowId: values["tiktok-video-row-id"] ?? null,
    youtubeShortRowId: values["youtube-short-row-id"] ?? null,
  });
  const response = await fetchImpl(`${endpoint.origin}/rest/v1/rpc/upsert_creative_identity_mapping`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!response.ok) throw new CreativeIdentityError("CREATIVE_IDENTITY_RPC_REJECTED");
  const payload = await response.json();
  const stored = Array.isArray(payload) ? payload[0] : payload;
  if (!stored || stored.handoff_id !== handoff.handoff_id || stored.creative_id !== handoff.creative_id || stored.platform !== values.platform) {
    throw new CreativeIdentityError("CREATIVE_IDENTITY_RPC_RESULT_INVALID");
  }
  return { creative_id: stored.creative_id, handoff_id: stored.handoff_id, platform: stored.platform };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  runImport(process.argv.slice(2)).then(
    (result) => { process.stdout.write(`${JSON.stringify(result)}\n`); },
    (error) => {
      const code = error instanceof CreativeIdentityError ? error.code : "CREATIVE_IDENTITY_IMPORT_FAILED";
      process.stderr.write(`${code}\n`);
      process.exitCode = 1;
    },
  );
}
