import assert from "node:assert/strict";
import test from "node:test";
import { mergeTexts } from "./merge";

test("identical notes stay unmarked", () => {
  const text = "a\nb\n";
  const merged = mergeTexts(text, text);
  assert.equal(merged.threeWay, false);
  assert.equal(merged.text, text);
  assert.equal(merged.text.includes("<<<<<<<"), false);
});

test("a two-way merge marks only the changed lines", () => {
  const merged = mergeTexts("title\nalpha\nend\n", "title\nbeta\nend\n");
  assert.match(merged.text, /title\n<<<< LOCAL\nalpha\n==== REMOTE\nbeta\n<<<< END\nend\n/);
});

test("three-way keeps a one-sided edit and marks a real conflict", () => {
  const base = "A\nB\nC\n";
  const local = "A\nX\nC\n";
  const remote = "A\nB\nY\n";
  const merged = mergeTexts(local, remote, base);
  assert.equal(merged.threeWay, true);
  assert.equal(merged.text, "A\nX\nY\n");
});

test("three-way marks the same line changed on both sides", () => {
  const merged = mergeTexts("A\nX\nC\n", "A\nY\nC\n", "A\nB\nC\n");
  assert.equal(merged.threeWay, true);
  assert.match(merged.text, /<<<< LOCAL\nX\n\|\|\|\| BASE\nB\n==== REMOTE\nY\n<<<< END/);
});
