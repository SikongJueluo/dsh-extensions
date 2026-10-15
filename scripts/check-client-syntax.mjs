#!/usr/bin/env node
// Syntax guard for the browser half plugins.
//
// dsh serves packages/*/client/*.js verbatim (exports["./client"] with
// dsh.client.platform = "web"): no tsdown, no tsc. A syntax error there kills
// the whole module factory, so the client boot loader only reports
// "<name>: import failed (see console for the import error)" and
// "web boot: N entries did not activate" — which is exactly how the missing
// paren in context-audit/client/client.js slipped through `pnpm check`.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function collect(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...collect(path));
    else if (entry.name.endsWith(".js")) found.push(path);
  }
  return found;
}

const files = [];
for (const pkg of readdirSync(join(root, "packages"), { withFileTypes: true })) {
  if (!pkg.isDirectory()) continue;
  const client = join(root, "packages", pkg.name, "client");
  try {
    files.push(...collect(client));
  } catch {
    // no client half in this package
  }
}

const failures = [];
for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    failures.push([relative(root, file), String(error.stderr || error.message)]);
  }
}

if (failures.length > 0) {
  for (const [file, message] of failures) {
    process.stderr.write(`${file}\n${message.trimEnd()}\n\n`);
  }
  process.stderr.write(`client syntax: ${failures.length}/${files.length} file(s) failed\n`);
  process.exit(1);
}

process.stdout.write(`client syntax: ${files.length} file(s) ok\n`);
