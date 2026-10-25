import { buildArgs } from "./lib/build-args.mjs";

self.addEventListener("message", async ({ data }) => {
  const sendLog = (stream) => (text) => {
    self.postMessage({ type: "log", stream, text: String(text) });
  };
  const stdout = sendLog("stdout");
  const stderr = sendLog("stderr");
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  console.log = (...args) => stdout(args.map(String).join(" "));
  console.error = (...args) => stderr(args.map(String).join(" "));

  try {
    const { default: instantiate } = await import("./openFPGALoader.mjs");
    const module = await instantiate({
      print: stdout,
      printErr: stderr,
    });
    const fileBytes = new Uint8Array(await data.file.arrayBuffer());
    module.FS.writeFile("/input.fs", fileBytes);

    let exitCode = 0;
    try {
      const result = await module.callMain(
        buildArgs({ board: data.board, target: data.target }),
      );
      if (typeof result === "number") {
        exitCode = result;
      }
    } catch (error) {
      if (typeof error?.status === "number") {
        exitCode = error.status;
      } else {
        throw error;
      }
    }

    self.postMessage({ type: "done", exitCode });
  } catch (error) {
    self.postMessage({
      type: "error",
      exitCode: 1,
      message: `${error}\n${error?.stack ?? ""}`,
    });
  } finally {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  }
});
