import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createFakeUsb } from "./fake-webusb.mjs";

const [variant, idcodeHex, argsJson, faultsJson, inputFilesJson = "{}"] =
  process.argv.slice(2);
const idcode = Number.parseInt(idcodeHex, 16);
const args = JSON.parse(argsJson);
const faults = JSON.parse(faultsJson);
const inputFiles = JSON.parse(inputFilesJson);
const { device, usb } = createFakeUsb(idcode, { faults });
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  writable: true,
  value: { usb },
});

try {
  const started = performance.now();
  const buildRoot = resolve(process.env.WASM_BUILD_ROOT ?? "build");
  const modulePath = resolve(buildRoot, variant, "openFPGALoader.mjs");
  const { default: instantiate } = await import(pathToFileURL(modulePath));
  const module = await instantiate();
  for (const [path, bytes] of Object.entries(inputFiles)) {
    module.FS.writeFile(path, Uint8Array.from(bytes));
  }
  const fixtureIndex = args.findIndex((argument) => argument.endsWith(".fs"));
  if (fixtureIndex !== -1) {
    module.FS.writeFile("/fixture.fs", readFileSync(args[fixtureIndex]));
    args[fixtureIndex] = "/fixture.fs";
  }
  const callMainResult = module.callMain(args);
  const isPromise = callMainResult instanceof Promise;
  let exitCode;
  try {
    exitCode = await callMainResult;
    if (typeof exitCode !== "number") exitCode = 0;
  } catch (error) {
    if (typeof error?.status === "number") {
      exitCode = error.status;
    } else {
      throw error;
    }
  }
  const norLength = device.tap.nor?.length ?? 0;
  const norSnapshot = device.tap.nor
    ? Buffer.from(device.tap.nor.subarray(0, Math.min(norLength, 2 * 1024 * 1024)))
    : null;
  const norResultFile = Boolean(norSnapshot && process.env.SIM_NOR_RESULT_FILE);
  if (norResultFile) writeFileSync(process.env.SIM_NOR_RESULT_FILE, norSnapshot);
  let eflashLength = 0;
  for (const address of device.tap.eflash.keys()) {
    eflashLength = Math.max(eflashLength, address + 1);
  }
  const eflash = new Uint8Array(eflashLength).fill(0xff);
  for (const [address, byte] of device.tap.eflash) eflash[address] = byte;
  let dump = null;
  try {
    dump = Buffer.from(module.FS.readFile("/dump.bin")).toString("base64");
  } catch {
    dump = null;
  }
  process.stderr.write(
    `\n__PROGRAM_RESULT__${JSON.stringify({
      exitCode,
      isPromise,
      elapsedMs: performance.now() - started,
      sram: Buffer.from(device.tap.sram).toString("base64"),
      eflash: Buffer.from(eflash).toString("base64"),
      spiCommands: device.tap.spiCommands,
      spiCommandCounts: Object.fromEntries(device.tap.spiCommandCounts),
      instructionCounts: Object.fromEntries(device.tap.instructionCounts),
      status: device.tap.status,
      statusReads: device.tap.statusReads,
      spiReadTrace: device.tap.spiReadTrace,
      wel: device.tap.wel,
      norStatus: device.tap.norStatus,
      norAllErased: device.tap.nor?.every((byte) => byte === 0xff) ?? null,
      readCorrupted: device.tap.readCorrupted,
      readCorruptedAt: device.tap.readCorruptedAt,
      dump,
      nor: norResultFile ? null : norSnapshot?.toString("base64") ?? null,
      norResultFile,
    })}\n`,
  );
} catch (error) {
  process.stderr.write(
    `\n__PROGRAM_ERROR__${JSON.stringify({
      message: String(error),
      stack: error?.stack,
    })}\n`,
  );
  process.exitCode = 1;
}
if (process.env.SIM_FORCE_EXIT === "1") {
  await Promise.all([
    new Promise((resolve) => process.stdout.write("", resolve)),
    new Promise((resolve) => process.stderr.write("", resolve)),
  ]);
  process.exit(process.exitCode ?? 0);
}
