// @vitest-environment node
/**
 * Release contracts: canonical tag validation, synchronized version manifests,
 * supported native bundles and the success gates around public releases/Pages.
 * Workflows are parsed by Bun's YAML parser; no GitHub jobs or releases run here.
 * @packageDocumentation
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkReleaseTag, readReleaseVersions } from "../scripts/check-release";

/** Relevant Actions YAML fields; unknown action-specific values remain unknown. */
interface Workflow {
  on: { push?: { tags?: string[]; branches?: string[] }; workflow_call?: null; workflow_dispatch?: null };
  permissions: Record<string, string>;
  jobs: Record<string, {
    needs?: string | string[];
    uses?: string;
    permissions?: Record<string, string>;
    strategy?: { "fail-fast": boolean; matrix: { include: { platform: string; target: string; bundles: string }[] } };
    environment?: { name: string };
    concurrency?: { group: string; "cancel-in-progress": boolean };
    steps?: { name?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown> }[];
  }>;
}

/** Parse maintained YAML using the project's required Bun, not fragile text matching. */
function workflow(file: string): Workflow {
  const result = spawnSync("bun", ["-e", 'console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(process.argv.at(-1)).text())))', file], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
}

/** Owned manifest fixtures are removed even when an expected diagnostic fails. */
const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Builds realistic root/dependency version sections to test correct TOML selection. */
function manifests(): string {
  const root = mkdtempSync(resolve(tmpdir(), "omarkd-release-test-"));
  temporary.push(root);
  mkdirSync(resolve(root, "src-tauri"));
  writeFileSync(resolve(root, "package.json"), '{"version":"1.2.3"}');
  writeFileSync(resolve(root, "src-tauri/tauri.conf.json"), '{"version":"1.2.3"}');
  writeFileSync(resolve(root, "src-tauri/Cargo.toml"), '[package]\nname = "omarkd"\nversion = "1.2.3"\n\n[dependencies]\nother = "9.0.0"\n');
  writeFileSync(resolve(root, "src-tauri/Cargo.lock"), '[[package]]\nname = "dependency"\nversion = "9.0.0"\n\n[[package]]\nname = "omarkd"\nversion = "1.2.3"\n');
  return root;
}

describe("release version safety", () => {
  /** Stable/prerelease tags are exact labels, never coerced or stripped beyond their v prefix. */
  it.each(["0.1.1", "1.2.3", "1.2.3-beta.1", "1.2.3-0", "1.2.3-01alpha"])("accepts matching canonical version %s", version => {
    expect(checkReleaseTag(`v${version}`, { package: version, native: version })).toBe(version);
  });

  /** Invalid formats must fail before a CI runner can create a mislabeled draft release. */
  it.each(["", "1.2.3", "v1.2", "v01.2.3", "v1.2.3-01", "v1.2.3-", "v1.2.3+build", "v1.2.3\n", "v1.2.3/bad"])("rejects invalid tag %j", tag => {
    expect(() => checkReleaseTag(tag, { package: "1.2.3" })).toThrow("Invalid release tag");
  });

  /** Any divergent manifest or an absent source set blocks publication with a useful diagnostic. */
  it("rejects mismatched or missing version sources", () => {
    expect(() => checkReleaseTag("v1.2.3", { native: "1.2.2" })).toThrow('native version "1.2.2"');
    expect(() => checkReleaseTag("v1.2.3", {})).toThrow("No app version manifests");
  });

  /** Dependency sections must not be mistaken for the application package version. */
  it("reads each app manifest and ignores dependency versions", () => {
    const versions = readReleaseVersions(manifests());
    expect(Object.keys(versions)).toHaveLength(4);
    expect(checkReleaseTag("v1.2.3", versions)).toBe("1.2.3");
  });

  /** Missing JSON/TOML/lockfile versions and malformed JSON report errors instead of guessing. */
  it.each([
    ["package.json", "{}"],
    ["src-tauri/tauri.conf.json", '{"version":123}'],
    ["src-tauri/Cargo.toml", '[dependencies]\nversion = "1.2.3"\n'],
    ["src-tauri/Cargo.lock", '[[package]]\nname = "other"\nversion = "1.2.3"\n'],
  ])("rejects missing app version in %s", (file, contents) => {
    const root = manifests();
    writeFileSync(resolve(root, file), contents);
    expect(() => readReleaseVersions(root)).toThrow(file);
  });

  it("rejects malformed JSON and missing files", () => {
    const root = manifests();
    writeFileSync(resolve(root, "package.json"), "{");
    expect(() => readReleaseVersions(root)).toThrow();
    rmSync(resolve(root, "package.json"));
    expect(() => readReleaseVersions(root)).toThrow();
  });

  /** The real repository must be ready for its next tag without manifest drift. */
  it("keeps current package/native/lockfile versions synchronized", () => {
    const versions = readReleaseVersions(process.cwd());
    expect(checkReleaseTag(`v${versions["package.json"]}`, versions)).toBe(versions["package.json"]);
  });
});

describe("release and Pages workflow contracts", () => {
  /** Only v tags release; all four architecture/platform combinations are required. */
  it("builds unsigned native installers for every selected target before publishing", () => {
    const release = workflow(".github/workflows/release.yml");
    expect(release.on.push?.tags).toEqual(["v*"]);
    expect(release.permissions).toEqual({ contents: "read" });
    expect(release.jobs.desktop.needs).toBe("validate");
    expect(release.jobs.validate.steps?.some(step => step.run?.includes('release:check "$RELEASE_TAG"'))).toBe(true);
    expect(release.jobs.desktop.strategy?.["fail-fast"]).toBe(false);
    expect(release.jobs.desktop.strategy?.matrix.include.map(entry => [entry.target, entry.bundles])).toEqual([
      ["aarch64-apple-darwin", "app,dmg"],
      ["x86_64-apple-darwin", "app,dmg"],
      ["x86_64-pc-windows-msvc", "nsis"],
      ["x86_64-unknown-linux-gnu", "deb,rpm,appimage"],
    ]);
    const build = release.jobs.desktop.steps?.find(step => step.uses === "tauri-apps/tauri-action@v0");
    expect(build?.with).toMatchObject({ releaseDraft: true, includeUpdaterJson: false });
    expect(build?.with?.args).toBe("--ci --target ${{ matrix.target }} --bundles ${{ matrix.bundles }} -- --locked");
    expect(release.jobs.docs).toMatchObject({ needs: "desktop", uses: "./.github/workflows/pages.yml" });
    expect(release.jobs.publish.needs).toEqual(["desktop", "docs"]);
    expect(release.jobs.publish.steps?.[0].run).toContain("--draft=false");
    expect(JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).bundle.targets).toBe("all");
  });

  /** Pages serves generated docs as root, not the maintained source/config files beside them. */
  it("deploys complete tested docs and native API pages without publishing failed builds", () => {
    const pages = workflow(".github/workflows/pages.yml");
    expect(pages.on.push?.branches).toEqual(["main"]);
    expect(pages.on).toHaveProperty("workflow_call");
    expect(pages.on).toHaveProperty("workflow_dispatch");
    const steps = pages.jobs.build.steps ?? [];
    for (const command of ["bun run test:types", "bun run build", "bun run docs"]) {
      expect(steps.some(step => step.run === command)).toBe(true);
    }
    expect(steps.some(step => step.run?.includes("playwright install --with-deps chromium"))).toBe(true);
    expect(steps.some(step => step.run?.includes("cp -R src-tauri/target/doc docs/typedoc/rust"))).toBe(true);
    const upload = steps.find(step => step.uses === "actions/upload-pages-artifact@v3");
    expect(upload?.with?.path).toBe("docs/typedoc");
    expect(upload?.if).toBeUndefined();
    expect(steps.find(step => step.uses === "actions/upload-artifact@v4")?.if).toBe("always()");
    expect(pages.jobs.deploy.needs).toBe("build");
    expect(pages.jobs.deploy.permissions).toEqual({ pages: "write", "id-token": "write" });
    expect(pages.jobs.deploy.environment?.name).toBe("github-pages");
    expect(pages.jobs.deploy.concurrency).toEqual({ group: "github-pages", "cancel-in-progress": false });
  });
});
