import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const action = process.argv[2] ?? "status";
if (![
  "status",
  "prepare",
  "negative",
  "verify",
  "complete",
  "rollback",
].includes(action)) {
  console.error("ACTION_INVALID");
  process.exit(2);
}

const env = readEnv();
const baseUrl = required("SUPABASE_URL").replace(/\/+$/u, "");
const anonKey = required("SUPABASE_ANON_KEY");
const email = requiredAny("USER_EMAIL", "TEST_USER_EMAIL");
const password = requiredAny("USER_PASSWORD", "TEST_USER_PASSWORD");
let accessToken = "";

try {
  accessToken = await signIn();
  if (action === "status") {
    const health = await request("GET", "/functions/v1/content-factory-leads-canary/health", null, false);
    print({
      action,
      post13c_runtime: health.status,
      post13d_runtime: health.post13d_status ?? "NOT_CONFIGURED",
      version: health.version,
    });
  } else if (action === "prepare") {
    const result = await control("prepare");
    const audit = await audit("PRE_OWNER");
    print({ action, ...result, pre_owner_audit: audit });
  } else if (action === "negative") {
    const result = await control("negative_check");
    print({ action, ...result });
  } else if (action === "verify") {
    const first = await evidence();
    const second = await evidence();
    const auditResult = await audit("ACTIVE_COMPLETE");
    print({
      action,
      evidence: summarizeEvidence(first),
      repeated_read_stable: canonicalHash(first) === canonicalHash(second),
      audit: auditResult,
    });
  } else if (action === "complete") {
    const result = await control("complete");
    const first = await evidence();
    const second = await evidence();
    const auditResult = await audit("COMPLETED");
    print({
      action,
      ...result,
      evidence: summarizeEvidence(first),
      repeated_read_stable: canonicalHash(first) === canonicalHash(second),
      audit: auditResult,
    });
  } else {
    const result = await control("rollback");
    print({ action, ...result });
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "POST13D_LIVE_FAILED");
  process.exitCode = 1;
} finally {
  accessToken = "";
}

async function signIn() {
  const response = await fetch(
    `${baseUrl}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: { "content-type": "application/json", apikey: anonKey },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  const body = await response.json().catch(() => null);
  if (!response.ok || typeof body?.access_token !== "string") {
    throw new Error("AUTH_FAILED");
  }
  return body.access_token;
}

function control(controlAction) {
  return request(
    "POST",
    "/functions/v1/content-factory-leads-canary-retry-control",
    { action: controlAction },
  );
}

function evidence() {
  return request(
    "GET",
    "/functions/v1/content-factory-leads-canary/evidence-post13d",
  );
}

async function audit(phase) {
  const result = await request(
    "GET",
    `/functions/v1/content-factory-leads-canary/audit-post13d?phase=${phase}`,
  );
  return {
    phase: result.phase,
    passed: result.passed,
    check_count: Array.isArray(result.checks) ? result.checks.length : 0,
    failed_checks: Array.isArray(result.checks)
      ? result.checks.filter((row) => row.passed !== true).map((row) => row.check_name)
      : ["AUDIT_RESPONSE_INVALID"],
  };
}

async function request(method, path, body = null, authenticated = true) {
  const headers = { apikey: anonKey };
  if (authenticated) headers.authorization = `Bearer ${accessToken}`;
  if (body !== null) headers["content-type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok || !value || typeof value !== "object") {
    throw new Error(`HTTP_${response.status}_${value?.error ?? "INVALID_RESPONSE"}`);
  }
  return value;
}

function summarizeEvidence(value) {
  const events = Array.isArray(value?.events) ? value.events : [];
  const starts = events.filter((row) => row.event_type === "BOT_START");
  const leads = events.filter((row) => row.event_type === "CANARY_LEAD_CREATED");
  return {
    event_count: events.length,
    bot_start_count: starts.length,
    canary_lead_created_count: leads.length,
    canary_run_count: new Set(events.map((row) => row.canary_run_id)).size,
    creative_count: new Set(events.map((row) => row.creative_id)).size,
    publication_count: new Set(events.map((row) => row.publication_id)).size,
    same_subject: events.length === 2 && events[0].subject_id === events[1].subject_id,
    attribution_quality: leads[0]?.attribution_quality ?? "NONE",
    source_system: value?.source_system ?? "UNKNOWN",
  };
}

function canonicalHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function readEnv() {
  const result = {};
  for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split(/\r?\n/u)) {
    const match = /^([A-Z0-9_]+)=(.*)$/u.exec(line);
    if (!match) continue;
    result[match[1]] = match[2].trim().replace(/^['"]|['"]$/gu, "");
  }
  return result;
}

function required(name) {
  const value = env[name];
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}

function requiredAny(...names) {
  for (const name of names) {
    if (env[name]) return env[name];
  }
  throw new Error(`${names.join("_OR_")}_MISSING`);
}

function print(value) {
  console.log(JSON.stringify(value));
}
