// #4313: arrival timestamps on <acp> ref tags (`at="YYYY-MM-DD HH:mm"` UTC,
// minute precision) and folded-range footers (`[folded A → B UTC]`) on
// summary carriers. Off by default — every pre-#4313 wire byte-stable;
// history without a frozen time renders unmarked (no guessed "now").
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import { renderWithSnapshot } from "../src/render-refs.js";
import { defaultConfig } from "../src/config.js";
import { formatUtcMinute } from "../src/time-fmt.js";
import { syncBlocks } from "../src/sync.js";
import type { CompressionState, CoreMessage } from "../src/types.js";

function msg(id: string, text: string): CoreMessage {
  return { id, role: "user", contentType: "text", text };
}

function stateWithRefs(messages: CoreMessage[]): CompressionState {
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  return state;
}

const AT_ATTR = / at="\d{4}-\d{2}-\d{2} \d{2}:\d{2}"/;

test("formatUtcMinute: exact zero-padded UTC minute string", () => {
  assert.equal(formatUtcMinute(Date.UTC(2026, 9, 22, 6, 5)), "2026-10-22 06:05");
  assert.equal(formatUtcMinute(Date.UTC(2026, 0, 1, 0, 0)), "2026-01-01 00:00");
});

test("#4313 default off: rendered tags carry NO at-attribute (byte-stable)", () => {
  const messages = [msg("a", "hello"), msg("b", "world")];
  const state = stateWithRefs(messages);
  state.timeSnapshot = { m00001: Date.now(), m00002: Date.now() };
  const out = renderWithSnapshot(messages, state, (t) => t.length, "all");
  for (const m of out.messages) {
    assert.doesNotMatch(m.text ?? "", AT_ATTR, "no at-attribute when flag off");
  }
});

test("#4313 flag on: at-attribute renders from the frozen time, stable across renders", () => {
  const messages = [msg("a", "hello"), msg("b", "world")];
  const state = stateWithRefs(messages);
  const t0 = Date.UTC(2026, 9, 22, 6, 5);
  state.timeSnapshot = { m00001: t0, m00002: t0 + 60_000 };
  const r1 = renderWithSnapshot(messages, state, (t) => t.length, "all", true);
  assert.match(r1.messages[0]!.text!, /\x3cacp tokens="\d+" type="text" at="2026-10-22 06:05"\x3em00001\x3c\/acp\x3e\nhello/);
  assert.match(r1.messages[1]!.text!, / at="2026-10-22 06:06"/);
  // Re-render after wall-clock moved: same frozen stamps (prefix-cache safe).
  const r2 = renderWithSnapshot(messages, state, (t) => t.length, "all", true);
  assert.equal(r2.messages[0]!.text, r1.messages[0]!.text);
});

test("#4313 unmarked history: no frozen time → no at-attribute even when flag on", () => {
  const messages = [msg("legacy", "old message from before #4313")];
  const state = stateWithRefs(messages);
  delete state.timeSnapshot; // pre-#4313 persisted state
  const out = renderWithSnapshot(messages, state, (t) => t.length, "all", true);
  assert.doesNotMatch(out.messages[0]!.text ?? "", AT_ATTR, "legacy history renders unmarked");
});

test("#4313 processTurn freezes first-seen times; sync keeps folded-message times", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [msg("a", "hello there"), msg("b", "second message")];
  const r = core.processTurn({ messages, state, config: defaultConfig(200000) });
  assert.equal(r.state.timeSnapshot?.m00001, r.state.timeSnapshot?.m0002 ?? r.state.timeSnapshot?.m00002);
  assert.ok(typeof r.state.timeSnapshot?.m00001 === "number", "first-seen time frozen at ref mint");
  assert.ok(typeof r.state.timeSnapshot?.m00002 === "number");

  // Fold both messages into a block, then sync a view WITHOUT them: their
  // times must survive (summary footers read folded times), while refs of
  // messages gone without any block record are dropped.
  const folded = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00002", summary: "A long enough summary body to satisfy the minimum summary length gate of fifty characters." }],
    messages,
    state: r.state,
    config: defaultConfig(200000),
  });
  const synced = syncBlocks([], folded.state);
  assert.equal(synced.timeSnapshot?.m00001, folded.state.timeSnapshot?.m00001, "block-claimed time survives the live-ref prune");
  assert.equal(synced.timeSnapshot?.m00002, folded.state.timeSnapshot?.m00002);
});

test("#4313 summary carrier footer: fold range renders [folded A → B UTC] when on, nothing when off", () => {
  const core = createCore();
  const state = createInitialState();
  // Bodies must clear compress.minCompressRange (5000 chars default) or the
  // fold is refused as below-threshold noise.
  const big = (seed: string) => `${seed} `.repeat(1200);
  const messages = [
    msg("a", big("alpha arrival content")),
    msg("b", big("beta arrival content")),
    msg("c", "tail stays visible"),
  ];
  const turn1 = core.processTurn({ messages, state, config: defaultConfig(200000) });
  const t0 = turn1.state.timeSnapshot!.m00001!;
  const t2 = turn1.state.timeSnapshot!.m00002!;

  const cfgOn = defaultConfig(200000, { preserveRecentMessages: 1, preserveRecentTokens: 0 });
  cfgOn.renderTimestamps = true;
  const on = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00002", summary: "A long enough summary body to satisfy the minimum summary length gate of fifty characters." }],
    messages,
    state: turn1.state,
    config: cfgOn,
  });
  // Full-history view (the storage-wire shape): folded ids re-enter the
  // input and prune replaces them with the carrier at the anchor position.
  const prunedOn = core.processTurn({
    messages,
    state: on.state,
    config: cfgOn,
  });
  const carrierOn = prunedOn.messages.find((m) => (m.text ?? "").startsWith("[Compressed conversation section]"));
  assert.ok(carrierOn, `summary carrier rendered: ${JSON.stringify(prunedOn.messages.map((m) => m.text?.slice(0, 40)))}`);
  // a and b were minted in the SAME turn, so their frozen times usually
  // coincide → the single-point form renders. Accept either form (a
  // millisecond-straddled minute boundary yields the range form).
  assert.match(
    carrierOn!.text!,
    new RegExp(
      `\\n\\[folded ${formatUtcMinute(t0)}( → ${formatUtcMinute(t2)})? UTC\\]$`,
    ),
    "footer gives the folded span's arrival-time range",
  );

  // Same fold with the flag off: carrier has no footer.
  const turnOff = core.processTurn({ messages, state: createInitialState(), config: defaultConfig(200000) });
  const cfgOff = defaultConfig(200000, { preserveRecentMessages: 1, preserveRecentTokens: 0 });
  const off = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00002", summary: "A long enough summary body to satisfy the minimum summary length gate of fifty characters." }],
    messages,
    state: turnOff.state,
    config: cfgOff,
  });
  const prunedOff = core.processTurn({
    messages,
    state: off.state,
    config: cfgOff,
  });
  const carrierOff = prunedOff.messages.find((m) => (m.text ?? "").startsWith("[Compressed conversation section]"));
  assert.ok(carrierOff);
  assert.doesNotMatch(carrierOff!.text!, /\[folded /, "no footer when flag off");
});
