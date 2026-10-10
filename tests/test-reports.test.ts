// @vitest-environment node
/**
 * Report-publication tests using real temporary filesystem trees and mocked runners.
 * No nested Vitest/Cargo/Playwright suites are launched. Assertions verify complete
 * logs, failure status, artifact copying and isolation from maintained files.
 * @packageDocumentation
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const runner = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawnSync: runner }));
import { buildTestReports, escapeHtml, reportPage, wireReportLinks } from "../scripts/test-reports";

/** Owned temporary projects; removed after each test even if an assertion fails. */
const roots: string[] = [];
/** Creates the prerequisite TypeDoc index without touching the repository docs. */
function project() {
  const root = mkdtempSync(resolve(tmpdir(), "omarkd-report-test-"));
  roots.push(root);
  mkdirSync(resolve(root, "docs/typedoc"), { recursive: true });
  writeFileSync(resolve(root, "docs/typedoc/index.html"), "API");
  return root;
}

beforeEach(() => {
  // Runners return synthetic native artifacts while filesystem publication remains real.
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  runner.mockImplementation((_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    const json = args.find(arg => arg.startsWith("--outputFile.json="))?.split("=")[1];
    const coverage = args.find(arg => arg.startsWith("--coverage.reportsDirectory="))?.split("=")[1];
    if (json) writeFileSync(json, '{"testResults":[]}');
    if (coverage) {
      mkdirSync(coverage);
      writeFileSync(resolve(coverage, "index.html"), "coverage");
    }
    const playwright = options.env.PLAYWRIGHT_HTML_OUTPUT_DIR;
    if (playwright) {
      mkdirSync(resolve(playwright, "data"), { recursive: true });
      writeFileSync(resolve(playwright, "index.html"), "Playwright");
      writeFileSync(resolve(playwright, "data/trace.zip"), "trace artifact");
    }
    return { status: 0, stdout: "all cases listed\n", stderr: "runner diagnostics\n" };
  });
});
afterEach(() => {
  // Discard only projects allocated by project(), not real report/source directories.
  runner.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Untrusted failure text stays inert while both success and failure statuses remain explicit. */
it("escapes test output and renders complete passing/failing runs with artifact navigation", () => {
  expect(escapeHtml(`<script>&"'`)).toBe("&lt;script&gt;&amp;&quot;&#39;");
  const html = reportPage("Unit & tests", [
    { command: "vitest", output: "<script>bad</script>\nfull details", status: 1, started: "today" },
    { command: "cargo", output: "every result", status: 0, started: "today" },
  ], { Coverage: "coverage/index.html" });
  expect(html).toContain("FAILED (exit 1)");
  expect(html).toContain("PASSED (exit 0)");
  expect(html).toContain("&lt;script&gt;bad&lt;/script&gt;\nfull details");
  expect(html).toContain('href="coverage/index.html"');
  expect(html).toContain('href="../../index.html"');
  expect(html).toContain('<link rel="icon" href="../../assets/favicon.svg" type="image/svg+xml">');
  expect(html).toContain('<img src="../../assets/favicon.svg" alt="">Omarkd</a>');
  expect(html).toContain('<a href="../../rust/omarkd_lib/index.html">Rust API</a>');
});

/** Real copy operations must retain nested trace assets and never overwrite the API index. */
it("copies fresh reports and traces, retaining the API and disabling documentation screenshot writes", () => {
  const root = project();
  mkdirSync(resolve(root, "docs/typedoc/reports"), { recursive: true });
  writeFileSync(resolve(root, "docs/typedoc/reports/stale.txt"), "stale");
  expect(buildTestReports(root)).toBe(0);
  expect(runner).toHaveBeenCalledTimes(3);
  expect(runner.mock.calls[0][2].env.OMARKD_SCREENSHOTS).toBe("0");
  expect(runner.mock.calls[2][2].env.OMARKD_E2E_REPORT).toBe("1");
  expect(runner.mock.calls[2][1].some((arg: string) => arg.startsWith("--output="))).toBe(true);
  expect(readFileSync(resolve(root, "docs/typedoc/index.html"), "utf8")).toBe("API");
  expect(existsSync(resolve(root, "docs/typedoc/reports/stale.txt"))).toBe(false);
  expect(readFileSync(resolve(root, "docs/typedoc/reports/e2e/playwright/data/trace.zip"), "utf8")).toBe("trace artifact");
  expect(readFileSync(resolve(root, "docs/typedoc/reports/unit/output.txt"), "utf8")).toContain("all cases listed\nrunner diagnostics");
});

/** An early runner failure must neither suppress later suites nor link to nonexistent stale coverage. */
it("publishes failures and missing-artifact diagnostics while still running the remaining suites", () => {
  const root = project();
  runner.mockImplementationOnce(() => ({ status: 1, stdout: "test failed", stderr: "assertion details" }));
  expect(buildTestReports(root)).toBe(1);
  expect(runner).toHaveBeenCalledTimes(3);
  const report = readFileSync(resolve(root, "docs/typedoc/reports/unit/index.html"), "utf8");
  expect(report).toContain("FAILED (exit 1)");
  expect(report).toContain("test failedassertion details");
  expect(report).toContain("Missing artifacts:");
  expect(report).toContain("Per-file coverage report");
  expect(report).not.toContain('href="coverage/index.html"');
});

/** Null exit status from an unlaunchable/interrupted process is failure, never a success-shaped default. */
it("reports a runner launch error or signal explicitly instead of treating it as success", () => {
  const root = project();
  runner.mockImplementationOnce(() => ({ status: null, stdout: null, stderr: null, error: new Error("missing runner"), signal: "SIGTERM" }));
  expect(buildTestReports(root)).toBe(1);
  const log = readFileSync(resolve(root, "docs/typedoc/reports/unit/output.txt"), "utf8");
  expect(log).toContain("Runner error: missing runner");
  expect(log).toContain("Terminated by SIGTERM");
});

/** Fail before expensive execution if no API site exists to receive the embedded report sections. */
it("requires a generated TypeDoc site before starting any test runner", () => {
  const root = project();
  rmSync(resolve(root, "docs/typedoc/index.html"));
  expect(() => buildTestReports(root)).toThrow("Generate TypeDoc first");
  expect(runner).not.toHaveBeenCalled();
});

/** Report navigation must work from the index and nested pages, including repeated rebuilds. */
it("rewrites only report and Rust API links relative to each API page without touching copied report assets", () => {
  const root = project();
  const site = resolve(root, "docs/typedoc");
  mkdirSync(resolve(site, "modules"));
  mkdirSync(resolve(site, "reports"));
  writeFileSync(resolve(site, "index.html"), '<a href="./reports/unit/index.html">Unit</a>');
  mkdirSync(resolve(site, "rust/omarkd_lib"), { recursive: true });
  writeFileSync(resolve(site, "modules/reader.html"), '<a href="./reports/e2e/index.html">E2E</a><a href="./rust/omarkd_lib/index.html">Rust</a><a href="../index.html">API</a>');
  writeFileSync(resolve(site, "reports/keep.html"), '<a href="./reports/unit/index.html">untouched</a>');
  writeFileSync(resolve(site, "rust/omarkd_lib/keep.html"), '<a href="./rust/omarkd_lib/index.html">untouched</a>');
  wireReportLinks(site);
  wireReportLinks(site);
  expect(readFileSync(resolve(site, "index.html"), "utf8")).toContain('href="./reports/unit/index.html"');
  expect(readFileSync(resolve(site, "modules/reader.html"), "utf8")).toContain('href="../reports/e2e/index.html"');
  expect(readFileSync(resolve(site, "modules/reader.html"), "utf8")).toContain('href="../rust/omarkd_lib/index.html"');
  expect(readFileSync(resolve(site, "rust/omarkd_lib/keep.html"), "utf8")).toContain('href="./rust/omarkd_lib/index.html"');
  expect(readFileSync(resolve(site, "modules/reader.html"), "utf8")).toContain('href="../index.html"');
  expect(readFileSync(resolve(site, "reports/keep.html"), "utf8")).toContain('href="./reports/unit/index.html"');
});
