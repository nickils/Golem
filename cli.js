#!/usr/bin/env node
"use strict";

// golem-bridge: pulls golem.py and golem.md from the Golem Studio plugin
// over Firebase and writes them to ./.golem/

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DB_URL = "https://roblox-golem-default-rtdb.firebaseio.com";
const POLL_INTERVAL_MS = 2000;
const POLL_ATTEMPTS = 45;
const FETCH_TIMEOUT_MS = 30000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
// Channel IDs are hex tokens minted by the Studio plugin (16 chars today,
// tolerated 8-64 for forward compatibility). Anything else is rejected so a
// malformed ID can never alter the request URL.
const CHANNEL_RE = /^[0-9a-fA-F]{8,64}$/;

let VERSION = "unknown";
try {
  VERSION = require("./package.json").version || "unknown";
} catch {
  // running outside the package dir; version is informational only
}

function printHelp() {
  console.log(`golem-bridge v${VERSION} — connect an AI agent to Roblox Studio via the Golem plugin.

Usage:
  golem-bridge connect <channelId> [--print]
  golem-bridge --help
  golem-bridge --version

  <channelId>  shown in the Golem plugin widget inside Roblox Studio.
               Fresh on every Studio start; re-run connect after a restart.
  --print      audit mode: fetch and print both files without writing anything.

connect writes ./.golem/golem.py and ./.golem/golem.md, fetched over HTTPS
from your own Studio session. Review both files before running anything.`);
}

function fail(message, exitCode) {
  console.error(`golem-bridge error: ${message}`);
  process.exit(exitCode || 1);
}

function validateChannel(channelId) {
  if (typeof channelId !== "string" || !CHANNEL_RE.test(channelId)) {
    fail("bad channel ID (expect 8-64 hex characters — copy the full line from the Studio widget).", 2);
  }
  return channelId;
}

async function fetchText(url, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: ctrl.signal,
      redirect: "error", // never follow redirects: responses must come from the relay itself
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from the relay`);
    }
    const text = await res.text();
    if (text.length > MAX_BODY_BYTES) {
      throw new Error("relay response too large, refusing to parse it");
    }
    return text;
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new Error("relay request timed out (30s)");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(url, body) {
  const text = await fetchText(url, JSON.stringify(body));
  return JSON.parse(text);
}

async function getJson(url) {
  const text = await fetchText(url);
  return text === "null" ? null : JSON.parse(text);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function checkFileField(name, value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`relay sent a bad setup payload (missing ${name})`);
  }
  if (value.length > MAX_FILE_BYTES) {
    throw new Error(`relay sent a bad setup payload (${name} too large)`);
  }
  return value;
}

async function fetchSetupFiles(channelId) {
  const cmdId = `setup${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const enc = encodeURIComponent(channelId);
  await postJson(`${DB_URL}/channels/${enc}/cmd.json`, {
    id: cmdId,
    op: "setup",
    ts: Math.floor(Date.now() / 1000),
  });

  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    await sleep(POLL_INTERVAL_MS);
    let keys;
    try {
      keys = await getJson(`${DB_URL}/channels/${enc}/res.json?shallow=true`);
    } catch {
      continue;
    }
    if (!keys) continue;
    const sorted = Object.keys(keys).sort();
    for (const key of sorted) {
      if (typeof key !== "string" || key.length > 128) continue;
      let entry;
      try {
        entry = await getJson(`${DB_URL}/channels/${enc}/res/${encodeURIComponent(key)}.json`);
      } catch {
        continue;
      }
      if (!entry || entry.id !== cmdId) continue;
      if (entry.ok !== true) {
        throw new Error(`setup failed: ${entry.error || "unknown error"}`);
      }
      let result = entry.result;
      if (entry.resultEncoded) {
        if (typeof result !== "string") {
          throw new Error("relay sent a bad setup payload (bad encoding flag)");
        }
        try {
          result = JSON.parse(result);
        } catch {
          throw new Error("relay sent a bad setup payload (unparseable result)");
        }
      }
      if (!result || typeof result !== "object") {
        throw new Error("relay sent a bad setup payload (result is not an object)");
      }
      return {
        source: checkFileField("golem.py", result.source),
        prompt: checkFileField("golem.md", result.prompt),
        instructions:
          typeof result.instructions === "string" && result.instructions.length > 0
            ? result.instructions
            : "Connected.",
      };
    }
  }
  return null;
}

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

async function connect(channelId, printOnly) {
  validateChannel(channelId);
  console.log(`Contacting Golem plugin on channel ${channelId} ...`);
  let files;
  try {
    files = await fetchSetupFiles(channelId);
  } catch (err) {
    fail(err.message, 1);
  }

  if (!files) {
    fail("no response from the Studio plugin. Is Roblox Studio open with Golem running?", 1);
  }

  if (printOnly) {
    console.log("===== golem.py (not written) =====");
    console.log(files.source);
    console.log("===== golem.md (not written) =====");
    console.log(files.prompt);
    console.log("===== connection note =====");
    console.log(files.instructions);
    return;
  }

  const dir = path.join(process.cwd(), ".golem");
  fs.mkdirSync(dir, { recursive: true });

  const pyPath = path.join(dir, "golem.py");
  const mdPath = path.join(dir, "golem.md");
  fs.writeFileSync(pyPath, files.source);
  fs.writeFileSync(mdPath, files.prompt);

  console.log("");
  console.log(files.instructions);
  console.log("");
  console.log(
    `Wrote ${path.relative(process.cwd(), pyPath)} (${files.source.length} bytes, sha256:${sha256(files.source).slice(0, 16)}...)`
  );
  console.log(
    `Wrote ${path.relative(process.cwd(), mdPath)} (${files.prompt.length} bytes, sha256:${sha256(files.prompt).slice(0, 16)}...)`
  );
  console.log("These files were just downloaded from your Studio session — review them before running anything.");
  console.log(`Next: read ${path.relative(process.cwd(), mdPath)}, then run:`);
  console.log(`  python3 ${path.relative(process.cwd(), pyPath)} ping`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    printHelp();
    return;
  }
  if (args[0] === "--version" || args[0] === "-V" || args[0] === "version") {
    console.log(VERSION);
    return;
  }
  if (args[0] !== "connect") {
    printHelp();
    process.exit(2);
  }
  const channelId = args[1];
  const printOnly = args.includes("--print");
  if (!channelId || channelId.startsWith("-")) {
    printHelp();
    process.exit(2);
  }
  try {
    await connect(channelId, printOnly);
  } catch (err) {
    fail(err.message, 1);
  }
}

main();
