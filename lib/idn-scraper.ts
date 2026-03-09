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

// User agent Chrome asli agar tidak terdeteksi bot
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

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
    const text: string = await page.evaluate(() => document.body?.innerText?.slice(0, 400) ?? "");
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

    // ── Anti-bot bypass ────────────────────────────────────────────────────
    await page.setUserAgent(USER_AGENT);
    await page.setExtraHTTPHeaders({
      "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    });

    // Sembunyikan tanda-tanda headless browser
    await page.evaluateOnNewDocument(() => {
      // Override webdriver flag
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      // Override plugins (browser asli punya plugins)
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
      // Override languages
      Object.defineProperty(navigator, "languages", { get: () => ["id-ID", "id", "en-US"] });
      // Override chrome object
      (window as any).chrome = { runtime: {} };
      // Hapus ciri-ciri automation
      delete (window as any).__webdriver_evaluate;
      delete (window as any).__selenium_evaluate;
      delete (window as any).__webdriver_script_fn;
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

    // Buka Google dulu agar referrer terlihat natural
    await page.goto("https://www.google.com", { waitUntil: "domcontentloaded", timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 1000 + Math.random() * 1000));

    // Baru buka halaman IDN
    await page.goto(LOGIN_URL, { waitUntil: "networkidle2", timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 2000));
    await debugPage(page, "after-goto");

    // ── Step 2: Isi email ──────────────────────────────────────────────────
    await page.waitForSelector('input[name="identity"]', { timeout: 20_000 });

    // Klik dulu input, simulasi manusia
    await page.click('input[name="identity"]');
    await new Promise((r) => setTimeout(r, 500 + Math.random() * 500));

    // Ketik email pelan-pelan seperti manusia
    for (const char of email) {
      await page.keyboard.type(char, { delay: 80 + Math.random() * 80 });
    }

    await new Promise((r) => setTimeout(r, 800));
    console.log("[IDN] Email diisi, klik submit...");

    // Klik tombol Lanjutkan
    await page.click('button[type="submit"]');
    await new Promise((r) => setTimeout(r, 3000));
    await debugPage(page, "after-submit");

    // Cek apakah ada error recaptcha
    const bodyAfterSubmit: string = await page.evaluate(
      () => document.body?.innerText ?? ""
    );
    if (bodyAfterSubmit.includes("recaptcha") || bodyAfterSubmit.includes("Error validate")) {
      console.log("[IDN] ⚠️ Recaptcha error, coba klik submit sekali lagi...");
      await new Promise((r) => setTimeout(r, 2000));
      await page.click('button[type="submit"]');
      await new Promise((r) => setTimeout(r, 3000));
      await debugPage(page, "after-submit-retry");
    }

    // ── Step 3: Tunggu & klik "Kirim OTP" ─────────────────────────────────
    await setJobStatus(email, { message: "Menunggu tombol Kirim OTP..." });

    await page.waitForFunction(
      () => {
        const text = document.body?.innerText ?? "";
        return (
          text.includes("Kirim OTP") ||
          text.includes("Masukkan kode") ||
          text.includes("Enter code")
        );
      },
      { timeout: 30_000 },
    );

    await debugPage(page, "before-click-otp");

    const pageText: string = await page.evaluate(() => document.body?.innerText ?? "");

    if (pageText.includes("Kirim OTP")) {
      // Cari dan klik tombol "Kirim OTP"
      const clicked: boolean = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("button"));
        const btn = buttons.find((b) => b.innerText.trim() === "Kirim OTP");
        if (btn) { btn.click(); return true; }
        return false;
      });
      console.log("[IDN] Klik Kirim OTP:", clicked ? "✅" : "❌");
      await new Promise((r) => setTimeout(r, 3000));
    }

    // ── Step 4: Tunggu form OTP muncul ────────────────────────────────────
    await setJobStatus(email, { message: "Menunggu form input OTP..." });
    await page.waitForFunction(
      () => {
        const text = document.body?.innerText ?? "";
        return text.includes("Masukkan kode") || text.includes("Enter code");
      },
      { timeout: 20_000 },
    );
    await debugPage(page, "otp-form-ready");
    console.log("[IDN] Halaman OTP siap");

    // ── Step 5: Tunggu OTP dari Redis (IMAP listener) ─────────────────────
    await setJobStatus(email, {
      status: "waiting_otp",
      message: "Menunggu OTP dari email (maks 2 menit)...",
    });
    const otp = await waitForOTP(email, 120_000, 2_000);
    if (!otp) throw new Error("Timeout: OTP tidak diterima dalam 2 menit");
    console.log(`[IDN] OTP diterima: ${otp}`);

    // ── Step 6: Input OTP ─────────────────────────────────────────────────
    await setJobStatus(email, { status: "running", message: `Memasukkan OTP ${otp}...` });

    const otpInputs = await page.$$("input");
    const otpDigits = otp.split("");
    console.log(`[IDN] Input boxes: ${otpInputs.length}, OTP length: ${otpDigits.length}`);

    if (otpInputs.length >= 6 && otpInputs.length <= 8) {
      // 6 kotak terpisah
      for (let i = 0; i < otpDigits.length; i++) {
        if (otpInputs[i]) {
          await otpInputs[i].click();
          await new Promise((r) => setTimeout(r, 100));
          await otpInputs[i].type(otpDigits[i], { delay: 80 });
        }
      }
    } else {
      // Satu input field
      if (otpInputs[0]) {
        await otpInputs[0].click();
        await otpInputs[0].type(otp, { delay: 80 });
      }
    }

    await new Promise((r) => setTimeout(r, 500));

    // Klik Verifikasi
    const verifyClicked: boolean = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const btn = buttons.find(
        (b) => b.innerText.includes("Verifikasi") || b.innerText.includes("Verify")
      );
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!verifyClicked) {
      console.log("[IDN] Tombol Verifikasi tidak ditemukan, coba Enter...");
      await page.keyboard.press("Enter");
    }

    // ── Step 7: Tunggu login selesai & ambil cookies ──────────────────────
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

    // ── Step 8: Simpan session ────────────────────────────────────────────
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

    console.log(`[IDN] ✅ Done untuk ${email}`);
    return session;

  } catch (err: any) {
    console.error(`[IDN] ❌ Error: ${err.message}`);
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
