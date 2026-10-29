/**
 * #5155: startup self-check for a demoted node runtime. When the runtime's
 * own image carries a Low/Very Low mandatory label, EVERY write bili makes
 * into Medium-labeled files fails EPERM — combined-ca.pem (fatal, pre-listen),
 * index.db, session JSONs, bili.log — and the failure looks like an AV lock
 * until someone runs icacls on node.exe. A single prominent warn at startup
 * names the cause and the fix before the first write dies; it never blocks
 * or fails startup: probe errors, timeouts and unparseable output all fail
 * open in silence (a diagnostics aid must not become a new failure mode).
 */
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { log as loggerLog } from "./logger.js";
import { integrityLabelDiagnosis, parseIntegrityLevel, type IntegrityLevel } from "./integrity-label.js";

const PROBE_TIMEOUT_MS = 3000;
// icacls prints the full ACE list; the mandatory line is near the top and a
// few KB caps any pathological output without truncating the signal.
const OUTPUT_CAP = 8192;

export function selfCheckWarning(level: IntegrityLevel, execPath: string): string {
    if (level !== "Low" && level !== "Very Low") return "";
    return `[integrity] this node runtime runs at "${level}" integrity — ${integrityLabelDiagnosis(execPath)}. If the label is inherited from a parent directory, one NON-recursive relabel of that directory converges the whole tree: icacls "PARENT_DIR" /setintegritylevel Medium (no /T). Docs: CONFIGURATION.md, "Windows: node runtime demoted to low integrity (#5155)".`;
}

let started = false;

export function runIntegritySelfCheck(): void {
    if (process.platform !== "win32" || started) return;
    started = true;
    let execPath = process.execPath;
    try {
        // npm shims / junctions: the LABEL lives on the real image file.
        execPath = realpathSync(execPath);
    } catch { /* keep the given path */ }
    const child = spawn("icacls", [execPath], { windowsHide: true });
    let out = "";
    let done = false;
    const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, PROBE_TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => {
        out += d.toString();
        if (out.length > OUTPUT_CAP) { try { child.kill(); } catch { /* already gone */ } }
    });
    const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        // fail-open: missing icacls, timeout or no mandatory ACE = no warn.
        const level = parseIntegrityLevel(out);
        if (level === undefined) return;
        const msg = selfCheckWarning(level, execPath);
        if (msg !== "") loggerLog("warn", msg);
    };
    child.on("error", finish);
    child.on("close", finish);
}
