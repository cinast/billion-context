import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIntegrityLevel, integrityLabelDiagnosis, type IntegrityLevel } from "../src/integrity-label.ts";
import { selfCheckWarning } from "../src/integrity-selfcheck.ts";

/**
 * #5155: the startup self-check parses `icacls <node.exe>` output for the
 * mandatory ACE and warns (with the copy-pasteable remedy) only when the
 * runtime runs at Low/Very Low integrity — both directions pinned (#3617 gate
 * discipline). The probe itself fails open by construction; what can regress
 * silently is the parse/warn decision, so that is what these tests pin.
 */

// Realistic icacls listing shape: one line per ACE, mandatory line last-ish,
// "(I)" marks inherited labels, trailing summary line always present.
const icaclsListing = (mandatoryLine: string): string => [
    "C:\\Program Files\\nodejs\\node.exe    NT AUTHORITY\\SYSTEM:(I)(OI)(CI)(RX)",
    "                                    BUILTIN\\Administrators:(I)(OI)(CI)(RX)",
    "                                    BUILTIN\\Users:(I)(OI)(CI)(RX)",
    mandatoryLine,
    "",
    "Successfully processed 1 files; Failed processing 0 files",
].join("\n");

test("parseIntegrityLevel: every real level parses from a icacls listing", () => {
    const cases: Array<[string, IntegrityLevel]> = [
        ["Mandatory Label\\Very Low Mandatory Level:(I)(NW)", "Very Low"],
        ["Mandatory Label\\Low Mandatory Level:(NW)", "Low"],
        ["Mandatory Label\\Medium Mandatory Level:(I)(NW)", "Medium"],
        ["Mandatory Label\\High Mandatory Level:(NW)", "High"],
        ["Mandatory Label\\System Mandatory Level:(NW)", "System"],
    ];
    for (const [line, level] of cases) {
        assert.equal(parseIntegrityLevel(icaclsListing(line)), level, line);
    }
});

test("parseIntegrityLevel: no mandatory ACE or unknown label = undefined (fail-open)", () => {
    assert.equal(parseIntegrityLevel(icaclsListing("")), undefined, "no mandatory line at all");
    assert.equal(parseIntegrityLevel("icacls: The system cannot find the file specified."), undefined, "error output");
    assert.equal(
        parseIntegrityLevel(icaclsListing("Mandatory Label\\Some Future Level:(NW)")),
        undefined,
        "an unknown level name must not be guessed as one of ours",
    );
});

test("integrityLabelDiagnosis: embeds the real runtime path in both commands", () => {
    const p = "C:\\Program Files\\nodejs\\node.exe";
    const d = integrityLabelDiagnosis(p);
    assert.ok(d.includes(`icacls "${p}"`), "check command names the runtime");
    assert.ok(d.includes(`icacls "${p}" /setintegritylevel Medium`), "fix command names the runtime");
    assert.ok(d.includes("Mandatory Label\\Low Mandatory Level"), "names the label to look for");
    assert.ok(d.includes("#5155"), "cites the field evidence");
});

test("selfCheckWarning: Low and Very Low warn with the remedy", () => {
    const p = "C:\\Program Files\\nodejs\\node.exe";
    for (const level of ["Low", "Very Low"] as const) {
        const w = selfCheckWarning(level, p);
        assert.ok(w.length > 0, `${level} warns`);
        assert.ok(w.includes(`"${level}"`), `${level} names its level`);
        assert.ok(w.includes(`/setintegritylevel Medium`), `${level} carries the fix command`);
        assert.ok(w.includes("PARENT_DIR"), `${level} covers the inherited-from-parent case`);
    }
});

// Negative direction: a healthy runtime must produce NO warn text at all.
test("selfCheckWarning: Medium/High/System stay silent", () => {
    for (const level of ["Medium", "High", "System"] as const) {
        assert.equal(selfCheckWarning(level, "C:\\node.exe"), "", `${level} stays silent`);
    }
});
