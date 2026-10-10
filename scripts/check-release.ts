/**
 * Rejects release tags that do not match every maintained app-version manifest.
 * Run before creating release assets so a mistag cannot publish mislabeled binaries.
 * @packageDocumentation
 */
// @ts-ignore Node.js built-in type declarations are unavailable in this project.
import { readFileSync, writeFileSync } from "node:fs";
// @ts-ignore Node.js built-in type declarations are unavailable in this project.
import { resolve } from "node:path";
// @ts-ignore Node.js built-in type declarations are unavailable in this project.
import { fileURLToPath } from "node:url";

/** Canonical release tags allow SemVer prereleases, but not build metadata. */
const releaseTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/;

/** Checks a complete set of version sources and returns the unprefixed version. */
export function checkReleaseTag(tag: string, versions: Record<string, string>): string {
  if (!releaseTag.test(tag)) throw new Error(`Invalid release tag "${tag}": use vMAJOR.MINOR.PATCH or a SemVer prerelease.`);
  if (!Object.keys(versions).length) throw new Error("No app version manifests were provided.");
  const version = tag.slice(1);
  for (const [file, actual] of Object.entries(versions)) {
    if (actual !== version) throw new Error(`${file} version "${actual}" does not match tag "${tag}". Update every version manifest before tagging.`);
  }
  return version;
}

/** Reads only the root crate package, not dependency versions elsewhere in TOML. */
export function readReleaseVersions(root: string): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const file of ["package.json", "src-tauri/tauri.conf.json"]) {
    const manifest: { version?: unknown } = JSON.parse(readFileSync(resolve(root, file), "utf8"));
    if (typeof manifest.version !== "string") throw new Error(`${file} is missing a string version.`);
    versions[file] = manifest.version;
  }
  for (const [file, section] of [
    ["src-tauri/Cargo.toml", /^\[package\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m],
    ["src-tauri/Cargo.lock", /^\[\[package\]\]\s*\nname = "omarkd"\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m],
  ] as const) {
    const contents = readFileSync(resolve(root, file), "utf8");
    const version = contents.match(section)?.[1].match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
    if (!version) throw new Error(`${file} is missing the Omarkd package version.`);
    versions[file] = version;
  }
  return versions;
}

/**
 * Copies package.json's version into the native manifests and the lockfile's own entry.
 * Edits only each version line, preserving formatting and all dependency versions.
 * @returns Files whose contents changed, for staging into a version-bump commit.
 */
export function syncReleaseVersions(root: string): string[] {
  const version = readReleaseVersions(root)["package.json"];
  checkReleaseTag(`v${version}`, { "package.json": version });
  const updates: [path: string, file: string, contents: string][] = [];
  for (const [file, pattern] of [
    ["src-tauri/tauri.conf.json", /^(\s*\{[\s\S]*?"version"\s*:\s*")[^"]*(")/],
    ["src-tauri/Cargo.toml", /(^\[package\]\s*$[\s\S]*?^version\s*=\s*")[^"]*(")/m],
    ["src-tauri/Cargo.lock", /(^\[\[package\]\]\s*\nname = "omarkd"\s*\nversion\s*=\s*")[^"]*(")/m],
  ] as const) {
    const path = resolve(root, file);
    const contents = readFileSync(path, "utf8");
    if (!pattern.test(contents)) throw new Error(`${file} is missing the Omarkd package version.`);
    const updated = contents.replace(pattern, (_match: string, before: string, after: string) => `${before}${version}${after}`);
    // The first "version" key could belong to a nested object; require the top-level field changed.
    if (file.endsWith(".json") && JSON.parse(updated).version !== version) {
      throw new Error(`${file} top-level version could not be updated safely; edit it manually.`);
    }
    if (updated !== contents) updates.push([path, file, updated]);
  }
  // Every edit is validated above, so a late failure never leaves manifests half-synchronized.
  for (const [path, , contents] of updates) writeFileSync(path, contents);
  // Re-read every source so a missed edit can never be reported as synchronized.
  checkReleaseTag(`v${version}`, readReleaseVersions(root));
  return updates.map(([, file]) => file);
}

const runtime = (globalThis as typeof globalThis & { process?: { argv: string[]; cwd(): string } }).process;
if (runtime?.argv[1] && resolve(runtime.argv[1]) === fileURLToPath(import.meta.url)) {
  const argument = runtime.argv[2];
  if (argument === "--sync") {
    const changed = syncReleaseVersions(runtime.cwd());
    console.log(changed.length ? `Synchronized version in: ${changed.join(", ")}` : "Versions already synchronized.");
  } else if (argument) {
    console.log(`Release version verified: ${checkReleaseTag(argument, readReleaseVersions(runtime.cwd()))}`);
  } else {
    throw new Error("Usage: bun run release:check vMAJOR.MINOR.PATCH | bun run version:sync");
  }
}
