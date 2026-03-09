import puppeteer, { Browser } from "puppeteer-core";
import {
  IDNSession,
  saveSession,
  waitForOTP,
  setJobStatus,
  getSession,
} from "./redis";

const LOGIN_URL =
  "https://connect.idn.media/?client_id=6gnaj30oomhtl0t3qtkfp2uir9&redirect_uri=https://www.idn.app/&authorization_code=ef04562d-89e7-4322-b8ef-86dc4bf49814&state=dU5LvM8nvbI0REKm86t3hPjyXghAWS4m";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

// ─── Semua patch anti-bot inline, tanpa library external ─────────────────────
const STEALTH_SCRIPT = `
  // 1. Sembunyikan webdriver
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

  // 2. Simulasi plugins browser asli
  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      const arr = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
      ];
      arr.__proto__ = PluginArray.prototype;
      return arr;
    }
  });

  // 3. Languages
  Object.defineProperty(navigator, 'languages', { get: () => ['id-ID', 'id', 'en-US', 'en'] });

  // 4. Chrome object
  window.chrome = {
    app: {
      InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
      RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
      getDetails: () => null,
      getIsInstalled: () => false,
      installState: () => {},
      isInstalled: false,
      runningState: () => 'cannot_run',
    },
    runtime: {
      OnInstalledReason: {},
      OnRestartRequiredReason: {},
      PlatformArch: {},
      PlatformOs: {},
      RequestUpdateCheckStatus: {},
      connect: () => {},
      sendMessage: () => {},
    },
    loadTimes: () => ({}),
    csi: () => ({}),
  };

  // 5. Permissions
  const originalQuery = window.navigator.permissions.query;
  window.navigator.permissions.query = (parameters) => {
    if (parameters.name === 'notifications') {
      return Promise.resolve({ state: Notification.permission });
    }
    return originalQuery(parameters);
  };

  // 6. Hapus ciri automation
  delete window.__nightmare;
  delete window._phantom;
  delete window.callPhantom;
  delete window.__webdriver_evaluate;
  delete window.__selenium_evaluate;

  // 7. Hardware concurrency
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });

  // 8. Platform
  Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });

  // 9. Vendor
  Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.' });

  // 10. iframe contentWindow
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
    get: function() {
      return window;
    }
  });
`;

async function launchBrowser(): Promise<Browser> {
  const wsEndpoint = process.env.BROWSER_WS_ENDPOINT;
  if (!wsEndpoint) throw new Error("BROWSER_WS_ENDPOINT tidak diset.");

  console.log("[Browser] Connecting...");
  const browser = await puppeteer.connect({
    browserWSEndpoint: wsEndpoint,
    defaultViewport: { width: 1280, height: 800 },
  });
  console.log("[Browser] ✅ Connected");
  return browser;
}

async function debugPage(page: any, label: string) {
  try {
    const url = page.url();
    const text: string = await page.evaluate(
      () => (document.body?.innerText ?? "").slice(0, 400)
    );
    console.log(`[DEBUG:${label}] URL: ${url}`);
    console.log(`[DEBUG:${label}] Body: ${text}`);
  } catch (e: any) {
    console.log(`[DEBUG:${label}] error: ${e.message}`);
  }
}

export async function runIDNLogin(email: string): Promise<IDNSession> {
  await setJobStatus(email, {
    status: "running",
    message: "Membuka browser...",
    startedAt: new Date().toISOString(),
    finishedAt: null,
  });

  let browser: Browser | null = null;

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    // ── Inject semua patch sebelum halaman apapun dimuat ──────────────────
    await page.evaluateOnNewDocument(STEALTH_SCRIPT);
    await page.setUserAgent(USER_AGENT);
    await page.setExtraHTTPHeaders({
      "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "sec-ch-ua": '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
    });

    page.setDefaultNavigationTimeout(60_000);
    page.setDefaultTimeout(60_000);

    const captured: IDNSession["responses"] & { tokens?: any } = {
      cognitoIDN: null, initiateAuth: null, respondToAuth: null,
      sendChallenge: null, profileDetail: null,
    };

    page.on("response", async (res: any) => {
      const url = res.url();
      const method = res.request().method();
      if (method === "OPTIONS") return;
      try {
        if (url.includes("/api/v1/user/cognito") && method === "POST")
          captured.cognitoIDN = await res.json();
        if (url.includes("cognito-idp.ap-southeast-1.amazonaws.com") && method === "POST") {
          const target = res.request().headers()["x-amz-target"] ?? "";
          const json = await res.json();
          if (target.includes("InitiateAuth")) captured.initiateAuth = json;
          else if (target.includes("RespondToAuthChallenge")) captured.respondToAuth = json;
        }
        if (url.includes("/api/auth/send-challenge") && method === "POST")
          captured.sendChallenge = await res.json();
        if (url.includes("connect.idn.media") && method === "POST" && url.includes("token"))
          captured.tokens = await res.json();
        if (url.includes("/api/v2/profile/detail"))
          captured.profileDetail = await res.json();
      } catch {}
    });

    // ── Step 1: Buka halaman ───────────────────────────────────────────────
    await setJobStatus(email, { message: "Membuka halaman login IDN..." });
    console.log("[IDN] goto login...");
    await page.goto(LOGIN_URL, { waitUntil: "networkidle2", timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 2000));
    await debugPage(page, "after-goto");

    // ── Step 2: Isi email ──────────────────────────────────────────────────
    await page.waitForSelector('input[name="identity"]', { timeout: 20_000 });
    await page.click('input[name="identity"]');
    await new Promise((r) => setTimeout(r, 400 + Math.random() * 300));

    for (const char of email) {
      await page.keyboard.type(char, { delay: 60 + Math.random() * 80 });
    }

    await new Promise((r) => setTimeout(r, 700));
    console.log("[IDN] Email diisi, submit...");
    await page.click('button[type="submit"]');
    await new Promise((r) => setTimeout(r, 4000));
    await debugPage(page, "after-submit");

    // ── Step 3: Tunggu tombol Kirim OTP ───────────────────────────────────
    await setJobStatus(email, { message: "Menunggu tombol Kirim OTP..." });

    try {
      await page.waitForFunction(
        () => {
          const t = document.body?.innerText ?? "";
          return (
            t.includes("Kirim OTP") ||
            t.includes("Masukkan kode") ||
            t.includes("Enter code")
          );
        },
        { timeout: 30_000 },
      );
    } catch {
      await debugPage(page, "timeout-otp-button");
      throw new Error("Halaman OTP tidak muncul setelah 30 detik.");
    }

    await debugPage(page, "before-click-otp");
    const pageText: string = await page.evaluate(
      () => document.body?.innerText ?? ""
    );

    if (pageText.includes("Kirim OTP")) {
      const clicked: boolean = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const btn = btns.find(
          (b) => (b as HTMLButtonElement).innerText.trim() === "Kirim OTP"
        );
        if (btn) { (btn as HTMLButtonElement).click(); return true; }
        return false;
      });
      console.log("[IDN] Klik Kirim OTP:", clicked ? "✅" : "❌");
      await new Promise((r) => setTimeout(r, 3000));
    } else {
      console.log("[IDN] Sudah di halaman OTP langsung");
    }

    // ── Step 4: Tunggu form OTP ────────────────────────────────────────────
    await setJobStatus(email, { message: "Menunggu form input OTP..." });
    await page.waitForFunction(
      () => {
        const t = document.body?.innerText ?? "";
        return t.includes("Masukkan kode") || t.includes("Enter code");
      },
      { timeout: 20_000 },
    );
    await debugPage(page, "otp-form-ready");

    // ── Step 5: Tunggu OTP dari Redis ─────────────────────────────────────
    await setJobStatus(email, {
      status: "waiting_otp",
      message: "Menunggu OTP dari email (maks 2 menit)...",
    });
    const otp = await waitForOTP(email, 120_000, 2_000);
    if (!otp) throw new Error("Timeout: OTP tidak diterima dalam 2 menit");
    console.log(`[IDN] OTP: ${otp}`);

    // ── Step 6: Input OTP ──────────────────────────────────────────────────
    await setJobStatus(email, { status: "running", message: `Memasukkan OTP ${otp}...` });
    const otpInputs = await page.$$("input");
    const otpDigits = otp.split("");
    console.log(`[IDN] Input boxes: ${otpInputs.length}`);

    if (otpInputs.length >= 6 && otpInputs.length <= 8) {
      for (let i = 0; i < otpDigits.length; i++) {
        if (otpInputs[i]) {
          await otpInputs[i].click();
          await new Promise((r) => setTimeout(r, 100));
          await otpInputs[i].type(otpDigits[i], { delay: 80 });
        }
      }
    } else if (otpInputs[0]) {
      await otpInputs[0].click();
      await otpInputs[0].type(otp, { delay: 80 });
    }

    await new Promise((r) => setTimeout(r, 500));
    const verifyClicked: boolean = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const btn = btns.find(
        (b) =>
          (b as HTMLButtonElement).innerText.includes("Verifikasi") ||
          (b as HTMLButtonElement).innerText.includes("Verify")
      );
      if (btn) { (btn as HTMLButtonElement).click(); return true; }
      return false;
    });
    if (!verifyClicked) await page.keyboard.press("Enter");

    // ── Step 7: Simpan session ────────────────────────────────────────────
    await setJobStatus(email, { message: "Menunggu login selesai..." });
    await new Promise((r) => setTimeout(r, 6_000));
    await debugPage(page, "after-verify");

    const cookies = await page.cookies();
    const importantKeys = ["id_token", "access_token", "refresh_token", "client_id"];
    const cookieMap: Record<string, string> = {};
    cookies.forEach((c: any) => {
      if (importantKeys.includes(c.name)) cookieMap[c.name] = c.value;
    });
    console.log("[IDN] Cookies:", Object.keys(cookieMap));

    const existing = await getSession(email);
    const session: IDNSession = {
      email,
      uuid: captured.cognitoIDN?.data?.uuid ?? null,
      cookies: cookieMap,
      tokens: {
        id_token: cookieMap.id_token ?? captured.tokens?.id_token ?? null,
        access_token: cookieMap.access_token ?? captured.tokens?.access_token ?? null,
        refresh_token: cookieMap.refresh_token ?? captured.tokens?.refresh_token ?? null,
      },
      responses: {
        cognitoIDN: captured.cognitoIDN,
        initiateAuth: captured.initiateAuth,
        respondToAuth: captured.respondToAuth,
        sendChallenge: captured.sendChallenge,
        profileDetail: captured.profileDetail,
      },
      currentUrl: page.url(),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "active",
      refreshCount: (existing?.refreshCount ?? 0) + 1,
    };

    await saveSession(session);
    await setJobStatus(email, {
      status: "done",
      message: "Login berhasil, session disimpan",
      finishedAt: new Date().toISOString(),
    });

    console.log(`[IDN] ✅ Done`);
    return session;

  } catch (err: any) {
    console.error(`[IDN] ❌ ${err.message}`);
    await setJobStatus(email, {
      status: "failed",
      message: `Gagal: ${err.message}`,
      finishedAt: new Date().toISOString(),
    });
    throw err;
  } finally {
    if (browser) {
      try { browser.disconnect(); } catch {}
    }
  }
}
