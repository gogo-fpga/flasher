import { getBoard } from "./boards.mjs";

export function buildArgs({ board, target }) {
  if (!getBoard(board)) {
    throw new RangeError(`Unknown board: ${board}`);
  }
  if (target !== "sram" && target !== "flash") {
    throw new RangeError(`Unknown target: ${target}`);
  }

  if (target === "sram") {
    return ["-b", board, "/input.fs"];
  }

  const args = ["-b", board, "-f", "/input.fs"];
  if (board === "tangnano20k") {
    args.push("--verify");
  }
  return args;
}
