/*
MIT License

Copyright (c) 2026 callum and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE. 
*/
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { execSync } from "node:child_process";
import semver from "semver";
import { info, step, error, fail } from "./log.js";
import readlineSync from "readline-sync";
import toml from "@iarna/toml";

// ------------------------------------------------------------
// MANIFEST
// ------------------------------------------------------------

function writeManifest(manifest) {
  step("writing manifest to callum.toml");
  const lines = [];
  lines.push("[dependencies]");

  const deps = manifest.dependencies || {};
  for (const [name, version] of Object.entries(deps)) {
    lines.push(`${name} = "${version}"`);
  }

  fs.writeFileSync("callum.toml", `${lines.join("\n")}\n`);
}

function readManifest(createIfMissing = false) {
  if (!fs.existsSync("callum.toml")) {
    if (createIfMissing) {
      const initialManifest = { dependencies: {} };
      writeManifest(initialManifest);
      return initialManifest;
    }
    fail('manifest "callum.toml" not found');
  }
  const raw = fs.readFileSync("callum.toml", "utf8");
  return toml.parse(raw);
}

function addDependencyToManifest(name, version) {
  if (!name) {
    fail("usage: node index.js add <package> [version]");
  }

  const manifest = readManifest(true);
  const dependencies = manifest.dependencies || {};
  dependencies[name] = version || "*";
  manifest.dependencies = dependencies;

  writeManifest(manifest);
  info(`added ${name}@${version || "*"} to callum.toml`);
}

function getBaseVersion(range) {
  if (!range || range === "*" || range === "latest") {
    return null;
  }

  const exact = semver.valid(range);
  if (exact) {
    return semver.parse(exact);
  }

  const coerced = semver.coerce(range);
  return coerced ? semver.parse(coerced.version) : null;
}

async function updateDependenciesInManifest(allowMajorUpgrades = false) {
  const manifest = readManifest();
  const dependencies = manifest.dependencies || {};
  const updated = {};

  for (const [name, currentRange] of Object.entries(dependencies)) {
    try {
      const meta = await fetchJson(`https://registry.npmjs.org/${name}`);
      const versions = Object.keys(meta.versions || {}).filter((version) => semver.valid(version));
      if (!versions.length) {
        updated[name] = currentRange;
        continue;
      }

      const latestVersion = semver.sort(versions).at(-1);
      const baseVersion = getBaseVersion(currentRange);
      const latestSafeVersion = allowMajorUpgrades || !baseVersion
        ? latestVersion
        : semver.maxSatisfying(versions, `^${baseVersion.major}.${baseVersion.minor}.${baseVersion.patch}`);

      if (!latestSafeVersion) {
        updated[name] = currentRange;
        continue;
      }

      const currentComparable = baseVersion || semver.parse(latestVersion);
      const targetVersion = semver.gt(latestSafeVersion, currentComparable)
        ? latestSafeVersion
        : currentComparable.version;

      updated[name] = targetVersion;
      if (targetVersion !== currentComparable.version) {
        info(`updated ${name} from ${currentComparable.version} to ${targetVersion}`);
      }
    } catch (e) {
      error(`failed to update ${name}: ${e.message}`);
      updated[name] = currentRange;
    }
  }

  manifest.dependencies = updated;
  writeManifest(manifest);
  info("dependency update complete");
}

function findDependencyReferences(name) {
  step(`searching for references to ${name} in codebase`);
  const root = process.cwd();
  const results = [];
  const visited = new Set();
  const stack = [root];

  while (stack.length) {

    const current = stack.pop();
    if (!current || visited.has(current)) continue;
    visited.add(current);

    let stat;
    try {
      stat = fs.statSync(current);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory() && [".git", "node_modules"].includes(entry.name)) {
          continue;
        }
        stack.push(fullPath);
      }
      continue;
    }

    if (!/\.(js|ts|jsx|tsx|mjs|cjs)$/i.test(current)) {
      continue;
    }

    try {
      const content = fs.readFileSync(current, "utf8");
      const patterns = [
        new RegExp(`(?:import|export)\\s+.*from\\s+['\"]${name}['\"]`, "i"),
        new RegExp(`require\\s*\\(\\s*['\"]${name}['\"]\\s*\\)`, "i"),
        new RegExp(`(?:import|export)\\s*\\{[^}]*\\}\s*from\\s*['\"]${name}['\"]`, "i"),
      ];

      if (patterns.some((pattern) => pattern.test(content))) {
        results.push(path.relative(root, current));
      }
    } catch {
      error(`failed to read file: ${current}`);
    }
  }

  return results;
}

function removeDependencyFromManifest(name, breakCodebase = false) {
  if (!name) {
    fail("usage: node index.js remove <package> [--break-codebase]");
  }

  const manifest = readManifest();
  const dependencies = manifest.dependencies || {};

  if (!Object.prototype.hasOwnProperty.call(dependencies, name)) {
    fail(`dependency "${name}" is not present in callum.toml`);
  }

  const references = findDependencyReferences(name);
  if (references.length > 0 && !breakCodebase) {
    fail(`refusing to remove "${name}" because it is still referenced in the codebase.\nPlease remove those references first or rerun with --break-codebase to force removal. (The following files are affected: ${references.join(", \n")})`);
  }

  delete dependencies[name];
  manifest.dependencies = dependencies;
  writeManifest(manifest);

  const installedDir = path.join(process.cwd(), "node_modules", name);
  if (fs.existsSync(installedDir)) {
    fs.rmSync(installedDir, { recursive: true, force: true });
    info(`removed ${name} from node_modules`);
  }

  info(`removed ${name} from callum.toml`);
  info(`After this operation, you should run autoremove-unused to remove any unused dependencies that this operation may have caused.`)
}

function readLockfile() {
  const lockfilePath = path.join(process.cwd(), "callum-lock.toml");
  if (!fs.existsSync(lockfilePath)) return [];

  const content = fs.readFileSync(lockfilePath, "utf8");
  const packages = [];
  const entries = content.split(/\n\s*\[\[package\]\]\s*\n?/).slice(1);

  for (const entry of entries) {
    const lines = entry.split(/\n/).map((line) => line.trim()).filter(Boolean);
    const pkg = {};
    for (const line of lines) {
      const match = line.match(/^(name|version|resolved)\s*=\s*"([^"]+)"/);
      if (match) pkg[match[1]] = match[2];
    }
    if (pkg.name) packages.push(pkg);
  }

  return packages;
}

function collectJavaScriptReferences(rootDir) {
  const references = new Set();
  const visited = new Set();
  const stack = [rootDir];

  while (stack.length) {
    const current = stack.pop();
    if (!current || visited.has(current)) continue;
    visited.add(current);

    let stat;
    try {
      stat = fs.statSync(current);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory() && [".git", "node_modules"].includes(entry.name)) continue;
        stack.push(fullPath);
      }
      continue;
    }

    if (!/\.(js|ts|jsx|tsx|mjs|cjs)$/i.test(current)) continue;

    try {
      const content = fs.readFileSync(current, "utf8");
      const packagePattern = /(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"/]+)['"]/gi;
      const requirePattern = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/gi;

      for (const match of content.matchAll(packagePattern)) {
        references.add(match[1]);
      }
      for (const match of content.matchAll(requirePattern)) {
        references.add(match[1]);
      }
    } catch {
      // ignore unreadable files
    }
  }

  return references;
}

function listUnusedDependencies() {
  const manifest = readManifest();
  const declared = new Set(Object.keys(manifest.dependencies || {}));
  const installedDir = path.join(process.cwd(), "node_modules");
  if (!fs.existsSync(installedDir)) return [];

  // Read installed top-level packages
  const packageDirs = fs.readdirSync(installedDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith("."));

  // Load dependency info for each installed package
  const packageInfo = new Map();
  for (const name of packageDirs) {
    const packageJsonPath = path.join(installedDir, name, "package.json");
    if (!fs.existsSync(packageJsonPath)) continue;

    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      packageInfo.set(name, {
        name,
        dependencies: Object.keys(packageJson.dependencies || {}),
        peerDependencies: Object.keys(packageJson.peerDependencies || {}),
      });
    } catch {
      packageInfo.set(name, { name, dependencies: [], peerDependencies: [] });
    }
  }

  // Collect actual imports from JS/TS files
  const referencedPackages = collectJavaScriptReferences(process.cwd());

  // Reachable packages start ONLY from actual imports
  const reachable = new Set();
  const pending = [];

  // Add referenced packages (including scoped ones)
  for (const ref of referencedPackages) {
    // Ignore local paths like "./x" or "/x"
    if (ref.startsWith(".") || ref.startsWith("/")) continue;

    // Scoped packages: @scope/name
    if (ref.startsWith("@")) {
      const parts = ref.split("/");
      if (parts.length >= 2) {
        reachable.add(`${parts[0]}/${parts[1]}`);
        pending.push(`${parts[0]}/${parts[1]}`);
      }
      continue;
    }

    // Normal bare imports
    reachable.add(ref);
    pending.push(ref);
  }

  // Follow dependency graph from reachable packages
  while (pending.length) {
    const current = pending.pop();
    if (!current || reachable.has(current)) continue;
    reachable.add(current);

    const currentInfo = packageInfo.get(current);
    if (!currentInfo) continue;

    for (const dep of [...currentInfo.dependencies, ...currentInfo.peerDependencies]) {
      if (!reachable.has(dep)) pending.push(dep);
    }
  }

  // Anything installed but NOT reachable and NOT declared is unused
  const unused = [];
  for (const name of packageDirs) {
    if (reachable.has(name)) continue;  // used deps are kept
    unused.push(name);                  // everything else is unused
  }

  return unused;
}


function autoremoveUnusedDependencies() {
  const unused = listUnusedDependencies();
  if (!unused.length) {
    info("no unused dependencies found");
    return;
  }
  var unusedCount = 0;
  info("The following packages will be REMOVED:");
  for (const name of unused) {
    info(`- ${name}`);
    unusedCount++;
    if (unusedCount >= 20) { 
      info("etc... (to see full list, run list-unused)");
      break;
    }
  }
  const confirm = readlineSync.question("Are you sure you want to continue? (yes/N): ");
  if (confirm.toLowerCase() !== "yes") {
    info("operation cancelled");
    return;
  }
  for (const name of unused) {
    step("Removing " + name);
    const installedDir = path.join(process.cwd(), "node_modules", name);
    if (fs.existsSync(installedDir)) {
      fs.rmSync(installedDir, { recursive: true, force: true });
    }
  }
  const manifest = toml.parse(fs.readFileSync("callum.toml", "utf8"));

  for (const name of unused) {
    step(`removing ${name} from manifest`);
    delete manifest.dependencies[name];
  }

  fs.writeFileSync("callum.toml", toml.stringify(manifest));

  info("autoremoved unused dependencies");
}

// ------------------------------------------------------------
// REGISTRY FETCH
// ------------------------------------------------------------

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

// ------------------------------------------------------------
// RESOLUTION
// ------------------------------------------------------------

async function resolvePackage(name, range) {
  step(`resolving ${name}@${range}`);
  const meta = await fetchJson(`https://registry.npmjs.org/${name}`);
  const versions = Object.keys(meta.versions || {});
  const picked = semver.maxSatisfying(versions, range);
  if (!picked) {
    fail(`no version of "${name}" satisfies range "${range}"`);
  }
  const info = meta.versions[picked];
  return {
    name,
    version: picked,
    tarball: info.dist.tarball,
    dependencies: info.dependencies || {},
  };
}

function detectConflicts(resolved) {
  const seen = new Map();
  for (const pkg of resolved) {
    if (!seen.has(pkg.name)) {
      seen.set(pkg.name, pkg.version);
      continue;
    }
    const existing = seen.get(pkg.name);
    if (existing !== pkg.version) {
      fail(`dependency conflict for "${pkg.name}": ${existing} vs ${pkg.version}`);
    }
  }
}

async function resolveAll(rootDeps) {
  const resolved = [];
  const seen = new Map();
  const queue = [...Object.entries(rootDeps)];

  while (queue.length) {
    const [name, range] = queue.shift();

    if (seen.has(name)) {
      continue;
    }

    const pkg = await resolvePackage(name, range);
    resolved.push(pkg);
    seen.set(name, pkg.version);

    for (const [depName, depRange] of Object.entries(pkg.dependencies)) {
      if (!seen.has(depName)) {
        queue.push([depName, depRange]);
      }
    }
  }

  detectConflicts(resolved);
  return resolved;
}

// ------------------------------------------------------------
// LOCKFILE
// ------------------------------------------------------------

function writeLockfile(resolved) {
  let out = "";
  out += "# ------------------------------------------------------------\n";
  out += "# This file is auto-generated by Callum PM. Do not edit manually.\n";
  out += "# ------------------------------------------------------------\n\n";
  for (const pkg of resolved) {
    out += `[[package]] # ${pkg.name}@${pkg.version}\n`;
    out += `name = "${pkg.name}"\n`;
    out += `version = "${pkg.version}"\n`;
    out += `resolved = "${pkg.tarball}"\n\n`;
  }
  fs.writeFileSync("callum-lock.toml", out);
}

// ------------------------------------------------------------
// CACHE
// ------------------------------------------------------------

function getCachePath(pkg) {
  const home = process.env.HOME || process.env.USERPROFILE;
  const cacheDir = path.join(home, ".calpm", "cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  return path.join(cacheDir, `${pkg.name}-${pkg.version}.tgz`);
}

// ------------------------------------------------------------
// INSTALL CHECK
// ------------------------------------------------------------

function isAlreadyCorrectlyInstalled(pkg) {
  const finalDir = path.join("node_modules", pkg.name);
  const pkgJsonPath = path.join(finalDir, "package.json");

  if (!fs.existsSync(finalDir)) return false;
  if (!fs.existsSync(pkgJsonPath)) return false;

  try {
    const installed = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
    return installed.version === pkg.version;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------
// DOWNLOAD + EXTRACT
// ------------------------------------------------------------

async function downloadAndExtract(pkg) {
  const finalDir = path.join("node_modules", pkg.name);

  if (isAlreadyCorrectlyInstalled(pkg)) {
    info(`skipped ${pkg.name}@${pkg.version} (Requirements are already satisfied)`);
    return;
  }

  const destTgz = path.join("node_modules", `${pkg.name}.tgz`);
  const temp = path.join("node_modules", `${pkg.name}-tmp`);
  const cacheFile = getCachePath(pkg);

  if (fs.existsSync(temp)) {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  if (fs.existsSync(cacheFile)) {
    step(`cache hit for ${pkg.name}@${pkg.version}`);
    fs.copyFileSync(cacheFile, destTgz);
  } else {
    step(`downloading ${pkg.name}@${pkg.version}`);

    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(destTgz);
      https
        .get(pkg.tarball, (res) => {
          const total = Number(res.headers["content-length"]) || 0;
          let downloaded = 0;

          res.on("data", (chunk) => {
            downloaded += chunk.length;
            if (total > 0) {
              const pct = ((downloaded / total) * 100).toFixed(1);
              process.stdout.write(`  ${pkg.name}: ${pct}%\r`);
            }
          });

          res.on("end", () => {
            process.stdout.write("\n");
          });

          res.pipe(file);
          file.on("finish", () => file.close(resolve));
        })
        .on("error", reject);
    });

    fs.copyFileSync(destTgz, cacheFile);
  }

  fs.mkdirSync(temp, { recursive: true });
  execSync(`tar -xzf "${destTgz}" -C "${temp}"`);

  const pkgDir = path.join(temp, "package");

  if (fs.existsSync(finalDir)) {
    fs.rmSync(finalDir, { recursive: true, force: true });
  }

  fs.renameSync(pkgDir, finalDir);

  fs.rmSync(temp, { recursive: true, force: true });
  fs.rmSync(destTgz, { force: true });

  info(`installed ${pkg.name}@${pkg.version}`);
}

// ------------------------------------------------------------
// MAIN
// ------------------------------------------------------------
const VALID_COMMANDS = [
  "add",
  "remove",
  "update",
  "list-unused",
  "autoremove",
  "install"
];

async function main() {
  const [command, pkgName, pkgVersion] = process.argv.slice(2);
  if (!VALID_COMMANDS.includes(command)) {
    fail(`Unknown command: "${command}"`);
  }
  if (command === "add") {
    addDependencyToManifest(pkgName, pkgVersion);
    return;
  }

  if (command === "remove") {
    const breakCodebase = process.argv.includes("--break-codebase");
    removeDependencyFromManifest(pkgName, breakCodebase);
    return;
  }

  if (command === "update") {
    const allowMajorUpgrades = process.argv.includes("--allow-major-upgrades");
    await updateDependenciesInManifest(allowMajorUpgrades);
    return;
  }


  if (command === "list-unused") {
    const unused = listUnusedDependencies();
    if (!unused.length) {
      info("no unused dependencies found");
      return;
    }
    info("unused dependencies:");
    for (const name of unused) {
      info(`- ${name}`);
    }
    return;
  }

  if (command === "autoremove") {
    autoremoveUnusedDependencies();
    return;
  }

  if (command === "install") {
    if (pkgName != null) {
      info("Install doesn't take any arguments! add a package to your dependencies via calpm add and then rerun!");
    }
    await install();
  }

  if (command == null) {
    info("No command given! If you meant to install your dependencies, run \"calpm install\"");
  }


}

async function install() {
  step("reading manifest");
  const manifest = readManifest();
  const rootDeps = manifest.dependencies || {};

  fs.mkdirSync("node_modules", { recursive: true });

  step("resolving dependencies");
  const resolved = await resolveAll(rootDeps);

  step("writing lockfile");
  writeLockfile(resolved);

  step("downloading and installing packages");
  await Promise.all(resolved.map((pkg) => downloadAndExtract(pkg)));

  info(`installation complete!`);
}



main().catch((e) => {
  fail(e.message);
});
