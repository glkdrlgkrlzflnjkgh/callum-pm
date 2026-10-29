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
import { Info, Step, Error, Fail, Question } from "./log.js";
import readlineSync from "readline-sync";
import toml from "@iarna/toml";
import { performance } from 'node:perf_hooks';
import { DEFAULT_MAX_VERSION } from "node:tls";
import crypto from "node:crypto";
import chalk from "chalk";
// ------------------------------------------------------------
// MANIFEST
// ------------------------------------------------------------

function writeManifest(manifest) {
  Step("writing manifest to callum.toml");
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
    Fail('manifest "callum.toml" not found');
  }
  const raw = fs.readFileSync("callum.toml", "utf8");
  return toml.parse(raw);
}

async function addDependencyToManifest(name, version) {
  if (!name) {
    Fail("usage: calpm add <package> <version>");
  }
  if (!semver.valid(version) && version != undefined) {
    Fail("the version needs to conform to the SemVer spec! (MAJOR.MINOR.PATCH)");
  }
  else if (!version) {
	Fail("No version specified! Specify a version explicitly! (MAJOR.MINOR.PATCH)");
  }
  else if (version === "*") {
	Fail("Using * as a version is not allowed! It breaks the updater! Specify a version explicitly! (MAJOR.MINOR.PATCH)");
  }
  const manifest = readManifest(true);
  const dependencies = manifest.dependencies || {};
  dependencies[name] = version;
  manifest.dependencies = dependencies;
  const ans = await Question(`Is this correct? ${name}@${version} (yes/N)`);

  if (ans.toLowerCase() !== "yes") {
    Info("Add cancelled.");
    process.exit(0);
  }

  writeManifest(manifest);
  Info(`added ${name}@${version} to callum.toml`);
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
    Step(`Trying to update ${name}`)
    try {
      const meta = await fetchJson(`https://registry.npmjs.org/${name}`);
	  if (!meta) {
		Fail(`failed to fetch metadata for ${name}`);
	  }
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
      // detect major bump
      if (semver.major(latestVersion) > semver.major(baseVersion.version) && ! allowMajorUpgrades) {
        Info(
          `NOTE: there is a major update available for ${name} (current: ${baseVersion.version}, latest: ${latestVersion})`
        );
		Info("By default, calpm will not update to a new major version to avoid breaking changes.");
        Info(`run calpm update --allow-major-upgrades to install major updates`);
      }
      if (targetVersion !== currentComparable.version) {
        Info(`updated ${name} from ${currentComparable.version} to ${targetVersion}`);
      }
      else {
        Info(`no update needed for ${name} (current: ${currentComparable.version})`);
      }
    } catch (e) {
      Error(`failed to update ${name}: ${e.message} stack: ${e.stack}`);
      updated[name] = currentRange;
    }
  }

  manifest.dependencies = updated;
  writeManifest(manifest);
  Info("dependency update complete");
  Info("note: this only updated the manifest. Please run calpm install to apply the changes!");
}

function findDependencyReferences(name) {
  Step(`searching for references to ${name} in codebase`);
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
      Error(`failed to read file: ${current}`);
    }
  }

  return results;
}

async function removeDependencyFromManifest(name, breakCodebase = false) {
  if (!name) {
    Fail("usage: node index.js remove <package> [--break-codebase]");
  }

  const manifest = readManifest();
  const dependencies = manifest.dependencies || {};

  if (!Object.prototype.hasOwnProperty.call(dependencies, name)) {
    Fail(`dependency "${name}" is not present in callum.toml`);
  }

  const references = findDependencyReferences(name);
  if (references.length > 0 && !breakCodebase) {
    Fail(`refusing to remove "${name}" because it is still referenced in the codebase.\nPlease remove those references first or rerun with --break-codebase to force removal. (The following files are affected: ${references.join(", \n")})`);
  }
  var res = undefined;
  if (breakCodebase) {
    const res = await Question(
      "WARNING!!!! --break-codebase has been passed and continuing WILL delete the package, even if you still use it. Are you sure? (yes/N)"
    );

    if (!res || res.toLowerCase() !== "yes") {
      Fail("User didn't agree to the operation, bailing out!");
    }
  }

  delete dependencies[name];
  manifest.dependencies = dependencies;
  writeManifest(manifest);

  const installedDir = path.join(process.cwd(), "node_modules", name);
  if (fs.existsSync(installedDir)) {
    fs.rmSync(installedDir, { recursive: true, force: true });
    Info(`removed ${name} from node_modules`);
  }

  Info(`removed ${name} from callum.toml`);
  Info(`After this operation, you should run autoremove-unused to remove any unused dependencies that this operation may have caused.`)
}

function readLockfile() {
  const lockfilePath = path.join(process.cwd(), "callum-lock.toml");
  if (!fs.existsSync(lockfilePath)) return [];

  const content = fs.readFileSync(lockfilePath, "utf8");

  // Regex that matches [[package]] on a single line
  const entries = content.split(/\[\[package\]\]/).slice(1);

  const packages = [];

  for (const entry of entries) {
    const lines = entry.split(/\n/).map((line) => line.trim()).filter(Boolean);
    const pkg = {};

    for (const line of lines) {
      const match = line.match(/^(name|version|resolved|integrity)\s*=\s*"([^"]+)"/);
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
      Error(`Read of ${current} failed!`);
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
    Info("no unused dependencies found");
    return;
  }
  var unusedCount = 0;
  Info("The following packages will be REMOVED:");
  for (const name of unused) {
    Info(`- ${name}`);
    unusedCount++;
    if (unusedCount >= 20) { 
      Info("etc... (to see full list, run list-unused)");
      break;
    }
  }
  // FIXME: This should use log.js's question() function.
  const confirm = readlineSync.question("Are you sure you want to continue? (yes/N): ");
  if (confirm.toLowerCase() !== "yes") {
    Info("operation cancelled");
    return;
  }
  for (const name of unused) {
    Step("Removing " + name);
    const installedDir = path.join(process.cwd(), "node_modules", name);
    if (fs.existsSync(installedDir)) {
      fs.rmSync(installedDir, { recursive: true, force: true });
    }
  }
  const manifest = toml.parse(fs.readFileSync("callum.toml", "utf8"));

  for (const name of unused) {
    Step(`removing ${name} from manifest`);
    delete manifest.dependencies[name];
  }

  fs.writeFileSync("callum.toml", toml.stringify(manifest));

  Info("autoremoved unused dependencies");
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
  Info(`Attempting to resolve ${name}`);
  const meta = await fetchJson(`https://registry.npmjs.org/${name}`);
  const versions = Object.keys(meta.versions || {});
  const picked = semver.maxSatisfying(versions, range);
  if (!picked) {
    Fail(`no version of "${name}" satisfies range "${range}"`);
  }
  const info = meta.versions[picked];
  Info(`Resolved ${name} to version ${picked.toString()}`);
  return {
    name,
    version: picked,
    tarball: info.dist.tarball,
    dependencies: info.dependencies || {},
  };
}

function detectConflicts(resolved, requestedRanges) {
    for (const [name, info] of requestedRanges.entries()) {
        const version = resolved.find(p => p.name === name)?.version;

        if (!version)
            continue;

        for (const range of info.ranges) {
            if (!semver.satisfies(version, range)) {
                Fail(
                    `dependency conflict for "${name}": ` +
                    `${version} does not satisfy ${range}`
                );
            }
        }
    }
}

async function resolveAll(rootDeps) {
	const resolved = [];
	const seen = new Map();
	const queue = [...Object.entries(rootDeps)];

	// Load lockfile integrity
	const lockfile = readLockfile();

	let lockMap;
	if (lockfile.length !== 0) {
		lockMap = new Map(
		lockfile.map(p => [`${p.name}@${p.version}`, p])
		);
	}

	while (queue.length) {
		const [name, range] = queue.shift();

		const pkg = await resolvePackage(name, range);

		// ----- CONFLICT DETECTION -----

		if (seen.has(pkg.name)) {
		const existingVersion = seen.get(pkg.name);

		if (existingVersion !== pkg.version) {
			Error("DEPENDENCY CONFLICT DETECTED!");
			Error(
			`Package "${pkg.name}" was requested as both ` +
			`${existingVersion} and ${pkg.version}`
			);
			Fail("Bailing out!");
		}

		continue;
		}

		// -----------------------------

		const key = `${pkg.name}@${pkg.version}`;
		const lockEntry = lockMap
		? lockMap.get(key)
		: undefined;

		if (lockEntry && lockEntry.integrity) {
		pkg.integrity = lockEntry.integrity;
		}

		resolved.push(pkg);
		seen.set(pkg.name, pkg.version);

		for (const [depName, depRange] of Object.entries(pkg.dependencies)) {
		queue.push([depName, depRange]);
		}
	}

	return resolved;
}
// ------------------------------------------------------------
// LOCKFILE
// ------------------------------------------------------------

function writeLockfile(resolved) {
  // Load existing lockfile entries to preserve integrity
  const existing = readLockfile(); // [{ name, version, resolved, integrity }]
  const existingMap = new Map();

  for (const pkg of existing) {
    const key = `${pkg.name}@${pkg.version}`;
    existingMap.set(key, pkg);
  }

  let out = "";
  out += "# ------------------------------------------------------------\n";
  out += "# This file is auto-generated by Callum PM. Do not edit manually.\n";
  out += "# ------------------------------------------------------------\n\n";

  for (const pkg of resolved) {

    const key = `${pkg.name}@${pkg.version}`;
    const previous = existingMap.get(key);

    // Prefer integrity from the current run; fall back to previous lockfile
    const integrity =
      pkg.integrity ||
      (previous && previous.integrity) ||
      undefined;

    Step(`Writing lockfile entry for ${pkg.name}@${pkg.version}`);
    out += `[[package]] # ${pkg.name}@${pkg.version}\n`;
    out += `name = "${pkg.name}"\n`;
    out += `version = "${pkg.version}"\n`;
    out += `resolved = "${pkg.tarball}"\n`;
    if (integrity) {
      out += `integrity = "${integrity}"\n`;
    }
    out += `\n`;
  }

  fs.writeFileSync("callum-lock.toml", out);
  if (!fs.existsSync("callum-lock.toml")) {
    Fail("Aieee! Callum-lock.toml got destroyed even though we wrote it to disk!!!");
  }
}


// ------------------------------------------------------------
// CACHE
// ------------------------------------------------------------

async function getCachePath(pkg) {
  const home = process.env.HOME || process.env.USERPROFILE;
  const cacheDir = path.join(home, ".calpm", "cache");
  await warnIfCacheIsSynced(cacheDir);
  fs.mkdirSync(cacheDir, { recursive: true });
  return path.join(cacheDir, `${pkg.name}-${pkg.version}.tgz`);
}

async function warnIfCacheIsSynced(cacheDir) {
  const oneDrive = process.env.ONE_DRIVE || process.env.ONEDRIVE;
  if (oneDrive && cacheDir.startsWith(oneDrive)) {
    Error("---- IMPORTANT ----");
    Error("It seems like your CalPM cache folder is BEING SYNCED BY ONEDRIVE!!!!");
    Error(`This is VERY bad and ${chalk.bold.red("WILL")} corrupt the cache!!!!`);
    Fail("Bailing out to prevent horrifying bugs!");
  }
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
// DOWNLOAD + EXTRACT + VERIFICATION
// ------------------------------------------------------------

function computeFileIntegrity(filePath) {

  const data = fs.readFileSync(filePath);
  const hash = crypto.createHash("sha512").update(data).digest("base64");
  return `sha512-${hash}`;
}

async function downloadAndExtract(pkg) {
  const finalDir = path.join("node_modules", pkg.name);

  if (isAlreadyCorrectlyInstalled(pkg)) {
    Info(`skipped ${pkg.name}@${pkg.version} (Requirements are already satisfied)`);
    return;
  }
  
  const lockfile = readLockfile();

  var lockMap = undefined;
  if (lockfile.length != 0) {
    lockMap = new Map(lockfile.map(p => [`${p.name}@${p.version}`, p]));
  }
  const destTgz = path.join("node_modules", `${pkg.name}.tgz`);
  const temp = path.join("node_modules", `${pkg.name}-tmp`);
  const cacheFile = await getCachePath(pkg);

  if (fs.existsSync(temp)) {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Use cache only on first attempt
    // Fetch registry integrity BEFORE deciding whether to use cache
    const meta = await fetchJson(`https://registry.npmjs.org/${pkg.name}`);
    const versionInfo = meta.versions[pkg.version];
    const registryIntegrity = versionInfo?.dist?.integrity;

    // If registry provides integrity, use it.
    // This is the authoritative hash.
    if (registryIntegrity) {
      pkg.integrity = registryIntegrity;
    }

    
    if (attempt === 1 && fs.existsSync(cacheFile)) {
      Step(`cache hit for ${pkg.name}@${pkg.version}`);
      fs.copyFileSync(cacheFile, destTgz);
    } else {
      if (attempt > 1) {
        Step(`retrying download for ${pkg.name}@${pkg.version} (attempt ${attempt})`);
      } else {
        Step(`downloading ${pkg.name}@${pkg.version}`);
      }

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

    // Ensure file is fully written before hashing (extra safety on Windows)
    const fd = fs.openSync(destTgz, "r+");
    fs.fsyncSync(fd);
    fs.closeSync(fd);

    // Compute integrity
    const actualIntegrity = computeFileIntegrity(destTgz);
    Step(`Validating ${pkg.name}@${pkg.version}...`);

    // Integrity verification
    if (pkg.integrity) {
      if (pkg.integrity !== actualIntegrity) {
        Error(
          `Integrity check ${chalk.bold.red("FAILED")} for ${pkg.name}@${pkg.version}! Retrying! (giving up in ${maxAttempts - attempt} attempts...)`
        );

        // Delete corrupted cache + tgz
        if (fs.existsSync(cacheFile)) fs.rmSync(cacheFile, { force: true });
        if (fs.existsSync(destTgz)) fs.rmSync(destTgz, { force: true });

        if (attempt === maxAttempts) {
          Fail(
            `Integrity check ${chalk.bold.red("FAILED")} for ${pkg.name}@${pkg.version} after ${maxAttempts} attempts`
          );
        }

        continue; // retry
      }
    } else {
      const meta = await fetchJson(`https://registry.npmjs.org/${pkg.name}`);
      const versionInfo = meta.versions[pkg.version];
      const registryIntegrity = versionInfo.dist.integrity;
      pkg.integrity = registryIntegrity;
    }

    Info(`Integrity check ${chalk.bold.green("PASSED")} for ${pkg.name}@${pkg.version}`);
    break; // success
  }

  fs.mkdirSync(temp, { recursive: true });
  Step(`Extracting ${pkg.name}@${pkg.version}...`);
  execSync(`tar -xzf "${destTgz}" -C "${temp}"`);
  Step(`Done extracting ${pkg.name}@${pkg.version}!`)

  const pkgDir = path.join(temp, "package");

  if (fs.existsSync(finalDir)) {
    fs.rmSync(finalDir, { recursive: true, force: true });
  }

  fs.renameSync(pkgDir, finalDir);

  fs.rmSync(temp, { recursive: true, force: true });
  fs.rmSync(destTgz, { force: true });

  Info(`installed ${pkg.name}@${pkg.version}`);
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
  "install",
  "help"
];

async function main() {
if (process.arch !== "x64" && process.arch !== "arm64") {
    Fail("32 bit processors are unsupported, exiting...");
  }
  const [command, pkgName, pkgVersion] = process.argv.slice(2);
  if (command == null) {
    Info("No command given! If you meant to install your dependencies, run \"calpm install\"");
    return;
  }
  if (!VALID_COMMANDS.includes(command)) {
    Fail(`Unknown command: "${command}"`);
  }
  if (command === "help") {
    console.log("Valid Commands:")
    for (const cmd of VALID_COMMANDS) {
      console.log(` - ${cmd}`);
    }
  }
  if (command === "add") {
    await addDependencyToManifest(pkgName, pkgVersion);
    return;
  }
  

  if (command === "remove") {
    const breakCodebase = process.argv.includes("--break-codebase");
    await removeDependencyFromManifest(pkgName, breakCodebase);
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
      Info("no unused dependencies found");
      return;
    }
    Info("unused dependencies:");
    for (const name of unused) {
      Info(`- ${name}`);
    }
    return;
  }

  if (command === "autoremove") {
    autoremoveUnusedDependencies();
    return;
  }

  if (command === "install") {
    if (pkgName != null) {
      Info("Install doesn't take any arguments! add a package to your dependencies via calpm add and then rerun!");
    }
    await install();
  }
}

async function install() {
  const start = performance.now();
  Step("reading manifest");
  const manifest = readManifest();
  const rootDeps = manifest.dependencies || {};

  fs.mkdirSync("node_modules", { recursive: true });

  Step("resolving dependencies");
  const resolved = await resolveAll(rootDeps);

  Step("downloading and installing packages");
  await Promise.all(resolved.map((pkg) => downloadAndExtract(pkg)));

  Step("writing lockfile");
  writeLockfile(resolved);
  const end = performance.now();
  Info(`installation complete, took ${end - start} ms!`);
}



main().catch((e) => {
  Error(e.message);
  Fail(`Trace ${e.stack}`);
});
