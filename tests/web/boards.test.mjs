import assert from "node:assert/strict";
import test from "node:test";

import { BOARDS, getBoard } from "../../web/lib/boards.mjs";

test("BOARDS contains the supported Tang Nano devices", () => {
  assert.deepEqual(BOARDS, [
    { id: "tangnano1k", label: "Tang Nano 1K", part: "GW1NZ-1", idcode: 0x0100681b },
    { id: "tangnano4k", label: "Tang Nano 4K", part: "GW1NSR-4C", idcode: 0x0100981b },
    { id: "tangnano9k", label: "Tang Nano 9K", part: "GW1N(R)-9C", idcode: 0x0100481b },
    { id: "tangnano20k", label: "Tang Nano 20K", part: "GW2A(R)-18(C)", idcode: 0x0000081b },
  ]);
  assert.equal(Object.isFrozen(BOARDS), true);
  assert.equal(getBoard("tangnano9k").part, "GW1N(R)-9C");
  assert.equal(getBoard("missing"), null);
});
