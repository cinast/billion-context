/**
 * #5155: Windows initializes a process token's integrity level from the image
 * file's mandatory label — a Low-labeled node.exe (e.g. one that inherited
 * Low from a Low-labeled parent directory) cannot write Medium-labeled files
 * even with correct ACLs; every write dies EPERM (-4048). Field A/B (#5155):
 * relabeling the runtime Low→Medium fixed the whole class with zero AV/ACL
 * change, so the label is the FIRST suspect for EPERM-on-own-data on win32,
 * ahead of antivirus. Node has no built-in API to read LABEL_SECURITY_
 * INFORMATION, so the probe asks `icacls` for the executable's own ACE list
 * (same security database) — see integrity-selfcheck.ts. This module is the
 * pure half: parsing + the canonical diagnosis text every hint surface embeds
 * so they cannot drift apart. No imports by design (logger.ts imports it).
 */

export type IntegrityLevel = "Very Low" | "Low" | "Medium" | "High" | "System";

const LEVELS: readonly IntegrityLevel[] = ["Very Low", "Low", "Medium", "High", "System"];

// icacls prints one line per ACE; the mandatory one reads
// `Mandatory Label\Low Mandatory Level:(NW)` (inherited adds `(I)`). First
// match wins — it is the only ACE class that sets the effective level.
export function parseIntegrityLevel(icaclsOutput: string): IntegrityLevel | undefined {
    const m = /Mandatory Label\\([A-Za-z ]+?) Mandatory Level/.exec(icaclsOutput);
    if (!m) return undefined;
    return LEVELS.find((l) => l === m[1]);
}

/** Canonical diagnosis + remedy for a suspected low-integrity node runtime
 *  (#5155), with the REAL runtime path so the command is copy-pasteable at
 *  every call site. Embedded verbatim by the storage degrade reason, the
 *  persist-EPERM alert and the startup self-check warn. */
export function integrityLabelDiagnosis(nodeExePath: string): string {
    return `a Low-labeled node.exe cannot write Medium-labeled files even with correct ACLs (#5155) — check icacls "${nodeExePath}" for 'Mandatory Label\\Low Mandatory Level' and restore it with icacls "${nodeExePath}" /setintegritylevel Medium, then restart`;
}
