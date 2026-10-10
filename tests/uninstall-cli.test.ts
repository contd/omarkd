// @vitest-environment node
/**
 * Real uninstaller shell tests against a disposable checkout and launcher links.
 * Both source and destination live inside a temporary tree; the actual app and
 * installed system command are never removed. Fake Gum drives confirm/cancel/races.
 * @packageDocumentation
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/** Maintained repository, read only to copy the script under test. */
const root = resolve(import.meta.dirname, "..");
/** Disposable checkouts registered for cleanup after every case. */
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

/**
 * Builds an isolated checkout, custom installation and restricted native-tool PATH.
 * The optional Gum shim can change the destination while confirmation is pending
 * to verify the uninstaller's recheck, without modifying any real installation.
 */
function setup(gum = false) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "omarkd-uninstall-")));
  directories.push(dir);
  const checkout = join(dir, "checkout");
  const shims = join(dir, "shims");
  const target = join(dir, "custom bin");
  for (const path of [join(checkout, "scripts"), join(checkout, "bin"), shims, target]) mkdirSync(path, { recursive: true });
  writeFileSync(join(checkout, "scripts/uninstall-cli.sh"), readFileSync(join(root, "scripts/uninstall-cli.sh")));
  writeFileSync(join(checkout, "bin/omarkd"), "source launcher");
  const source = join(checkout, "bin/omarkd");
  const command = join(target, "omarkd");
  symlinkSync(source, command);
  const log = join(dir, "gum-calls");
  for (const name of ["dirname", "readlink", "rm"]) {
    symlinkSync(execFileSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim(), join(shims, name));
  }
  if (gum) {
    writeFileSync(join(shims, "gum"), `#!/bin/sh
printf '%s\\n' "$@" >> "$GUM_LOG"
if [ "\${GUM_CHANGE:-}" = yes ]; then
  rm -- "$GUM_DESTINATION"
  printf 'replacement' > "$GUM_DESTINATION"
fi
[ "\${GUM_CANCEL:-}" != yes ]
`, { mode: 0o755 });
  }
  const run = (args: string[] = [], input = "", overrides: Record<string, string> = {}) =>
    spawnSync("/bin/sh", [join(checkout, "scripts/uninstall-cli.sh"), ...args], {
      cwd: dir,
      encoding: "utf8",
      input,
      env: { ...process.env, HOME: dir, PATH: `${shims}:${target}`, GUM_LOG: log, GUM_DESTINATION: command, ...overrides },
    });
  return { dir, checkout, shims, target, source, command, log, run };
}

describe("CLI uninstaller", () => {
  /** The package entry point must invoke the maintained script, not duplicate its logic. */
  it("registers the uninstall:cli package script", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.scripts["uninstall:cli"]).toBe("sh scripts/uninstall-cli.sh");
  });

  /** Verify plan-before-confirm-before-removal and preservation of neighboring/source files. */
  it("detects a custom PATH installation, previews it and removes only the link after confirmation", () => {
    const { run, command, source, target } = setup();
    writeFileSync(join(target, "keep"), "keep");
    const result = run([], "yes\n");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`${command} -> ${source}`);
    expect(result.stdout.indexOf("uninstallation preview")).toBeLessThan(result.stdout.indexOf("Proceed with uninstallation?"));
    expect(result.stdout.indexOf("Proceed with uninstallation?")).toBeLessThan(result.stdout.indexOf("Removed:"));
    expect(result.stdout).toContain("shell configuration will be kept");
    expect(existsSync(command)).toBe(false);
    expect(readFileSync(source, "utf8")).toBe("source launcher");
    expect(readFileSync(join(target, "keep"), "utf8")).toBe("keep");
  });

  // Negative, blank, EOF and unknown input preserve even the symlink itself.
  it.each(["n\n", "\n", "", "maybe\n"])("preserves links when confirmation is declined or input ends: %j", input => {
    const { run, command } = setup();
    const result = run([], input);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Uninstallation cancelled; no changes made.");
    expect(lstatSync(command).isSymbolicLink()).toBe(true);
  });

  /** Record Gum's safe default and verify confirmed removal, not just command invocation. */
  it("uses Gum confirmation with No as the default", () => {
    const { run, command, log } = setup(true);
    const result = run();
    expect(result.status).toBe(0);
    expect(readFileSync(log, "utf8")).toContain("confirm\n");
    expect(readFileSync(log, "utf8")).toContain("--default=false");
    expect(result.stdout).toContain(command);
    expect(existsSync(command)).toBe(false);
  });

  /** A nonzero Gum response is cancellation and must not fall back to automatic removal. */
  it("preserves the installation when Gum confirmation is cancelled", () => {
    const { run, command } = setup(true);
    const result = run([], "", { GUM_CANCEL: "yes" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Uninstallation cancelled");
    expect(lstatSync(command).isSymbolicLink()).toBe(true);
  });

  /** Standard home location is scanned independently; duplicate PATH entries do not duplicate rm. */
  it("detects user-local links outside PATH and removes multiple unique links", () => {
    const { dir, run, source, target, shims, command } = setup();
    const local = join(dir, ".local/bin");
    mkdirSync(local, { recursive: true });
    symlinkSync(source, join(local, "omarkd"));
    const result = run([], "Y\n", { PATH: `${shims}:${target}:${target}` });
    expect(result.status).toBe(0);
    expect(result.stdout.match(/Removed:/g)).toHaveLength(2);
    expect(existsSync(command)).toBe(false);
    expect(existsSync(join(local, "omarkd"))).toBe(false);
    expect(existsSync(source)).toBe(true);
  });

  /** Explicit mode targets only that directory and resolves relative symlink contents correctly. */
  it("accepts an explicit relative directory outside PATH and leaves other installations alone", () => {
    const { dir, run, source, command } = setup();
    const outside = join(dir, "outside");
    mkdirSync(outside);
    symlinkSync("../checkout/bin/omarkd", join(outside, "omarkd"));
    const result = run(["outside"], "y\n");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`${outside}/omarkd -> ../checkout/bin/omarkd`);
    expect(existsSync(join(outside, "omarkd"))).toBe(false);
    expect(lstatSync(command).isSymbolicLink()).toBe(true);
    expect(existsSync(source)).toBe(true);
  });

  /** Empty PATH entries mean cwd; literal wildcard characters must not expand into unrelated paths. */
  it("handles empty PATH entries and wildcard characters in paths without glob expansion", () => {
    const { dir, run, source, shims } = setup();
    const literal = join(dir, "literal * bin");
    mkdirSync(literal);
    symlinkSync(source, join(literal, "omarkd"));
    symlinkSync(source, join(dir, "omarkd"));
    const result = run([], "yes\n", { PATH: `${shims}::${literal}` });
    expect(result.status).toBe(0);
    expect(result.stdout.match(/Removed:/g)).toHaveLength(2);
    expect(existsSync(join(literal, "omarkd"))).toBe(false);
    expect(existsSync(join(dir, "omarkd"))).toBe(false);
  });

  /** Name alone is insufficient: only a symlink to this checkout's launcher is eligible. */
  it("refuses regular files, directories, missing paths and unrelated symlinks", () => {
    const { dir, run, command, target } = setup();
    rmSync(command);
    writeFileSync(command, "unrelated executable");
    expect(run([target], "yes\n").status).toBe(1);
    expect(readFileSync(command, "utf8")).toBe("unrelated executable");
    rmSync(command);
    mkdirSync(command);
    expect(run([target], "yes\n").status).toBe(1);
    rmSync(command, { recursive: true });
    expect(run([target], "yes\n").status).toBe(1);
    const other = join(dir, "other/bin");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "omarkd"), "another checkout");
    symlinkSync(join(other, "omarkd"), command);
    expect(run([target], "yes\n").stderr).toContain("not a launcher symlink for this checkout");
    expect(lstatSync(command).isSymbolicLink()).toBe(true);
    expect(run([], "yes\n").stdout).toContain("No installed launcher links");
  });

  /** Removing the launcher file still permits identifying its link via the existing parent directory. */
  it("can remove a broken link to this checkout's launcher without removing unrelated broken links", () => {
    const { run, source, command } = setup();
    rmSync(source);
    const result = run([], "yes\n");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Removed: ${command}`);
    expect(existsSync(command)).toBe(false);
  });

  /** No candidates is a reported no-op; extra arguments are an invocation error. */
  it("reports when nothing is installed and rejects extra arguments", () => {
    const { run, command, target } = setup();
    rmSync(command);
    const none = run();
    expect(none.status).toBe(0);
    expect(none.stdout).toContain("No installed launcher links");
    expect(none.stdout).not.toContain("Proceed");
    expect(run([target, "extra"]).status).toBe(1);
    expect(run([target, "extra"]).stderr).toContain("Usage:");
  });

  /** Gum substitutes a regular file during confirmation; the second identity check protects it. */
  it("rechecks destinations after confirmation and refuses a substituted regular file", () => {
    const { run, command } = setup(true);
    const result = run([], "", { GUM_CHANGE: "yes" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Refusing to remove changed destination");
    expect(result.stdout).not.toContain("Removed:");
    expect(readFileSync(command, "utf8")).toBe("replacement");
  });

  /** A failing rm shim emulates permissions failure and must not produce a Removed line. */
  it("reports removal errors without claiming success", () => {
    const { run, shims, command } = setup();
    rmSync(join(shims, "rm"));
    writeFileSync(join(shims, "rm"), "#!/bin/sh\nprintf 'Removal denied\\n' >&2\nexit 1\n", { mode: 0o755 });
    const result = run([], "yes\n");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Removal denied");
    expect(result.stdout).not.toContain("Removed:");
    expect(lstatSync(command).isSymbolicLink()).toBe(true);
  });
});
