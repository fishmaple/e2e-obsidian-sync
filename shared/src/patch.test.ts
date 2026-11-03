import assert from "node:assert/strict";
import test from "node:test";
import { applyPatch, diffBytes } from "./patch";

test("a patch round-trips inserts, deletes, and identical bytes", () => {
  const base = new TextEncoder().encode("alpha\nbeta\ngamma\n");
  const next = new TextEncoder().encode("alpha\nBETA\ngamma\ndelta\n");
  const patch = diffBytes(base, next);
  assert.ok(patch.byteLength < next.byteLength + 16);
  assert.deepEqual(applyPatch(base, patch), next);
  assert.deepEqual(applyPatch(base, diffBytes(base, base)), base);
  assert.deepEqual(applyPatch(new Uint8Array(), diffBytes(new Uint8Array(), next)), next);
});

test("patches keep binary bytes and several scattered edits", () => {
  const base = new Uint8Array(400);
  for (let i = 0; i < base.length; i++) base[i] = i % 251;
  const next = base.slice();
  next[3] = 0;
  next[80] = 255;
  next.set([1, 2, 3, 0, 9], 200);
  const extra = new Uint8Array(next.length + 5);
  extra.set(next, 0);
  extra.set([7, 8, 9, 0, 1], next.length);
  const patch = diffBytes(base, extra);
  assert.deepEqual(applyPatch(base, patch), extra);
  assert.ok(patch.byteLength < extra.byteLength);
});

test("random edits rebuild the next bytes", () => {
  let state = 0x12345678;
  const rand = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  for (let round = 0; round < 20; round++) {
    const base = new Uint8Array(50 + (rand() % 80));
    for (let i = 0; i < base.length; i++) base[i] = rand() & 0xff;
    const next = base.slice(0, Math.max(0, base.length - (rand() % 15)));
    const grown = new Uint8Array(next.length + (rand() % 20));
    grown.set(next, 0);
    for (let i = next.length; i < grown.length; i++) grown[i] = rand() & 0xff;
    if (grown.length > 4) grown[rand() % grown.length] = rand() & 0xff;
    assert.deepEqual(applyPatch(base, diffBytes(base, grown)), grown);
  }
});
