/**
 * Runs fresh test suites and publishes their complete output beside TypeDoc.
 * Reports are generated even after a test failure; the command still exits nonzero.
 * Scratch directories isolate each run so stale passing reports cannot be reused.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** One runner's command, captured output, exit status and generation timestamp. */
export interface ReportRun {
  /** Runner invocation displayed above its result, including all arguments. */
  command: string;
  /** Complete captured stdout/stderr plus explicit process-launch diagnostics. */
  output: string;
  /** Process exit code; launch failures and signals are represented as nonzero. */
  status: number;
  /** ISO timestamp captured immediately before starting the runner. */
  started: string;
}

/** Escapes all HTML-significant text so test names and failure output remain inert. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

/**
 * Builds a static report landing page with unabridged logs and artifact links.
 * A nonzero runner status is always displayed as FAILED, never a passing fallback.
 */
export function reportPage(title: string, runs: ReportRun[], links: Record<string, string>): string {
  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${escapeHtml(title)} | Omarkd</title>
<link rel="icon" href="../../assets/favicon.svg" type="image/svg+xml">
<style>body{font:16px system-ui;max-width:1100px;margin:2rem auto;padding:0 1rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f6f8fa;padding:1rem}a{color:#0969da}.failed{color:#b42318}.site-title{display:inline-flex;align-items:center;gap:.5rem}.site-title img{width:1.75rem;height:1.75rem}</style>
<p><a class="site-title" href="../../index.html"><img src="../../assets/favicon.svg" alt="">Omarkd TypeScript API</a></p>
<nav><a href="../../index.html">TypeScript API</a> · <a href="../unit/index.html">Unit tests &amp; coverage</a> · <a href="../e2e/index.html">Playwright E2E</a></nav>
<h1>${escapeHtml(title)}</h1>
<p>Fresh runner output, not a hand-written summary. Coverage measures execution, not correctness.
Browser tests mock native desktop APIs; real OS integrations require the README smoke checks.</p>
<ul>${Object.entries(links).map(([label, path]) => `<li><a href="${escapeHtml(path)}">${escapeHtml(label)}</a></li>`).join("")}</ul>
${runs.map(run => `<section><h2>${escapeHtml(run.command)}</h2>
<p class="${run.status === 0 ? "" : "failed"}">${run.status === 0 ? "PASSED" : "FAILED"} (exit ${run.status}) · Started ${escapeHtml(run.started)}</p>
<pre>${escapeHtml(run.output)}</pre></section>`).join("\n")}
</html>`;
}

/**
 * Makes TypeDoc's literal navigation links portable from nested module/class pages.
 * Only the two maintained report links are changed; report HTML and other links
 * are untouched. TypeDoc leaves navigationLinks relative to each current page.
 */
export function wireReportLinks(site: string): void {
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory() && entry.name !== "reports") visit(path);
      else if (entry.isFile() && entry.name.endsWith(".html")) {
        const prefix = relative(dirname(path), site).replaceAll("\\", "/") || ".";
        const html = readFileSync(path, "utf8");
        const linked = html.replace(/href="(?:\.\/|\.\.\/)*reports\/(unit|e2e)\/index\.html"/g,
          (_match, section: string) => `href="${prefix}/reports/${section}/index.html"`);
        if (linked !== html) writeFileSync(path, linked);
      }
    }
  }
  visit(site);
}

/** Executes a runner without a shell, preserving stdout, stderr and launch failures. */
function run(command: string, args: string[], root: string, env: NodeJS.ProcessEnv): ReportRun {
  const started = new Date().toISOString();
  console.log(`Generating report: ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? `\nRunner error: ${result.error.message}\n` : ""}${result.signal ? `\nTerminated by ${result.signal}\n` : ""}`;
  process.stdout.write(output);
  return { command: [command, ...args].join(" "), output, status: result.status ?? 1, started };
}

/**
 * Generates Vitest JSON/coverage, Rust test logs and the Playwright HTML report.
 * Only the generated reports directory is replaced; TypeDoc itself is left intact.
 * @returns Zero if all runners pass and their required artifacts exist; one otherwise.
 */
export function buildTestReports(root: string): number {
  const site = resolve(root, "docs/typedoc");
  if (!existsSync(resolve(site, "index.html"))) {
    throw new Error("Generate TypeDoc first with bun run docs:ts.");
  }
  const scratch = mkdtempSync(resolve(tmpdir(), "omarkd-test-reports-"));
  try {
    const unit = resolve(scratch, "unit");
    const e2e = resolve(scratch, "e2e");
    mkdirSync(unit);
    mkdirSync(e2e);
    // Ordinary report builds never overwrite intentional README screenshots.
    const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: "0", OMARKD_SCREENSHOTS: "0" };
    // Avoid conflicting color controls inherited from a parent terminal.
    delete env.NO_COLOR;
    const vitest = run("bun", ["x", "vitest", "run", "--coverage", "--reporter=verbose", "--reporter=json",
      `--outputFile.json=${resolve(unit, "vitest.json")}`, `--coverage.reportsDirectory=${resolve(unit, "coverage")}`], root, env);
    const rust = run("cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml", "--", "--nocapture"], root, env);
    const playwright = run("bun", ["x", "playwright", "test", `--output=${resolve(e2e, "test-results")}`], root, {
      ...env, OMARKD_E2E_REPORT: "1", PLAYWRIGHT_HTML_OUTPUT_DIR: resolve(e2e, "playwright"), PLAYWRIGHT_HTML_OPEN: "never",
    });
    const unitLinks: Record<string, string> = { "Complete unit runner output": "output.txt" };
    const e2eLinks: Record<string, string> = { "Complete E2E runner output": "output.txt" };
    const missing: string[] = [];
    for (const [path, label, links, directory] of [
      ["coverage/index.html", "Per-file coverage report", unitLinks, unit],
      ["vitest.json", "Full Vitest JSON results", unitLinks, unit],
      ["playwright/index.html", "Full Playwright report, screenshots and failure traces", e2eLinks, e2e],
    ] as const) {
      if (existsSync(resolve(directory, path))) links[label] = path;
      else {
        missing.push(label);
        console.error(`Required test artifact was not generated: ${label}`);
      }
    }
    writeFileSync(resolve(unit, "output.txt"), `${vitest.output}\n${rust.output}`);
    writeFileSync(resolve(e2e, "output.txt"), playwright.output);
    const diagnostics = missing.length ? [{ command: "Report artifact validation", output: `Missing artifacts:\n${missing.join("\n")}`, status: 1, started: new Date().toISOString() }] : [];
    writeFileSync(resolve(unit, "index.html"), reportPage("Unit tests & coverage", [vitest, rust, ...diagnostics], unitLinks));
    writeFileSync(resolve(e2e, "index.html"), reportPage("Playwright E2E results", [playwright, ...diagnostics], e2eLinks));
    const destination = resolve(site, "reports");
    // This exact generated subdirectory contains no maintained source files.
    rmSync(destination, { recursive: true, force: true });
    cpSync(scratch, destination, { recursive: true });
    wireReportLinks(site);
    console.log(`Test reports published at ${destination}`);
    return missing.length || [vitest, rust, playwright].some(result => result.status !== 0) ? 1 : 0;
  } finally {
    // Remove only the temporary directory allocated by this invocation.
    rmSync(scratch, { recursive: true, force: true });
  }
}

// The path check keeps importing helpers in unit tests from executing real suites.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = buildTestReports(resolve(import.meta.dirname, ".."));
}
