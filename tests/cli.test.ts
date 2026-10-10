// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true }); });

function temp() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "omarkd-cli-")));
  directories.push(dir);
  return dir;
}

describe("command-line launcher and installer", () => {
  it("prints help and version without launching an app", () => {
    expect(execFileSync("sh", [join(root, "bin/omarkd"), "--help"], { encoding: "utf8" })).toContain("open Markdown files");
    const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
    expect(execFileSync("sh", [join(root, "bin/omarkd"), "--version"], { encoding: "utf8" }).trim()).toBe(`omarkd ${version}`);
  });

  it("installs into a custom directory and resolves a relative launcher symlink", () => {
    const dir = temp();
    const target = join(dir, "bin");
    expect(execFileSync("sh", [join(root, "scripts/install-cli.sh"), target], { encoding: "utf8" })).toContain("Installed:");
    expect(realpathSync(join(target, "omarkd"))).toBe(join(root, "bin/omarkd"));
    symlinkSync("bin/omarkd", join(dir, "launcher"));
    expect(execFileSync("sh", [join(dir, "launcher"), "--version"], { encoding: "utf8" })).toContain("omarkd");
  });

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
