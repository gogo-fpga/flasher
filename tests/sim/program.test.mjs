import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");
const runner = resolve(import.meta.dirname, "run-program.mjs");
const buildRoot = resolve(process.env.WASM_BUILD_ROOT ?? "build");
const variant = "jspi-pthread";
const boards = [
  { name: "Tang Nano 1K", board: "tangnano1k", idcode: 0x0100681b },
  { name: "Tang Nano 4K", board: "tangnano4k", idcode: 0x0100981b },
  { name: "Tang Nano 9K", board: "tangnano9k", idcode: 0x1100481b },
  { name: "Tang Nano 20K", board: "tangnano20k", idcode: 0x0000081b },
];

function fsRecords(board) {
  const path = resolve(repoRoot, "build/fixtures", `${board}.fs`);
  return readFileSync(path, "ascii")
    .split(/\r?\n/)
    .filter((line) => /^[01]+$/.test(line));
}

function parseFsPayload(board, reverseByte = false) {
  const records = fsRecords(board);
  const bytes = [];
  for (const record of records) {
    for (let offset = 0; offset < record.length; offset += 8) {
      let value = Number.parseInt(record.slice(offset, offset + 8), 2);
      if (reverseByte) {
        value = ((value & 0x55) << 1) | ((value >>> 1) & 0x55);
        value = ((value & 0x33) << 2) | ((value >>> 2) & 0x33);
        value = ((value & 0x0f) << 4) | ((value >>> 4) & 0x0f);
      }
      bytes.push(value);
    }
  }
  return Buffer.from(bytes);
}

function runProgram(board, args, faults = {}, timeout = 90_000) {
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const child = spawnSync(
    process.execPath,
    [runner, variant, board.idcode.toString(16), JSON.stringify(args), JSON.stringify(faults)],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: childEnv,
      maxBuffer: 8 * 1024 * 1024,
      timeout,
    },
  );
  if (child.error?.code === "ETIMEDOUT") {
    return {
      exitCode: child.status ?? 1,
      timedOut: true,
      timeoutCode: child.error.code,
      output: `${child.stdout}\n${child.stderr}`,
    };
  }
  if (child.error) {
    throw new Error(`Programming subprocess failed: ${child.error.message}`, { cause: child.error });
  }
  const marker = /(?:^|\r?\n)__PROGRAM_RESULT__(\{[^\r\n]*\})(?:\r?\n|$)/.exec(child.stderr);
  assert.ok(
    marker,
    `Programming subprocess returned ${child.status}\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`,
  );
  return {
    ...JSON.parse(marker[1]),
    output: `${child.stdout}\n${child.stderr.replace(marker[0], "\n")}`,
  };
}

function measured(testName, variantName, boardName, repeat, result) {
  console.log(
    `PROGRAM_MEASURE,${variantName},${boardName},${testName},${repeat},${result.elapsedMs.toFixed(3)}`,
  );
}

assert.ok(
  ["openFPGALoader.mjs", "openFPGALoader.wasm"].every((name) =>
    readFileSync(resolve(buildRoot, variant, name)),
  ),
  `Missing JSPI/pthread artifacts under ${buildRoot}`,
);

for (const board of boards) {
  const fixture = resolve(repoRoot, "build/fixtures", `${board.board}.fs`);
  test(`SRAM programming: ${board.name}`, { timeout: 300_000 }, () => {
    const expected = parseFsPayload(board.board, true);
    for (let repeat = 1; repeat <= 5; repeat += 1) {
      const result = runProgram(board, ["-b", board.board, fixture]);
      assert.equal(result.exitCode, 0, result.output);
      assert.deepEqual(Buffer.from(result.sram, "base64"), expected);
      measured("sram", variant, board.name, repeat, result);
    }
  });

  test(`flash programming: ${board.name}`, { timeout: 300_000 }, () => {
    for (let repeat = 1; repeat <= 5; repeat += 1) {
      const result = runProgram(board, ["-b", board.board, "-f", fixture]);
      assert.equal(result.exitCode, 0, result.output);
      if (board.idcode === 0x0000081b) {
        assert.ok(result.spiCommandCounts[6] > 0, "SPI write-enable was not exercised");
        assert.ok(result.spiCommandCounts[5] > 0, "SPI status polling was not exercised");
        assert.ok(result.spiCommandCounts[0xd8] > 0, "NOR block erase was not exercised");
        assert.ok(result.spiCommandCounts[2] > 0, "NOR page program was not exercised");
        assert.ok(
          result.spiReadTrace.some(({ input, response }) => input[0] === 0x05 && (response[1] & 1)),
          "NOR busy status was not exercised",
        );
        assert.ok(
          result.spiReadTrace.some(({ input, response }) => input[0] === 0x05 && !(response[1] & 1)),
          "NOR ready status was not exercised",
        );
        assert.deepEqual(
          Buffer.from(result.nor, "base64").subarray(0, parseFsPayload(board.board).length),
          parseFsPayload(board.board),
        );
      } else {
        const expected = Buffer.concat([
          Buffer.from("GW1N"),
          Buffer.alloc(20, 0xff),
          parseFsPayload(board.board),
        ]);
        assert.deepEqual(
          Buffer.from(result.eflash, "base64").subarray(0, expected.length),
          expected,
        );
      }
      measured("flash", variant, board.name, repeat, result);
    }
  });
}

test("IDCODE mismatch is rejected before programming", () => {
  const target = boards[0];
  const child = spawnSync(
    process.execPath,
    [
      runner,
      variant,
      target.idcode.toString(16),
      JSON.stringify(["-b", target.board, resolve(repoRoot, "build/fixtures/tangnano9k.fs")]),
      "{}",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, WASM_BUILD_ROOT: buildRoot },
      maxBuffer: 2 * 1024 * 1024,
      timeout: 30_000,
    },
  );
  const output = `${child.stdout}\n${child.stderr}`;
  assert.ok(child.status !== 0, output);
  assert.match(output, /mismatch between target's idcode and bitstream idcode/i);
});

test("DONE-never-set follows upstream's printed-failure/zero-exit behavior", { timeout: 30_000 }, () => {
  const board = boards[0];
  const result = runProgram(
    board,
    ["-b", board.board, resolve(repoRoot, "build/fixtures", `${board.board}.fs`)],
    { doneNever: true },
  );
  // programSRAM returns void after writeSRAM reports FAIL; main still exits zero.
  assert.equal(result.exitCode, 0, result.output);
  assert.match(result.output, /FAIL/);
});

test("internal eflash busy remains unnoticed by upstream", { timeout: 120_000 }, () => {
  const board = boards[0];
  const result = runProgram(
    board,
    ["-b", board.board, "-f", resolve(repoRoot, "build/fixtures", `${board.board}.fs`)],
    { eflashBusyForever: true },
  );
  assert.equal(result.instructionCounts[0x75], 1);
  assert.ok(result.statusReads.some((status) => status & (1 << 13)));
  // The fake keeps DONE_FINAL set, but upstream still reports Erase FLASH DONE and exits zero.
  assert.equal(result.exitCode, 0, result.output);
  assert.match(result.output, /Erase FLASH .*DONE/);
});

test("NOR erase busy remains bounded by the subprocess timeout", { timeout: 60_000 }, () => {
  const board = boards[3];
  const result = runProgram(
    board,
    ["-b", board.board, "-f", resolve(repoRoot, "build/fixtures", `${board.board}.fs`)],
    { norBusyForever: true },
    30_000,
  );
  // The fake holds WIP high; upstream's 100000-poll wait exceeded 240 seconds in Node.
  assert.equal(result.timedOut, true, result.output);
  assert.equal(result.timeoutCode, "ETIMEDOUT");
  assert.notEqual(result.exitCode, 0, result.output);
});

test("NOR readback corruption is detected by --verify", { timeout: 60_000 }, () => {
  const board = boards[3];
  const result = runProgram(
    board,
    ["-b", board.board, "-f", "--verify", resolve(repoRoot, "build/fixtures", `${board.board}.fs`)],
    { corruptNorReadback: true },
  );
  assert.notEqual(result.exitCode, 0, result.output);
  assert.match(result.output, /Verification failed/i);
  assert.ok(result.spiCommandCounts[3] > 0, "NOR read was not exercised");
});

test("USB disconnect during transfer is reported without a hang", { timeout: 30_000 }, () => {
  const board = boards[1];
  const result = runProgram(
    board,
    ["-b", board.board, resolve(repoRoot, "build/fixtures", `${board.board}.fs`)],
    { disconnectAfter: 30 },
  );
  // WebUSB rejects with NotFoundError, but upstream logs FAIL and still exits zero.
  assert.equal(result.exitCode, 0, result.output);
  assert.match(result.output, /NotFoundError/);
  assert.match(result.output, /FAIL/);
});

test("payload comparator negative control rejects a corrupted bit", () => {
  const expected = parseFsPayload("tangnano1k", true);
  const captured = Buffer.from(expected);
  captured[0] ^= 1;
  assert.notDeepEqual(captured, expected);
});
