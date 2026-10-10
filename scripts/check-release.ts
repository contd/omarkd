/**
 * Rejects release tags that do not match every maintained app-version manifest.
 * Run before creating release assets so a mistag cannot publish mislabeled binaries.
 * @packageDocumentation
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tag = process.argv[2];
  if (!tag) throw new Error("Usage: bun run release:check vMAJOR.MINOR.PATCH");
  console.log(`Release version verified: ${checkReleaseTag(tag, readReleaseVersions(process.cwd()))}`);
}
