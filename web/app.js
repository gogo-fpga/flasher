import { BOARDS, getBoard } from "./lib/boards.mjs";
import { buildArgs } from "./lib/build-args.mjs";
import { classifyResult } from "./lib/classify-result.mjs";
import {
  FS_IDCODE_MASK,
  fsIdcode,
  fsIdcodeMatchesBoard,
} from "./lib/fs-idcode.mjs";
import { parseProgress } from "./lib/parse-progress.mjs";
import { writeTerminalText } from "./lib/terminal-output.mjs";

const form = document.querySelector("#program-form");
const boardSelect = document.querySelector("#board-select");
const fileInput = document.querySelector("#bitstream-file");
const programButton = document.querySelector("#program-button");
const supportStatus = document.querySelector("#support-status");
const commandPreview = document.querySelector("#command-preview");
const runPanel = document.querySelector("#run-panel");
const resultStatus = document.querySelector("#result-status");
const progressBar = document.querySelector("#progress-bar");
const programLog = document.querySelector("#program-log");
const idcodeDialog = document.querySelector("#idcode-dialog");
const idcodeWarning = document.querySelector("#idcode-warning");
const idcodeCancelButton = document.querySelector("#idcode-cancel");
const idcodeContinueButton = document.querySelector("#idcode-continue");

let supportAvailable = false;
let activeWorker = null;
let selectedFileIdcode = null;
let fileIdcodeReady = true;
let fileReadVersion = 0;
let terminalState = { text: "" };

for (const board of BOARDS) {
  const option = document.createElement("option");
  option.value = board.id;
  option.textContent = `${board.label} (${board.part})`;
  boardSelect.append(option);
}

function checkBrowserSupport() {
  const missing = [];
  if (typeof navigator.usb?.requestDevice !== "function") {
    missing.push("WebUSB");
  }
  if (!globalThis.crossOriginIsolated) {
    missing.push("Cross-Origin Isolation");
  }
  if (
    typeof WebAssembly.Suspending !== "function" ||
    typeof WebAssembly.promising !== "function"
  ) {
    missing.push("WebAssembly JSPI");
  }
  return missing;
}

function updateButton() {
  programButton.disabled =
    !supportAvailable ||
    activeWorker !== null ||
    !fileIdcodeReady ||
    fileInput.files.length === 0;
}

function setResult(text, succeeded = false) {
  resultStatus.textContent = text;
  resultStatus.dataset.result = succeeded ? "success" : "failure";
}

function formatCommand(args) {
  return ["openFPGALoader", ...args]
    .map((argument) => (/\s/.test(argument) ? JSON.stringify(argument) : argument))
    .join(" ");
}

function updateCommandPreview() {
  const board = getBoard(boardSelect.value);
  const target = new FormData(form).get("target");
  commandPreview.textContent =
    board && (target === "sram" || target === "flash")
      ? formatCommand(buildArgs({ board: board.id, target }))
      : "";
}

function formatIdcode(idcode) {
  return `0x${(idcode >>> 0).toString(16).padStart(8, "0")}`;
}

function confirmIdcodeMismatch(board, fileIdcode) {
  const boardIdcode = board.idcode & FS_IDCODE_MASK;
  const maskedFileIdcode = fileIdcode & FS_IDCODE_MASK;
  const rawValue =
    fileIdcode === maskedFileIdcode
      ? ""
      : `（生の値 ${formatIdcode(fileIdcode)}）`;
  idcodeWarning.textContent =
    `${board.label} の IDCODE ${formatIdcode(boardIdcode)} と、` +
    `ファイルの IDCODE ${formatIdcode(maskedFileIdcode)} は一致しません。` +
    rawValue;
  idcodeDialog.returnValue = "cancel";
  return new Promise((resolve) => {
    const controller = new AbortController();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      controller.abort();
      resolve(result);
    };

    idcodeDialog.addEventListener(
      "close",
      () => finish({ confirmed: false }),
      { once: true, signal: controller.signal },
    );
    idcodeCancelButton.addEventListener(
      "click",
      () => idcodeDialog.close("cancel"),
      { once: true, signal: controller.signal },
    );
    idcodeContinueButton.addEventListener(
      "click",
      (event) => {
        event.preventDefault();
        idcodeDialog.close("continue");
        finish({
          confirmed: true,
          deviceResult: requestDeviceResult(),
        });
      },
      { once: true, signal: controller.signal },
    );
    idcodeDialog.showModal();
  });
}

function requestDeviceResult() {
  try {
    return navigator.usb
      .requestDevice({
        filters: [{ vendorId: 0x0403, productId: 0x6010 }],
      })
      .then(
        (device) => ({ device }),
        (error) => ({ error }),
      );
  } catch (error) {
    return Promise.resolve({ error });
  }
}

async function readSelectedFileIdcode() {
  const file = fileInput.files[0];
  const version = ++fileReadVersion;
  selectedFileIdcode = null;
  fileIdcodeReady = file === undefined;
  updateButton();
  if (!file) {
    return;
  }

  try {
    const idcode = fsIdcode(await file.text());
    if (version === fileReadVersion) {
      selectedFileIdcode = idcode;
    }
  } catch {
    if (version === fileReadVersion) {
      selectedFileIdcode = null;
    }
  } finally {
    if (version === fileReadVersion) {
      fileIdcodeReady = true;
      updateButton();
    }
  }
}

function showRunPanel() {
  terminalState = { text: "" };
  runPanel.hidden = false;
  programLog.textContent = "";
  progressBar.value = 0;
}

function appendOutput(stream, chunk) {
  const progress = parseProgress(chunk);
  if (progress !== null) {
    progressBar.value = progress;
  }
  const text = String(chunk)
    .replace(/\x1b\[[0-9;]*m/g, "");
  const prefix = stream === "stderr" ? "[stderr] " : "";
  const lineBreak = progress === null && !text.endsWith("\n") ? "\n" : "";
  terminalState = writeTerminalText(terminalState, `${prefix}${text}${lineBreak}`);
  programLog.textContent = terminalState.text;
}

function finishRun(worker, { exitCode, timedOut = false, error = "" }) {
  if (activeWorker !== worker) {
    return;
  }
  clearTimeout(worker.runTimeout);
  worker.terminate();
  activeWorker = null;
  if (error) {
    appendOutput("stderr", error);
  }

  const result = classifyResult({
    exitCode,
    log: programLog.textContent,
    timedOut,
  });
  setResult(
    result.ok ? "成功" : `失敗：${result.reason}`,
    result.ok,
  );
  if (result.ok) {
    progressBar.value = 100;
  }
  updateButton();
}

async function startRun(board, target, file, fileIdcode) {
  let deviceResultPromise;
  if (
    fileIdcode !== null &&
    !fsIdcodeMatchesBoard(fileIdcode, board)
  ) {
    const confirmation = await confirmIdcodeMismatch(board, fileIdcode);
    if (!confirmation.confirmed) {
      return;
    }
    deviceResultPromise = confirmation.deviceResult;
  } else {
    deviceResultPromise = requestDeviceResult();
  }

  const deviceResult = await deviceResultPromise;
  if (deviceResult.error) {
    showRunPanel();
    const message =
      deviceResult.error.name === "NotFoundError"
        ? "失敗：デバイスなし"
        : `失敗：デバイス選択エラー（${deviceResult.error}）`;
    setResult(message);
    return;
  }

  updateCommandPreview();
  showRunPanel();
  resultStatus.textContent = "書き込み中です。";

  const worker = new Worker(new URL("./worker.js", import.meta.url), {
    type: "module",
  });
  activeWorker = worker;
  updateButton();

  worker.onmessage = ({ data }) => {
    if (data.type === "log") {
      appendOutput(data.stream, data.text);
    } else if (data.type === "done") {
      finishRun(worker, { exitCode: data.exitCode });
    } else if (data.type === "error") {
      finishRun(worker, {
        exitCode: data.exitCode ?? 1,
        error: data.message,
      });
    }
  };

  worker.onerror = (event) => {
    event.preventDefault();
    finishRun(worker, { exitCode: 1, error: event.message });
  };

  const timeoutMs = target === "sram" ? 120_000 : 900_000;
  worker.runTimeout = setTimeout(() => {
    finishRun(worker, { exitCode: 1, timedOut: true });
  }, timeoutMs);
  worker.postMessage({ board: board.id, target, file });
}

function initialize() {
  const missing = checkBrowserSupport();
  supportAvailable = missing.length === 0;
  supportStatus.textContent = supportAvailable
    ? "このブラウザーを利用できます。"
    : `このブラウザーでは書き込めません。足りない機能：${missing.join("、")}。COOP/COEP が有効な localhost で開いてください。`;
  updateButton();
}

boardSelect.addEventListener("change", updateCommandPreview);
form.addEventListener("change", updateCommandPreview);
fileInput.addEventListener("change", readSelectedFileIdcode);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!supportAvailable || activeWorker !== null || !fileIdcodeReady) {
    return;
  }

  const board = getBoard(boardSelect.value);
  const file = fileInput.files[0];
  const target = new FormData(form).get("target");
  if (!board || !file || (target !== "sram" && target !== "flash")) {
    return;
  }

  programButton.disabled = true;
  try {
    await startRun(board, target, file, selectedFileIdcode);
  } catch (error) {
    if (activeWorker !== null) {
      clearTimeout(activeWorker.runTimeout);
      activeWorker.terminate();
      activeWorker = null;
    }
    showRunPanel();
    const result = classifyResult({
      exitCode: 1,
      log: String(error),
    });
    setResult(`失敗：${result.reason}`);
  } finally {
    updateButton();
  }
});

updateCommandPreview();
initialize();
