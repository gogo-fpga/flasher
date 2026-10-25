import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createFakeUsb } from "./fake-webusb.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const buildRoot = resolve(process.env.WASM_BUILD_ROOT ?? "build");
const variants = ["threads-off", "threads-on"];
const boards = [
  { name: "Tang Nano 1K", board: "tangnano1k", idcode: 0x0100681b, family: /GW1N/ },
  { name: "Tang Nano 4K", board: "tangnano4k", idcode: 0x0100981b, family: /GW1N/ },
  { name: "Tang Nano 9K", board: "tangnano9k", idcode: 0x1100481b, family: /GW1N/ },
  { name: "Tang Nano 20K", board: "tangnano20k", idcode: 0x0000081b, family: /GW2A/ },
];

function installNavigator(usb) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: { usb },
  });
  return () => {
    if (previous) {
      Object.defineProperty(globalThis, "navigator", previous);
    } else {
      delete globalThis.navigator;
    }
  };
}

async function runDetect(variant, idcode, args = ["--detect"], connected = true) {
  const modulePath = resolve(buildRoot, variant, "openFPGALoader.mjs");
  const { default: instantiate } = await import(pathToFileURL(modulePath));
  const { usb } = createFakeUsb(idcode, { connected });
  const stdout = [];
  const stderr = [];
  const restoreNavigator = installNavigator(usb);
  const started = performance.now();
  try {
    const module = await instantiate({
      print: (line) => stdout.push(String(line)),
      printErr: (line) => stderr.push(String(line)),
    });
    let exitCode;
    try {
      exitCode = await module.callMain(args);
      if (typeof exitCode !== "number") exitCode = 0;
    } catch (error) {
      if (typeof error?.status === "number") {
        exitCode = error.status;
      } else {
        throw error;
      }
    }
    return {
      exitCode,
      output: [...stdout, ...stderr].join("\n"),
      elapsedMs: performance.now() - started,
    };
  } finally {
    restoreNavigator();
  }
}

for (const variant of variants) {
  for (const board of boards) {
    test(`${variant}: ${board.name} --detect`, async () => {
      for (let repeat = 1; repeat <= 5; repeat += 1) {
        const result = await runDetect(variant, board.idcode);
        assert.equal(result.exitCode, 0, result.output);
        const idcode = board.idcode.toString(16).padStart(8, "0");
        assert.match(result.output, new RegExp(`0x${idcode}`, "i"));
        assert.match(result.output, board.family);
        console.log(
          `MEASURE,${variant},${board.name},${repeat},${result.elapsedMs.toFixed(3)},${board.idcode.toString(16)}`,
        );
      }
    });

    test(`${variant}: -b ${board.board} --detect`, async () => {
      for (let repeat = 1; repeat <= 5; repeat += 1) {
        const result = await runDetect(variant, board.idcode, ["-b", board.board, "--detect"]);
        assert.equal(result.exitCode, 0, result.output);
        const idcode = board.idcode.toString(16).padStart(8, "0");
        assert.match(result.output, new RegExp(`0x${idcode}`, "i"));
        assert.match(result.output, board.family);
        console.log(
          `MEASURE,${variant},${board.board} --detect,${repeat},${result.elapsedMs.toFixed(3)},${board.idcode.toString(16)}`,
        );
      }
    });
  }

  test(`${variant}: --detect reports no device`, async () => {
    const result = await runDetect(variant, 0x0100681b, ["--detect"], false);
    assert.notEqual(result.exitCode, 0, result.output);
    assert.match(result.output, /unable to open|no device|not found|failed to open/i);
    console.log(`MEASURE,${variant},no-device,${result.elapsedMs.toFixed(3)},`);
  });
}
