const TAP = {
  reset: 0,
  idle: 1,
  selectDr: 2,
  captureDr: 3,
  shiftDr: 4,
  exit1Dr: 5,
  pauseDr: 6,
  exit2Dr: 7,
  updateDr: 8,
  selectIr: 9,
  captureIr: 10,
  shiftIr: 11,
  exit1Ir: 12,
  pauseIr: 13,
  exit2Ir: 14,
  updateIr: 15,
};

const TRANSITIONS = [
  [TAP.idle, TAP.reset],
  [TAP.idle, TAP.selectDr],
  [TAP.captureDr, TAP.selectIr],
  [TAP.shiftDr, TAP.exit1Dr],
  [TAP.shiftDr, TAP.exit1Dr],
  [TAP.pauseDr, TAP.updateDr],
  [TAP.pauseDr, TAP.exit2Dr],
  [TAP.shiftDr, TAP.updateDr],
  [TAP.idle, TAP.selectDr],
  [TAP.captureIr, TAP.reset],
  [TAP.shiftIr, TAP.exit1Ir],
  [TAP.shiftIr, TAP.exit1Ir],
  [TAP.pauseIr, TAP.updateIr],
  [TAP.pauseIr, TAP.exit2Ir],
  [TAP.shiftIr, TAP.updateIr],
  [TAP.idle, TAP.selectDr],
];

class GowinTap {
  constructor(idcode) {
    this.idcode = idcode >>> 0;
    this.reset();
  }

  reset() {
    this.state = TAP.reset;
    this.instruction = 0x11;
    this.irShift = 0x01;
    this.drShift = this.idcode;
  }

  clock(tms, tdi) {
    let tdo = 0;
    if (this.state === TAP.shiftDr) {
      tdo = this.drShift & 1;
      this.drShift = (this.drShift >>> 1) | ((tdi & 1) << 31);
    } else if (this.state === TAP.shiftIr) {
      tdo = this.irShift & 1;
      this.irShift = (this.irShift >>> 1) | ((tdi & 1) << 7);
    }

    const next = TRANSITIONS[this.state][tms ? 1 : 0];
    if (next === TAP.captureDr) {
      this.drShift = this.instruction === 0x41 ? 0x00000001 : this.idcode;
    } else if (next === TAP.captureIr) {
      this.irShift = 0x01;
    } else if (next === TAP.updateIr) {
      this.instruction = this.irShift & 0xff;
    } else if (next === TAP.reset) {
      this.instruction = 0x11;
    }
    this.state = next;
    return tdo;
  }
}

function asBytes(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(data ?? []);
}

function descriptorView(bytes, length) {
  const view = Uint8Array.from(bytes).subarray(0, length);
  return new DataView(view.buffer, view.byteOffset, view.byteLength);
}

function stringDescriptor(value) {
  const bytes = [2 + value.length * 2, 3];
  for (const character of value) {
    const code = character.charCodeAt(0);
    bytes.push(code & 0xff, code >>> 8);
  }
  return bytes;
}

class FakeUSBDevice {
  constructor(idcode) {
    this.vendorId = 0x0403;
    this.productId = 0x6010;
    this.manufacturerName = "Sipeed";
    this.productName = "Tang Nano";
    this.serialNumber = "TN-S0-0001";
    this.opened = false;
    this.interfaceClaims = new Set();
    this.tap = new GowinTap(idcode);
    this.mpsseInput = [];
    this.mpsseOutput = [];
    this.strings = [
      "",
      "Sipeed",
      "Tang Nano",
      "TN-S0-0001",
    ];
    this.configurations = [{
      configurationValue: 1,
      interfaces: [0, 1].map((interfaceNumber) => ({
        interfaceNumber,
        alternates: [{
          alternateSetting: 0,
          interfaceClass: 0xff,
          interfaceSubclass: 0xff,
          interfaceProtocol: 0xff,
          endpoints: [
            {
              endpointNumber: interfaceNumber === 0 ? 1 : 3,
              direction: "in",
              type: "bulk",
              packetSize: 512,
            },
            {
              endpointNumber: interfaceNumber === 0 ? 2 : 4,
              direction: "out",
              type: "bulk",
              packetSize: 512,
            },
          ],
        }],
      })),
    }];
    this.configuration = null;
  }

  async open() {
    this.opened = true;
  }

  async close() {
    this.opened = false;
  }

  async reset() {
    this.tap.reset();
    this.mpsseInput = [];
    this.mpsseOutput = [];
  }

  async selectConfiguration(configurationValue) {
    this.configuration =
      this.configurations.find((item) => item.configurationValue === configurationValue) ?? null;
  }

  async claimInterface(interfaceNumber) {
    this.interfaceClaims.add(interfaceNumber);
  }

  async releaseInterface(interfaceNumber) {
    this.interfaceClaims.delete(interfaceNumber);
  }

  async controlTransferIn(setup, length) {
    let bytes = [];
    if (setup.request === 6 && setup.requestType === "standard") {
      const descriptorType = setup.value >>> 8;
      const descriptorIndex = setup.value & 0xff;
      if (descriptorType === 1) {
        bytes = [
          18, 1, 0x00, 0x02, 0, 0, 0, 64,
          0x03, 0x04, 0x10, 0x60, 0x00, 0x07,
          1, 2, 3, 1,
        ];
      } else if (descriptorType === 2) {
        bytes = [
          9, 2, 55, 0, 2, 1, 0, 0x80, 50,
          9, 4, 0, 0, 2, 0xff, 0xff, 0xff, 0,
          7, 5, 0x81, 2, 0x00, 0x02, 0,
          7, 5, 0x02, 2, 0x00, 0x02, 0,
          9, 4, 1, 0, 2, 0xff, 0xff, 0xff, 0,
          7, 5, 0x83, 2, 0x00, 0x02, 0,
          7, 5, 0x04, 2, 0x00, 0x02, 0,
        ];
      } else if (descriptorType === 3) {
        bytes = descriptorIndex === 0
          ? [4, 3, 0x09, 0x04]
          : stringDescriptor(this.strings[descriptorIndex] ?? "");
      }
    } else if (setup.requestType === "vendor") {
      bytes = [0x60];
    } else if (setup.request === 8) {
      bytes = [1];
    }
    return { status: "ok", data: descriptorView(bytes, length) };
  }

  async controlTransferOut(_setup, data) {
    return { status: "ok", bytesWritten: asBytes(data).byteLength };
  }

  async clearHalt() {
    return { status: "ok" };
  }

  async transferOut(endpoint, data) {
    if (![2, 4, 0x02, 0x04].includes(endpoint)) {
      return { status: "stall", bytesWritten: 0 };
    }
    this.mpsseInput.push(...asBytes(data));
    this.consumeMpsse();
    return { status: "ok", bytesWritten: asBytes(data).byteLength };
  }

  async transferIn(endpoint, length) {
    if (![1, 3, 0x81, 0x83].includes(endpoint)) {
      return { status: "stall", data: new DataView(new ArrayBuffer(0)) };
    }
    const maxPayload = Math.max(1, Math.min(510, length - 2));
    const output = [];
    while (this.mpsseOutput.length > 0 && output.length < length) {
      output.push(0x01, 0x60);
      const count = Math.min(maxPayload, this.mpsseOutput.length, length - output.length - 2);
      if (count <= 0) break;
      output.push(...this.mpsseOutput.splice(0, count));
    }
    if (output.length === 0) output.push(0x01, 0x60);
    return { status: "ok", data: descriptorView(output, length) };
  }

  consumeMpsse() {
    while (this.mpsseInput.length > 0) {
      const command = this.mpsseInput[0];
      if (command === 0xaa || command === 0xab) {
        this.mpsseInput.shift();
        this.mpsseOutput.push(0xfa, command);
        continue;
      }
      if (command === 0x80 || command === 0x82 || command === 0x86) {
        if (this.mpsseInput.length < 3) return;
        this.mpsseInput.splice(0, 3);
        continue;
      }
      if ([0x81, 0x83].includes(command)) {
        this.mpsseInput.shift();
        this.mpsseOutput.push(0xff);
        continue;
      }
      if ([0x8a, 0x8b, 0x8d, 0x8e, 0x8f, 0x97, 0x85, 0x87].includes(command)) {
        this.mpsseInput.shift();
        continue;
      }
      if (command === 0x4b || command === 0x6b) {
        if (this.mpsseInput.length < 3) return;
        const count = this.mpsseInput[1] + 1;
        const bits = this.mpsseInput[2];
        this.mpsseInput.splice(0, 3);
        let result = 0;
        for (let bit = 0; bit < count; bit++) {
          const tms = (bits >>> bit) & 1;
          const tdo = this.tap.clock(tms, bits >>> 7);
          result |= tdo << (7 - bit);
        }
        if (command === 0x6b) this.mpsseOutput.push(result);
        continue;
      }

      const mode = command & 0x30;
      if (![0x10, 0x20, 0x30].includes(mode)) {
        this.mpsseInput.shift();
        continue;
      }
      const bitMode = Boolean(command & 0x02);
      const hasWrite = mode === 0x10 || mode === 0x30;
      const hasRead = mode === 0x20 || mode === 0x30;
      const lsbFirst = Boolean(command & 0x08);
      const headerSize = bitMode ? 2 : 3;
      if (this.mpsseInput.length < headerSize) return;
      const count = bitMode
        ? this.mpsseInput[1] + 1
        : (this.mpsseInput[1] | (this.mpsseInput[2] << 8)) + 1;
      const dataBytes = hasWrite ? (bitMode ? 1 : count) : 0;
      if (this.mpsseInput.length < headerSize + dataBytes) return;
      const payload = this.mpsseInput.slice(headerSize, headerSize + dataBytes);
      this.mpsseInput.splice(0, headerSize + dataBytes);
      const bits = bitMode ? count : count * 8;
      const received = new Array(bitMode ? 1 : count).fill(0);
      for (let bit = 0; bit < bits; bit++) {
        const byteIndex = Math.floor(bit / 8);
        const bitIndex = lsbFirst ? bit % 8 : 7 - (bit % 8);
        const tdi = hasWrite ? ((payload[byteIndex] >>> bitIndex) & 1) : 0;
        const tdo = this.tap.clock(0, tdi);
        if (hasRead) {
          const outputBit = bitMode ? bit : bit % 8;
          const outputIndex = lsbFirst ? outputBit : 7 - outputBit;
          received[byteIndex] |= tdo << outputIndex;
        }
      }
      if (hasRead) this.mpsseOutput.push(...received);
    }
  }
}

export function createFakeUsb(idcode, { connected = true } = {}) {
  const device = new FakeUSBDevice(idcode);
  return {
    device,
    usb: {
      async getDevices() {
        return connected ? [device] : [];
      },
    },
  };
}
