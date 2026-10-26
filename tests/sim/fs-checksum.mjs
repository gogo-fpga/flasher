function bitValue(bits) {
  return BigInt(`0b${bits}`);
}

export function parseGowinFsChecksum(source) {
  const rows = source.split(/\r?\n/).filter((line) => line && !line.startsWith("/"));
  let idcode = 0;
  let compressed = false;
  let crcCheck = false;
  let configLength = 0;
  let headerEnd = -1;
  let zeroCodes = [0xff, 0xff, 0xff];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const key = Number.parseInt(row.slice(0, 8), 2) & 0x7f;
    const value = bitValue(row);
    if (key === 0x06) idcode = Number(value & 0xffffffffn);
    if (key === 0x10) compressed = Boolean((value >> 13n) & 1n);
    if (key === 0x51) {
      zeroCodes = [
        Number((value >> 16n) & 0xffn),
        Number((value >> 8n) & 0xffn),
        Number(value & 0xffn),
      ];
    }
    if (key === 0x3b) {
      crcCheck = Boolean((value >> 23n) & 1n);
      configLength = Number(value & 0xffffn);
      headerEnd = index;
      break;
    }
  }

  const lineCounts = new Map([
    [0x0900281b, 274],
    [0x0900381b, 274],
    [0x0100681b, 274],
    [0x0100181b, 494],
    [0x0120681b, 494],
    [0x0300081b, 494],
    [0x0300181b, 494],
    [0x0100981b, 494],
    [0x0100381b, 494],
    [0x1100381b, 494],
    [0x0100481b, 712],
    [0x1100481b, 712],
    [0x0100581b, 712],
    [0x1100581b, 712],
    [0x0000081b, 1342],
    [0x0000281b, 2038],
  ]);
  const lineCount = Math.min(lineCounts.get(idcode) ?? 0, configLength);
  const padding = [0x0100481b, 0x1100481b, 0x0100581b, 0x1100581b]
    .includes(idcode) ? 4 + (compressed ? 40 : 0) : 0;
  const drop = 48 + (crcCheck ? 16 : 0);
  let checksumBits = "";
  let checksum = 0;

  for (const row of rows.slice(headerEnd + 1, headerEnd + 1 + lineCount)) {
    let payload = row.slice(0, row.length - drop);
    if (compressed) {
      let expanded = "";
      for (let offset = 0; offset < payload.length; offset += 8) {
        const byte = Number.parseInt(payload.slice(offset, offset + 8), 2);
        const codeIndex = zeroCodes.indexOf(byte);
        expanded += codeIndex < 0 ? payload.slice(offset, offset + 8) : "0".repeat([64, 32, 16][codeIndex]);
      }
      payload = expanded;
    }
    checksumBits += payload.slice(padding);
  }
  if (checksumBits.length % 16 !== 0) {
    throw new Error("Gowin configuration checksum data is truncated");
  }
  for (let offset = 0; offset < checksumBits.length; offset += 16) {
    checksum = (checksum + Number.parseInt(checksumBits.slice(offset, offset + 16), 2)) & 0xffff;
  }
  return checksum;
}
