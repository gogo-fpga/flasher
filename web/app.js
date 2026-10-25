import { BOARDS, getBoard } from "./lib/boards.mjs";
import { buildArgs } from "./lib/build-args.mjs";
import { classifyResult } from "./lib/classify-result.mjs";
import {
  fsIdcode,
  fsIdcodeMatchesBoard,
} from "./lib/fs-idcode.mjs";
import { parseProgress } from "./lib/parse-progress.mjs";

const form = document.querySelector("#program-form");
const boardSelect = document.querySelector("#board-select");
const fileInput = document.querySelector("#bitstream-file");
const programButton = document.querySelector("#program-button");
const supportStatus = document.querySelector("#support-status");
const runPanel = document.querySelector("#run-panel");
const resultStatus = document.querySelector("#result-status");
const commandLine = document.querySelector("#command-line");
const progressBar = document.querySelector("#progress-bar");
const programLog = document.querySelector("#program-log");
const idcodeDialog = document.querySelector("#idcode-dialog");
const idcodeWarning = document.querySelector("#idcode-warning");

let supportAvailable = false;
let activeWorker = null;

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
    fileInput.files.length === 0;
}

function setResult(text, succeeded = false) {
  resultStatus.textContent = text;
  resultStatus.dataset.result = succeeded ? "success" : "failure";
}

function displayCommand(args) {
  commandLine.textContent = ["openFPGALoader", ...args]
    .map((argument) => (/\s/.test(argument) ? JSON.stringify(argument) : argument))
    .join(" ");
}

function confirmIdcodeMismatch(board, fileIdcode) {
  idcodeWarning.textContent =
    `${board.label} の IDCODE は 0x${board.idcode.toString(16).padStart(8, "0")} です。` +
    `ファイルの IDCODE 0x${fileIdcode.toString(16).padStart(8, "0")} は一致しません。`;
  idcodeDialog.returnValue = "cancel";
  idcodeDialog.showModal();
  return new Promise((resolve) => {
    idcodeDialog.addEventListener(
      "close",
      () => resolve(idcodeDialog.returnValue === "continue"),
      { once: true },
    );
  });
}

function appendOutput(stream, chunk) {
  const progress = parseProgress(chunk);
  if (progress !== null) {
    progressBar.value = progress;
  }
  const text = String(chunk)
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\r/g, "\n");
  programLog.textContent += stream === "stderr" ? `[stderr] ${text}\n` : `${text}\n`;
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
  supportStatus.textContent = result.ok
    ? "書き込みが完了しました。"
    : `処理を終了しました（${result.reason}）。`;
  updateButton();
}

async function startRun(board, target, file) {
  runPanel.hidden = false;
  programLog.textContent = "";
  progressBar.value = 0;
  resultStatus.textContent = "デバイスを選択しています。";
  resultStatus.dataset.result = "";

  try {
    await navigator.usb.requestDevice({
      filters: [{ vendorId: 0x0403, productId: 0x6010 }],
    });
  } catch (error) {
    const missing = error?.name === "NotFoundError";
    setResult(
      missing ? "失敗：デバイスなし" : `失敗：デバイス選択エラー (${error})`,
    );
    supportStatus.textContent = missing
      ? "デバイスが選択されませんでした。"
      : "USB デバイスを選択できませんでした。";
    return;
  }

  const fileIdcode = fsIdcode(await file.text());
  if (
    fileIdcode !== null &&
    !fsIdcodeMatchesBoard(fileIdcode, board) &&
    !(await confirmIdcodeMismatch(board, fileIdcode))
  ) {
    setResult("中止しました。");
    supportStatus.textContent = "書き込みを中止しました。";
    return;
  }

  const args = buildArgs({ board: board.id, target });
  displayCommand(args);
  supportStatus.textContent = "書き込み中です。完了するまでお待ちください。";
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
    ? "このブラウザーは対応しています。"
    : `このブラウザーでは書き込めません。WebUSB、JSPI に対応したブラウザーを使い、COOP/COEP が有効な localhost で開いてください。不足: ${missing.join(", ")}。`;
  updateButton();
}

fileInput.addEventListener("change", updateButton);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!supportAvailable || activeWorker !== null) {
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
    await startRun(board, target, file);
  } catch (error) {
    if (activeWorker !== null) {
      clearTimeout(activeWorker.runTimeout);
      activeWorker.terminate();
      activeWorker = null;
    }
    const result = classifyResult({
      exitCode: 1,
      log: String(error),
    });
    setResult(`失敗：${result.reason}`);
    supportStatus.textContent = `処理を開始できませんでした（${result.reason}）。`;
  } finally {
    updateButton();
  }
});

initialize();
