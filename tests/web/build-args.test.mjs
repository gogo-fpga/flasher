import assert from "node:assert/strict";
import test from "node:test";

import { buildArgs } from "../../web/lib/build-args.mjs";

test("buildArgs creates SRAM and internal flash commands", () => {
  assert.deepEqual(buildArgs({ board: "tangnano1k", target: "sram" }), [
    "-b",
    "tangnano1k",
    "/input.fs",
  ]);
  assert.deepEqual(buildArgs({ board: "tangnano4k", target: "flash" }), [
    "-b",
    "tangnano4k",
    "-f",
    "/input.fs",
  ]);
  assert.deepEqual(buildArgs({ board: "tangnano20k", target: "sram" }), [
    "-b",
    "tangnano20k",
    "/input.fs",
  ]);
});

test("buildArgs verifies only Tang Nano 20K external flash writes", () => {
  assert.deepEqual(buildArgs({ board: "tangnano20k", target: "flash" }), [
    "-b",
    "tangnano20k",
    "-f",
    "/input.fs",
    "--verify",
  ]);
});

test("buildArgs rejects unknown boards and targets", () => {
  assert.throws(
    () => buildArgs({ board: "unknown", target: "sram" }),
    { name: "RangeError" },
  );
  assert.throws(
    () => buildArgs({ board: "tangnano1k", target: "eprom" }),
    { name: "RangeError" },
  );
});
