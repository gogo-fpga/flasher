import assert from "node:assert/strict";
import test from "node:test";

import { createFakeUsb } from "./fake-webusb.mjs";

async function send(device, bytes) {
  await device.transferOut(2, Uint8Array.from(bytes));
}

async function shiftTms(device, bits, tdi = 0) {
  const value = bits.reduce((packed, bit, index) => packed | (bit << index), tdi << 7);
  await send(device, [0x4b, bits.length - 1, value]);
}

async function loadInstruction(device, instruction) {
  await shiftTms(device, [1, 1, 0, 0]);
  await send(device, [0x1b, 0x06, instruction & 0x7f]);
  await shiftTms(device, [1, 1, 0], instruction >>> 7);
}

test("the fake returns the MPSSE checkCRC usercode read without stale bytes", async () => {
  const { device } = createFakeUsb(0x0100681b, { flashUsercode: 0x0000a9ee, faults: {} });
  device.tap.eflash.set(0, 0xff);

  await send(device, [0x8e, 0x05]);
  await send(device, [0x8f, 0x26, 0x00]);
  assert.deepEqual(device.mpsseOutput, []);

  await shiftTms(device, [0]);
  await loadInstruction(device, 0x3c);
  assert.equal(device.tap.instruction, 0x3c);
  await loadInstruction(device, 0x13);
  assert.equal(device.tap.instruction, 0x13);
  await shiftTms(device, [1, 0, 0]);
  assert.equal(device.tap.drShift, 0x0000a9ee);

  await send(device, [0x39, 0x02, 0x00, 0x00, 0x00, 0x00]);
  await send(device, [0x3b, 0x06, 0x00]);
  await send(device, [0x6b, 0x00, 0x81]);

  assert.deepEqual(device.mpsseOutput, [0xee, 0xa9, 0x00, 0x00, 0x00]);

  const response = await device.transferIn(1, 512);
  assert.deepEqual(
    [...new Uint8Array(response.data.buffer, response.data.byteOffset, response.data.byteLength)],
    [0x01, 0x60, 0xee, 0xa9, 0x00, 0x00, 0x00],
  );
  assert.deepEqual(device.mpsseOutput, []);
});
