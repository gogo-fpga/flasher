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
  constructor(idcode, faults) {
    this.idcode = idcode >>> 0;
    this.faults = faults;
    this.externalFlash = this.idcode === 0x0000081b;
    this.nor = this.externalFlash ? new Uint8Array(8 * 1024 * 1024).fill(0xff) : null;
    this.sram = [];
    this.eflash = new Map();
    this.spiCommands = [];
    this.spiCommandCounts = new Map();
    this.instructionCounts = new Map();
    this.statusReads = [];
    this.spiReadTrace = [];
    this.wel = false;
    this.norBusy = false;
    this.norBusyPolls = 0;
    this.readCorrupted = false;
    this.disconnectAfter = faults.disconnectAfter ?? Infinity;
    this.transferCount = 0;
    this.reset();
  }

  reset() {
    this.state = TAP.reset;
    this.instruction = 0x11;
    this.irShift = 0x01;
    this.drShift = this.idcode;
    this.status = (1 << 12) | (1 << 13) | (1 << 15) | (1 << 16);
    this.eflashErasePending = false;
    this.usercode = 0;
    this.drInputBits = [];
    this.spiOutputBits = [];
    this.spiOutputIndex = 0;
    this.spiPrepared = false;
  }

  setInstruction(instruction) {
    this.instruction = instruction & 0xff;
    this.instructionCounts.set(
      this.instruction,
      (this.instructionCounts.get(this.instruction) ?? 0) + 1,
    );
    if (instruction === 0x15) this.status |= 1 << 7;
    if (instruction === 0x3a) this.status &= ~(1 << 7);
    if (instruction === 0x05) {
      this.status &= ~((1 << 13) | (1 << 5));
      this.status |= 1 << 5;
      this.sram = [];
    }
    if (instruction === 0x09) this.status &= ~(1 << 5);
    if (instruction === 0x08 && !this.faults.doneNever) this.status |= 1 << 13;
    if (instruction === 0x75) {
      this.status |= 1 << 13;
      this.eflashErasePending = true;
      this.eflash.clear();
    }
    if (instruction === 0x71) this.eflashExpectAddress = true;
    if (instruction === 0x3c) this.status |= 1 << 13;
  }

  registerValue() {
    if (this.instruction === 0x11) return this.idcode;
    if (this.instruction === 0x41) {
      if (this.eflashErasePending && !this.faults.eflashBusyForever) {
        this.status &= ~(1 << 13);
        this.eflashErasePending = false;
      }
      this.statusReads.push(this.status);
      if (this.statusReads.length > 40) this.statusReads.shift();
      return this.status;
    }
    if (this.instruction === 0x13) return this.usercode;
    return 0;
  }

  prepareShift(inputBits, hasRead) {
    if (this.state !== TAP.shiftDr || this.instruction !== 0x16 || !hasRead || this.spiPrepared) return;
    const input = [];
    for (let offset = 0; offset < inputBits.length; offset += 8) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit += 1) {
        byte = (byte << 1) | (inputBits[offset + bit] ?? 0);
      }
      input.push(byte);
    }
    const response = this.spiTransaction(input);
    const trace = { bits: inputBits.length, input, response, tdoBits: [] };
    this.spiReadTrace.push(trace);
    if (this.spiReadTrace.length > 40) this.spiReadTrace.shift();
    this.currentSpiReadTrace = trace;
    this.spiPrepared = true;
    const raw = new Uint8Array(response.length + 1);
    for (let index = 0; index < response.length; index += 1) {
      let reversed = response[index];
      reversed = ((reversed & 0x55) << 1) | ((reversed >>> 1) & 0x55);
      reversed = ((reversed & 0x33) << 2) | ((reversed >>> 2) & 0x33);
      reversed = ((reversed & 0x0f) << 4) | ((reversed >>> 4) & 0x0f);
      raw[index] = (raw[index] & 1) | ((reversed << 1) & 0xfe);
      // Gowin::spi_wait reads the final status bit from the seven-bit MPSSE tail.
      const carryOffset = input[0] === 0x05 ? 6 : 0;
      raw[index + 1] |= (reversed >>> 7) << carryOffset;
    }
    this.spiOutputBits = [];
    for (const byte of raw) {
      for (let bit = 0; bit < 8; bit += 1) this.spiOutputBits.push((byte >>> bit) & 1);
    }
    this.spiOutputIndex = 0;
  }

  spiTransaction(input) {
    if (input.length === 0) return [];
    const command = input[0];
    this.spiCommandCounts.set(command, (this.spiCommandCounts.get(command) ?? 0) + 1);
    this.spiCommands.push(input.slice(0, 8));
    if (this.spiCommands.length > 40) this.spiCommands.shift();
    const response = new Array(input.length).fill(0);
    const address = ((input[1] ?? 0) << 16) | ((input[2] ?? 0) << 8) | (input[3] ?? 0);
    if (command === 0x9f) {
      response[1] = 0xef;
      response[2] = 0x40;
      response[3] = 0x17;
    } else if (command === 0x05) {
      const status = (this.faults.norBusyForever || this.norBusy ? 1 : 0)
        | (this.wel ? 2 : 0);
      for (let index = 1; index < response.length; index += 1) {
        response[index] = status;
      }
      if (this.norBusy && !this.faults.norBusyForever && this.norBusyPolls > 0) {
        this.norBusyPolls -= 1;
        if (this.norBusyPolls === 0) this.norBusy = false;
      }
    } else if (command === 0x06) {
      this.wel = true;
    } else if (command === 0x04) {
      this.wel = false;
    } else if ((command === 0x20 || command === 0xd8) && this.wel) {
      const size = command === 0xd8 ? 0x10000 : 0x1000;
      this.nor.fill(0xff, address & ~(size - 1), Math.min(this.nor.length, (address & ~(size - 1)) + size));
      this.wel = false;
      this.norBusy = true;
      this.norBusyPolls = 1;
    } else if (command === 0x02 && this.wel) {
      for (let index = 4; index < input.length; index += 1) {
        const location = (address & ~0xff) | ((address + index - 4) & 0xff);
        this.nor[location] &= input[index];
      }
      this.wel = false;
      this.norBusy = true;
      this.norBusyPolls = 1;
    } else if (command === 0x03) {
      for (let index = 4; index < response.length; index += 1) {
        const value = this.nor[(address + index - 4) % this.nor.length];
        response[index] = this.faults.corruptNorReadback && !this.readCorrupted
          ? value ^ (this.readCorrupted = true, 1)
          : value;
      }
    } else if (command === 0xc7 && this.wel) {
      this.nor.fill(0xff);
      this.wel = false;
      this.norBusy = true;
      this.norBusyPolls = 1;
    }
    return response;
  }

  shiftedBytes() {
    const bytes = new Uint8Array(Math.ceil(this.drInputBits.length / 8));
    for (let bit = 0; bit < this.drInputBits.length; bit += 1) {
      bytes[bit >>> 3] |= this.drInputBits[bit] << (bit & 7);
    }
    return bytes;
  }

  updateDataRegister() {
    const bytes = this.shiftedBytes();
    if (this.instruction === 0x17) {
      for (let offset = 0; offset < bytes.length; offset += 8192) {
        this.sram.push(...bytes.subarray(offset, offset + 8192));
      }
    } else if (this.instruction === 0x0a) {
      this.usercode = (bytes[0] ?? 0) | ((bytes[1] ?? 0) << 8)
        | ((bytes[2] ?? 0) << 16) | ((bytes[3] ?? 0) << 24);
    } else if (this.instruction === 0x08 && !this.faults.doneNever) {
      this.status |= 1 << 13;
    } else if (this.instruction === 0x71) {
      if (this.eflashExpectAddress) {
        this.eflashAddress = ((bytes[0] ?? 0) | ((bytes[1] ?? 0) << 8)
          | ((bytes[2] ?? 0) << 16) | ((bytes[3] ?? 0) << 24)) * 4;
        this.eflashExpectAddress = false;
      } else {
        for (let offset = 0; offset < bytes.length; offset += 4) {
          const word = bytes.slice(offset, offset + 4);
          word.reverse();
          for (const byte of word) this.eflash.set(this.eflashAddress++, byte);
        }
      }
    } else if (this.instruction === 0x16 && !this.spiPrepared) {
      const bytes = [];
      for (let offset = 0; offset + 7 < this.drInputBits.length; offset += 8) {
        let byte = 0;
        for (let bit = 0; bit < 8; bit += 1) {
          byte = (byte << 1) | this.drInputBits[offset + bit];
        }
        bytes.push(byte);
      }
      this.spiTransaction(bytes);
    }
    this.drInputBits = [];
    this.spiPrepared = false;
  }

  clock(tms, tdi) {
    let tdo = 0;
    if (this.state === TAP.shiftDr) {
      if (this.instruction === 0x16) {
        tdo = this.spiOutputBits[this.spiOutputIndex++] ?? 0;
        this.currentSpiReadTrace?.tdoBits.push(tdo);
      } else {
        tdo = this.drShift & 1;
        this.drShift = (this.drShift >>> 1) | ((tdi & 1) << 31);
      }
      if ([0x16, 0x17, 0x0a, 0x08, 0x71].includes(this.instruction)) {
        this.drInputBits.push(tdi & 1);
      }
    } else if (this.state === TAP.shiftIr) {
      tdo = this.irShift & 1;
      this.irShift = (this.irShift >>> 1) | ((tdi & 1) << 7);
    }

    const next = TRANSITIONS[this.state][tms ? 1 : 0];
    if (this.state === TAP.shiftDr && next !== TAP.shiftDr && this.instruction === 0x16) {
      this.spiPrepared = false;
      this.currentSpiReadTrace = null;
    }
    if (next === TAP.captureDr) {
      this.drShift = this.registerValue();
      this.drInputBits = [];
      this.spiPrepared = false;
    } else if (next === TAP.captureIr) {
      this.irShift = 0x01;
    } else if (next === TAP.updateDr) {
      this.updateDataRegister();
    } else if (next === TAP.updateIr) {
      this.setInstruction(this.irShift);
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
  constructor(idcode, faults) {
    this.vendorId = 0x0403;
    this.productId = 0x6010;
    this.manufacturerName = "Sipeed";
    this.productName = "Tang Nano";
    this.serialNumber = "TN-S0-0001";
    this.opened = false;
    this.interfaceClaims = new Set();
    this.tap = new GowinTap(idcode, faults);
    this.faults = faults;
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
    if (++this.tap.transferCount > this.tap.disconnectAfter) {
      throw new DOMException("Device disconnected", "NotFoundError");
    }
    if (![2, 4, 0x02, 0x04].includes(endpoint)) {
      return { status: "stall", bytesWritten: 0 };
    }
    this.mpsseInput.push(...asBytes(data));
    this.consumeMpsse();
    return { status: "ok", bytesWritten: asBytes(data).byteLength };
  }

  async transferIn(endpoint, length) {
    if (++this.tap.transferCount > this.tap.disconnectAfter) {
      throw new DOMException("Device disconnected", "NotFoundError");
    }
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
      if (hasWrite && this.tap.state === TAP.shiftDr) {
        const inputBits = [];
        for (let bit = 0; bit < bits; bit += 1) {
          const byteIndex = Math.floor(bit / 8);
          const bitIndex = lsbFirst ? bit % 8 : 7 - (bit % 8);
          inputBits.push((payload[byteIndex] >>> bitIndex) & 1);
        }
        this.tap.prepareShift(inputBits, hasRead);
      }
      const received = new Array(bitMode ? 1 : count).fill(0);
      for (let bit = 0; bit < bits; bit++) {
        const byteIndex = Math.floor(bit / 8);
        const bitIndex = lsbFirst ? bit % 8 : 7 - (bit % 8);
        const tdi = hasWrite ? ((payload[byteIndex] >>> bitIndex) & 1) : 0;
        const tdo = this.tap.clock(0, tdi);
        if (hasRead) {
          const outputBit = bitMode ? bit : bit % 8;
          const outputIndex = bitMode ? 7 - outputBit : (lsbFirst ? outputBit : 7 - outputBit);
          received[byteIndex] |= tdo << outputIndex;
        }
      }
      if (hasRead) this.mpsseOutput.push(...received);
    }
  }
}

export function createFakeUsb(idcode, { connected = true, faults = {} } = {}) {
  const device = new FakeUSBDevice(idcode, faults);
  return {
    device,
    usb: {
      async getDevices() {
        return connected ? [device] : [];
      },
    },
  };
}
