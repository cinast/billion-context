import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { sqliteOpenFailureHint } from "../src/storage/shadow.ts";
import { _resetStorageRuntimeStatusForTest, storageStatusWire } from "../src/storage/runtime-status.ts";
import { SessionStore } from "../src/persist.ts";
import { rmrf } from "./tmp-rm.ts";

/**
 * #3823/#5155: on win32, CANTOPEN ("unable to open database file") and
 * READONLY-write ("attempt to write a readonly database" — open succeeded,
 * first write refused, #4614/#5103 field shape) at index.db time are almost
 * always OS-level environment refusals — NOT a corrupt file, so the generic
 * "delete the file to reset the index" advice misleads for that class. The
 * hint fires exactly when win32 && (CANTOPEN || READONLY-write) and stays
 * silent otherwise — both directions pinned (#3617 gate discipline). #5155's
 * reproducible A/B made the node runtime's Low integrity label the FIRST
 * suspect (copy-pasteable icacls remedy embedded); antivirus ranks after.
 */

const CANT_OPEN = "Error: [storage:node:sqlite] Error: unable to open database file";
const READONLY_WRITE = "Error: [storage:node:sqlite] Error: attempt to write a readonly database";

function stubPlatform(platform: string): () => void {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    return () => Object.defineProperty(process, "platform", original!);
}

test("hint: win32 + CANTOPEN carries the OS-level suspects", () => {
    const restore = stubPlatform("win32");
    try {
        const hint = sqliteOpenFailureHint(CANT_OPEN);
        assert.ok(hint.includes("win32"), "names the platform");
        assert.ok(hint.includes("antivirus"), "still points at AV exclusions");
        assert.ok(hint.includes("%USERPROFILE%\\.local\\share\\billion-context\\"), "names the exclusion target");
        assert.ok(hint.includes("Deleting the file will not clear an OS-level refusal"), "corrects the delete-file advice");
    } finally {
        restore();
    }
});

// #5155: evidence order — the reproducible A/B switch (node runtime's Low
// integrity label, with the copy-pasteable icacls remedy) must rank BEFORE
// antivirus in the hint, and both directions of the ordering are pinned.
test("hint: win32 ranks the node runtime's integrity label before antivirus (#5155)", () => {
    const restore = stubPlatform("win32");
    try {
        for (const err of [CANT_OPEN, READONLY_WRITE]) {
            const hint = sqliteOpenFailureHint(err);
            const labelPos = hint.indexOf("integrity label");
            const avPos = hint.indexOf("antivirus");
            assert.ok(labelPos !== -1, `names the integrity label (${err})`);
            assert.ok(avPos !== -1, `still names antivirus (${err})`);
            assert.ok(labelPos < avPos, `integrity label ranks first (${err})`);
            assert.ok(hint.includes("/setintegritylevel Medium"), `carries the fix command (${err})`);
        }
    } finally {
        restore();
    }
});

test("hint: win32 + READONLY-write (open ok, write refused) fires too (#4614/#5103 shape)", () => {
    const restore = stubPlatform("win32");
    try {
        assert.ok(sqliteOpenFailureHint(READONLY_WRITE).includes("win32"), "fires on the write-refusal shape");
    } finally {
        restore();
    }
});

test("hint: non-CANTOPEN errors stay silent even on win32", () => {
    const restore = stubPlatform("win32");
    try {
        assert.equal(sqliteOpenFailureHint("Error: [storage:node:sqlite] file is not a database"), "");
        assert.equal(
            sqliteOpenFailureHint("no SQLite engine available (node:sqlite missing, better-sqlite3 not installed)"),
            "",
        );
    } finally {
        restore();
    }
});

test("hint: non-win32 platforms stay silent even on CANTOPEN", () => {
    for (const p of ["linux", "darwin"]) {
        const restore = stubPlatform(p);
        try {
            assert.equal(sqliteOpenFailureHint(CANT_OPEN), "", `expected no hint on ${p}`);
        } finally {
            restore();
        }
    }
});

const ENV_KEYS = ["BILI_SESSIONS_DIR", "BILI_CONFIG_FILE", "XDG_CACHE_HOME", "XDG_STATE_HOME", "BILI_STORAGE_UNIFIED", "BILI_ENCRYPTION_KEY"] as const;

function isolateEnv(base: string, sessions: string): Record<string, string | undefined> {
    const snap: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) snap[k] = process.env[k];
    process.env.BILI_SESSIONS_DIR = sessions;
    process.env.BILI_STORAGE_UNIFIED = "shadow";
    process.env.BILI_CONFIG_FILE = path.join(base, "absent-config.json");
    process.env.XDG_CACHE_HOME = path.join(base, "cache");
    process.env.XDG_STATE_HOME = path.join(base, "state");
    delete process.env.BILI_ENCRYPTION_KEY;
    return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
    for (const k of ENV_KEYS) {
        if (snap[k] === undefined) delete process.env[k];
        else process.env[k] = snap[k];
    }
}

test("#3823 wiring: an unopenable index.db degrades with the platform-appropriate reason", () => {
    const base = mkdtempSync(path.join(tmpdir(), "cantopen-hint-"));
    const sessions = path.join(base, "sessions");
    mkdirSync(sessions, { recursive: true });
    // A DIRECTORY named index.db: SQLite refuses to open it (SQLITE_CANTOPEN)
    // deterministically on every platform — the same error class the field
    // reports carry, minus the environment-specific cause.
    mkdirSync(path.join(sessions, "index.db"));
    const snap = isolateEnv(base, sessions);
    try {
        _resetStorageRuntimeStatusForTest();
        new SessionStore({ dir: sessions, enabled: true });
        const wire = storageStatusWire();
        assert.equal(wire.degraded, true, "the sidecar must be degraded");
        assert.equal(wire.effective, "legacy", "legacy JSON keeps serving");
        assert.ok(
            wire.reason?.startsWith("index database failed to open"),
            `reason names the open failure (got: ${wire.reason})`,
        );
        if (process.platform === "win32") {
            assert.ok(wire.reason?.includes("(win32:"), "win32 runner carries the OS-level hint");
        } else {
            assert.ok(!wire.reason?.includes("(win32:"), "non-win32 runner stays un-hinted");
        }
    } finally {
        _resetStorageRuntimeStatusForTest();
        restoreEnv(snap);
        rmrf(base);
    }
});
