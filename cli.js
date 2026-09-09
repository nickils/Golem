#!/usr/bin/env node
"use strict";

// golem-bridge: pulls golem.py and golem.md from the Golem Studio plugin
// over Firebase and writes them to ./.golem/

const fs = require("fs");
const path = require("path");

const DB_URL = "https://roblox-golem-default-rtdb.firebaseio.com";
const POLL_INTERVAL_MS = 2000;
const POLL_ATTEMPTS = 45;

function usage() {
  console.error("Usage: golem-bridge connect <channelId>");
  console.error("  <channelId> is shown in the Golem plugin widget inside Roblox Studio.");
  process.exit(1);
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST ${url} failed: HTTP ${res.status}`);
  }
  return res.json();
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} failed: HTTP ${res.status}`);
  }
  const text = await res.text();
  return text === "null" ? null : JSON.parse(text);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchSetupResult(channelId) {
  const cmdId = `setup${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  await postJson(`${DB_URL}/channels/${channelId}/cmd.json`, {
    id: cmdId,
    op: "setup",
    ts: Math.floor(Date.now() / 1000),
  });

  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    await sleep(POLL_INTERVAL_MS);
    let keys;
    try {
      keys = await getJson(`${DB_URL}/channels/${channelId}/res.json?shallow=true`);
    } catch {
      continue;
    }
    if (!keys) continue;
    for (const key of Object.keys(keys).sort()) {
      let entry;
      try {
        entry = await getJson(`${DB_URL}/channels/${channelId}/res/${key}.json`);
      } catch {
        continue;
      }
      if (entry && entry.id === cmdId) {
        return entry;
      }
    }
  }
  return null;
}

async function connect(channelId) {
  if (!channelId || channelId.length < 8) {
    usage();
  }

  console.log(`Contacting Golem plugin on channel ${channelId} ...`);
  const entry = await fetchSetupResult(channelId);

  if (!entry) {
    console.error("No response from the Studio plugin. Is Roblox Studio open with Golem running?");
    process.exit(1);
  }
  if (!entry.ok) {
    console.error(`Setup failed: ${entry.error || "unknown error"}`);
    process.exit(1);
  }

  let result = entry.result;
  if (entry.resultEncoded) {
    result = JSON.parse(result);
  }

  const dir = path.join(process.cwd(), ".golem");
  fs.mkdirSync(dir, { recursive: true });

  const pyPath = path.join(dir, "golem.py");
  const mdPath = path.join(dir, "golem.md");
  fs.writeFileSync(pyPath, result.source);
  fs.writeFileSync(mdPath, result.prompt);

  console.log("");
  console.log(result.instructions || "Connected.");
  console.log("");
  console.log(`Wrote ${path.relative(process.cwd(), pyPath)} and ${path.relative(process.cwd(), mdPath)}`);
  console.log(`Next: read ${path.relative(process.cwd(), mdPath)}, then run:`);
  console.log(`  python3 ${path.relative(process.cwd(), pyPath)} ping`);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd !== "connect") {
    usage();
  }
  try {
    await connect(arg);
  } catch (err) {
    console.error(`golem-bridge error: ${err.message}`);
    process.exit(1);
  }
}

main();
