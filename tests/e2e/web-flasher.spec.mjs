import { expect, test } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");
const fixture = resolve(repoRoot, "build/fixtures/tangnano9k.fs");
const workerSource = readFileSync(resolve(repoRoot, "web/worker.js"), "utf8");
const fakeWebUsbSource = readFileSync(
  resolve(repoRoot, "tests/sim/fake-webusb.mjs"),
  "utf8",
);
const screenshots = resolve(repoRoot, "build/screenshots");
mkdirSync(screenshots, { recursive: true });
const isolatedResponseHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};

async function stubPageUsb(page, unsupported = false) {
  await page.addInitScript((isUnsupported) => {
    const stubNavigator = Object.create(globalThis.navigator);
    Object.defineProperty(stubNavigator, "usb", {
      configurable: true,
      value: isUnsupported
        ? undefined
        : {
            async requestDevice(options) {
              window.__usbRequestOptions = options;
              return { productName: "Tang Nano (test fake)" };
            },
          },
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: stubNavigator,
    });
  }, unsupported);
}

async function routeWorkerWithFakeUsb(page, faults = {}, onWorkerRequest = () => {}) {
  await page.route("**/__e2e/fake-webusb.mjs", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript",
      headers: isolatedResponseHeaders,
      body: fakeWebUsbSource,
    }),
  );
  await page.route("**/worker-real.js", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript",
      headers: isolatedResponseHeaders,
      body: workerSource,
    }),
  );
  await page.route("**/worker.js", async (route) => {
    onWorkerRequest();
    const wrapper = `
      import { createFakeUsb } from "/__e2e/fake-webusb.mjs";
      const fake = createFakeUsb(0x1100481b, { faults: ${JSON.stringify(faults)} });
      const originalNavigator = globalThis.navigator;
      const fakeNavigator = Object.create(originalNavigator);
      Object.defineProperties(fakeNavigator, {
        userAgent: {
          configurable: true,
          value: originalNavigator.userAgent,
        },
        language: {
          configurable: true,
          value: originalNavigator.language,
        },
        usb: {
          configurable: true,
          value: fake.usb,
        },
      });
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: fakeNavigator,
      });
      const originalAddEventListener = self.addEventListener.bind(self);
      const pendingMessages = [];
      let realMessageHandlerReady = false;
      originalAddEventListener("message", (event) => {
        if (!realMessageHandlerReady) {
          pendingMessages.push(event);
        }
      });
      self.addEventListener = (type, listener, options) => {
        if (type === "message") {
          realMessageHandlerReady = true;
          for (const event of pendingMessages.splice(0)) {
            queueMicrotask(() => listener.call(self, event));
          }
        }
        return originalAddEventListener(type, listener, options);
      };
      await import("/worker-real.js");
    `;
    await route.fulfill({
      status: 200,
      contentType: "text/javascript",
      headers: isolatedResponseHeaders,
      body: wrapper,
    });
  });
}

async function openSupportedPage(page) {
  await stubPageUsb(page);
  await page.goto("/");
  await expect(page.locator("#support-status")).toHaveText(
    "このブラウザーは対応しています。",
  );
}

test("support check passes and the page renders", async ({ page }) => {
  await openSupportedPage(page);
  await expect(page.locator("#board-select option")).toHaveCount(4);
  await expect(page.getByRole("button", { name: "書き込む" })).toBeDisabled();
  await page.screenshot({
    path: resolve(screenshots, "initial.png"),
    fullPage: true,
  });
});

test("9K SRAM programming succeeds and reports progress", async ({ page }) => {
  let workerRequests = 0;
  await routeWorkerWithFakeUsb(page, {}, () => {
    workerRequests += 1;
  });
  await openSupportedPage(page);
  await page.locator("#board-select").selectOption("tangnano9k");
  await page.locator("#bitstream-file").setInputFiles(fixture);
  await page.getByRole("button", { name: "書き込む" }).click();

  await expect(page.locator("#result-status")).toHaveText("成功", {
    timeout: 30_000,
  });
  await expect(page.locator("#command-line")).toHaveText(
    "openFPGALoader -b tangnano9k /input.fs",
  );
  await expect(page.locator("#program-log")).toContainText("Load SRAM");
  await expect(page.locator("#progress-bar")).toHaveJSProperty("value", 100);
  expect(await page.evaluate(() => window.__usbRequestOptions.filters)).toEqual([
    { vendorId: 0x0403, productId: 0x6010 },
  ]);
  expect(workerRequests).toBe(1);
  await page.screenshot({
    path: resolve(screenshots, "success.png"),
    fullPage: true,
  });
});

test("DONE never set is reported as failure despite exit zero", async ({ page }) => {
  await routeWorkerWithFakeUsb(page, { doneNever: true });
  await openSupportedPage(page);
  await page.locator("#board-select").selectOption("tangnano9k");
  await page.locator("#bitstream-file").setInputFiles(fixture);
  await page.getByRole("button", { name: "書き込む" }).click();

  await expect(page.locator("#result-status")).toHaveText("失敗：書き込み失敗", {
    timeout: 30_000,
  });
  await expect(page.locator("#program-log")).toContainText("FAIL");
  await page.screenshot({
    path: resolve(screenshots, "failure.png"),
    fullPage: true,
  });
});

test("IDCODE mismatch requires confirmation and cancel stops the run", async ({
  page,
}) => {
  let workerRequests = 0;
  await routeWorkerWithFakeUsb(page, {}, () => {
    workerRequests += 1;
  });
  await openSupportedPage(page);
  await page.locator("#board-select").selectOption("tangnano1k");
  await page.locator("#bitstream-file").setInputFiles(fixture);
  await page.getByRole("button", { name: "書き込む" }).click();

  const dialog = page.locator("#idcode-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("一致しません");
  await page.screenshot({
    path: resolve(screenshots, "mismatch-warning.png"),
    fullPage: true,
  });
  await dialog.getByRole("button", { name: "キャンセル" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#result-status")).toHaveText("中止しました。");
  expect(workerRequests).toBe(0);
});

test("unsupported browser shows a message and keeps the button disabled", async ({
  page,
}) => {
  await stubPageUsb(page, true);
  await page.goto("/");

  await expect(page.locator("#support-status")).toContainText(
    "このブラウザーでは書き込めません",
  );
  await expect(page.getByRole("button", { name: "書き込む" })).toBeDisabled();
  await page.screenshot({
    path: resolve(screenshots, "unsupported.png"),
    fullPage: true,
  });
});
