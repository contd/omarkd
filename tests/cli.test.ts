// @vitest-environment node
/**
 * Real POSIX launcher/installer tests isolated to temporary directories.
 * A minimal PATH hides any real Gum binary; a scripted Gum records menu and
 * confirmation arguments. Launcher tests replace nohup so no app is started.
 * @packageDocumentation
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/** Repository source, used read-only as the symlink target and script entry point. */
const root = resolve(import.meta.dirname, "..");
/** Allocated test trees; cleanup never targets real installed command directories. */
const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true }); });

/** Allocates a canonical temporary tree and registers it for teardown. */
function temp() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "omarkd-cli-")));
  directories.push(dir);
  return dir;
}

/**
 * Supplies only the installer's required shell tools and an optional fake Gum.
 * Returned run accepts stdin/selection overrides, preserving real shell exit codes.
 */
function installer(gum = false) {
  const dir = temp();
  const shim = join(dir, "shims");
  mkdirSync(shim);
  for (const command of ["dirname", "mkdir", "ln"]) {
    symlinkSync(execFileSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" }).trim(), join(shim, command));
  }
  const log = join(dir, "gum-calls");
  if (gum) {
    // Controlled menu responses emulate cancellation without an interactive terminal.
    writeFileSync(join(shim, "gum"), `#!/bin/sh
printf '%s\\n' "$@" >> "$GUM_LOG"
case "$1" in
  choose) [ "\${GUM_CANCEL:-}" != choose ] || exit 1; printf '%s\\n' "$GUM_CHOICE" ;;
  input) [ "\${GUM_CANCEL:-}" != input ] || exit 1; printf '%s\\n' "$GUM_INPUT" ;;
  confirm) [ "\${GUM_CANCEL:-}" != confirm ] ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
  }
  const target = join(dir, "bin");
  const env = { ...process.env, HOME: dir, PATH: shim, GUM_LOG: log };
  const run = (args: string[] = [target], input = "", overrides: Record<string, string> = {}) =>
    spawnSync("/bin/sh", [join(root, "scripts/install-cli.sh"), ...args], {
      cwd: dir, encoding: "utf8", input, env: { ...env, ...overrides },
    });
  return { dir, target, log, run };
}

describe("command-line launcher and installer", () => {
  /** Help/version must short-circuit before platform app discovery or process launching. */
  it("prints help and version without launching an app", () => {
    expect(execFileSync("sh", [join(root, "bin/omarkd"), "--help"], { encoding: "utf8" })).toContain("open Markdown files");
    const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
    expect(execFileSync("sh", [join(root, "bin/omarkd"), "--version"], { encoding: "utf8" }).trim()).toBe(`omarkd ${version}`);
  });

  /** Confirm first, then verify the link points to source and the launcher resolves a relative alias. */
  it("installs into a custom directory and resolves a relative launcher symlink", () => {
    const dir = temp();
    const target = join(dir, "bin");
    const install = installer();
    const result = install.run([target], "yes\n");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Installed:");
    expect(result.stdout).toContain("Source launcher:");
    expect(result.stdout).toContain("no shell configuration is changed");
    expect(result.stdout.indexOf("Proceed with installation?")).toBeLessThan(result.stdout.indexOf("Installed:"));
    expect(realpathSync(join(target, "omarkd"))).toBe(join(root, "bin/omarkd"));
    symlinkSync("bin/omarkd", join(dir, "launcher"));
    expect(execFileSync("sh", [join(dir, "launcher"), "--version"], { encoding: "utf8" })).toContain("omarkd");
  });

  // No, blank, EOF and unrecognized answers all protect the filesystem.
  it.each(["n\n", "\n", "", "maybe\n"])("makes no changes when plain confirmation is declined or unavailable: %j", input => {
    const { target, run } = installer();
    const result = run([target], input);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Installation cancelled; no changes made.");
    expect(existsSync(target)).toBe(false);
  });

  /** Replacement warnings precede the decision; cancellation must preserve existing command bytes. */
  it("previews replacement and preserves an existing command when cancelled", () => {
    const { target, run } = installer();
    mkdirSync(target);
    writeFileSync(join(target, "omarkd"), "existing command");
    const cancelled = run([target], "n\n");
    expect(cancelled.status).toBe(0);
    expect(cancelled.stdout).toContain("WARNING: the existing file or symlink");
    expect(readFileSync(join(target, "omarkd"), "utf8")).toBe("existing command");
    const confirmed = run([target], "Y\n");
    expect(confirmed.status).toBe(0);
    expect(realpathSync(join(target, "omarkd"))).toBe(join(root, "bin/omarkd"));
  });

  /** Verify the menu destinations and the safe default passed to Gum, not just a created link. */
  it("uses Gum to choose a user directory and confirm with No as the default", () => {
    const { dir, log, run } = installer(true);
    const result = run([], "", { GUM_CHOICE: `${dir}/.local/bin (current user)` });
    expect(result.status).toBe(0);
    expect(realpathSync(join(dir, ".local/bin/omarkd"))).toBe(join(root, "bin/omarkd"));
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("choose\n");
    expect(calls).toContain("/usr/local/bin (system-wide)\nCustom directory");
    expect(calls).toContain("confirm\n");
    expect(calls).toContain("--default=false");
    expect(result.stdout).toContain("Omarkd CLI installation preview");
  });

  /** Custom paths remain one shell argument and relative paths resolve from the caller's directory. */
  it("uses Gum input for a custom directory containing spaces", () => {
    const { dir, log, run } = installer(true);
    const result = run([], "", { GUM_CHOICE: "Custom directory", GUM_INPUT: "custom bin" });
    expect(result.status).toBe(0);
    expect(realpathSync(join(dir, "custom bin/omarkd"))).toBe(join(root, "bin/omarkd"));
    expect(readFileSync(log, "utf8")).toContain("input\n--placeholder");
    expect(result.stdout).toContain(`Install directory: ${dir}/custom bin`);
  });

  /** A supplied destination bypasses selection, never the confirmation requirement. */
  it("skips the Gum menu for an explicit directory but still confirms", () => {
    const { target, log, run } = installer(true);
    const result = run();
    expect(result.status).toBe(0);
    expect(realpathSync(join(target, "omarkd"))).toBe(join(root, "bin/omarkd"));
    expect(readFileSync(log, "utf8")).not.toContain("choose\n");
    expect(readFileSync(log, "utf8")).toContain("confirm\n");
  });

  // Cancellation at any stage must occur before mkdir or link replacement.
  it.each(["choose", "input", "confirm"])("makes no changes when Gum %s is cancelled", action => {
    const { target, dir, run } = installer(true);
    const result = run([], "", { GUM_CHOICE: "Custom directory", GUM_INPUT: target, GUM_CANCEL: action });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Installation cancelled; no changes made.");
    expect(existsSync(target)).toBe(false);
    expect(existsSync(join(dir, ".local"))).toBe(false);
  });

  /** Empty input is cancellation; unexpected menu output is an explicit error rather than a path. */
  it("cancels an empty Gum directory and rejects an invalid menu selection", () => {
    const { target, run } = installer(true);
    expect(run([], "", { GUM_CHOICE: "Custom directory", GUM_INPUT: "" }).stdout).toContain("Installation cancelled");
    const invalid = run([], "", { GUM_CHOICE: "unexpected selection" });
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("Invalid install destination");
    expect(existsSync(target)).toBe(false);
  });

  /** Bad invocation/directory collisions fail before accidental nested links can be created. */
  it("rejects excess arguments and directory destinations without modifying them", () => {
    const { target, run } = installer();
    expect(run([target, "extra"]).stderr).toContain("Usage:");
    expect(run([target, "extra"]).status).toBe(1);
    mkdirSync(join(target, "omarkd"), { recursive: true });
    const result = run([target], "yes\n");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Cannot replace a directory:");
    expect(existsSync(join(target, "omarkd", "omarkd"))).toBe(false);
  });

  /** A file blocking mkdir produces a nonzero exit and cannot print an Installed success line. */
  it("reports installation errors instead of claiming success", () => {
    const { dir, run } = installer();
    const blocked = join(dir, "not-a-directory");
    writeFileSync(blocked, "untouched");
    const result = run([join(blocked, "bin")], "yes\n");
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("Installed:");
    expect(result.stderr).not.toBe("");
    expect(readFileSync(blocked, "utf8")).toBe("untouched");
  });

  // Capture launcher arguments rather than launching or detaching a real desktop process.
  it.each([{ args: [] }, { args: ["one.md", "two file.md"] }, { args: ["--ignored", "/absolute.md", "."] }])("passes absolute paths without flags for $args", ({ args }) => {
    const dir = temp();
    const shim = join(dir, "shims");
    mkdirSync(shim);
    const capture = join(dir, "arguments.json");
    // Replace nohup itself so no app or detached process is started.
    writeFileSync(join(shim, "nohup"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE"\n', { mode: 0o755 });
    execFileSync("sh", ["-c", '. "$0"; wait', join(root, "bin/omarkd"), ...args], {
      cwd: dir,
      env: { ...process.env, PATH: `${shim}:${process.env.PATH}`, OMARKD_BIN: "/fake/omarkd", CAPTURE: capture },
    });
    expect(readFileSync(capture, "utf8").trim().split("\n")).toEqual(["/fake/omarkd", ...args.filter(a => !a.startsWith("-")).map(a => a.startsWith("/") ? a : `${dir}/${a}`)]);
  });
});
