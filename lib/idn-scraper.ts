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

async function launchBrowser(): Promise<Browser> {
  const wsEndpoint = process.env.BROWSER_WS_ENDPOINT;
  if (!wsEndpoint) throw new Error("BROWSER_WS_ENDPOINT tidak diset.");

  console.log("[Browser] Connecting to:", wsEndpoint.slice(0, 50) + "...");
  const browser = await puppeteer.connect({
    browserWSEndpoint: wsEndpoint,
    defaultViewport: { width: 1280, height: 800 },
  });
  console.log("[Browser] ✅ Connected");
  return browser;
}

// Helper: log isi halaman saat ini untuk debug
async function debugPage(page: any, label: string) {
  try {
    const url = page.url();
    const text = await page.evaluate(() => document.body?.innerText?.slice(0, 300) ?? "");
    console.log(`[DEBUG:${label}] URL: ${url}`);
    console.log(`[DEBUG:${label}] Body: ${text}`);
  } catch (e: any) {
    console.log(`[DEBUG:${label}] gagal baca page: ${e.message}`);
  }
}

// Helper: klik tombol berdasarkan teks
async function clickButton(page: any, texts: string[]): Promise<boolean> {
  const buttons = await page.$$("button");
  for (const btn of buttons) {
    const text: string = await btn.evaluate((el: HTMLElement) => el.innerText.trim());
    if (texts.some((t) => text.toLowerCase().includes(t.toLowerCase()))) {
      console.log(`[IDN] Klik tombol: "${text}"`);
      await btn.click();
      return true;
    }
  }
  // Coba juga via xpath
  for (const t of texts) {
    try {
      const [el] = await page.$x(`//button[contains(text(), "${t}")]`);
      if (el) {
        console.log(`[IDN] Klik tombol (xpath): "${t}"`);
        await el.click();
        return true;
      }
    } catch {}
  }
  return false;
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
    await setJobStatus(email, { message: "Browser terhubung..." });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
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

    // ── Step 1: Buka halaman & isi email ──────────────────────────────────
    await setJobStatus(email, { message: "Membuka halaman login IDN..." });
    console.log("[IDN] goto login...");
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 2000)); // tunggu JS render
    await debugPage(page, "after-goto");

    // Tunggu input email muncul
    await page.waitForSelector('input[name="identity"]', { timeout: 20_000 });
    await page.type('input[name="identity"]', email, { delay: 80 });
    console.log("[IDN] Email diisi, klik submit...");

    // Klik submit — coba berbagai selector
    const submitted = await page.evaluate(() => {
      const btn = document.querySelector('button[type="submit"]') as HTMLButtonElement;
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!submitted) await page.keyboard.press("Enter");

    await new Promise((r) => setTimeout(r, 3000));
    await debugPage(page, "after-submit");

    // ── Step 2: Klik Kirim OTP ────────────────────────────────────────────
    await setJobStatus(email, { message: "Mencari tombol Kirim OTP..." });

    // Tunggu salah satu kondisi: tombol OTP atau langsung halaman OTP
    try {
      await page.waitForFunction(
        () => {
          const text = document.body?.innerText ?? "";
          return text.includes("Kirim OTP") || text.includes("Masukkan kode") || text.includes("Enter code");
        },
        { timeout: 30_000 },
      );
    } catch {
      await debugPage(page, "timeout-wait-otp-button");
      throw new Error("Halaman tidak menampilkan tombol OTP. Cek log DEBUG untuk detail.");
    }

    await debugPage(page, "before-click-otp");

    // Klik Kirim OTP jika ada (skip jika sudah di halaman OTP)
    const bodyText: string = await page.evaluate(() => document.body?.innerText ?? "");
    if (bodyText.includes("Kirim OTP")) {
      const clicked = await clickButton(page, ["Kirim OTP", "Send OTP", "Kirim"]);
      if (!clicked) console.log("[IDN] ⚠️ Tombol Kirim OTP tidak ditemukan, lanjut...");
      await new Promise((r) => setTimeout(r, 2000));
    } else {
      console.log("[IDN] Sudah di halaman OTP, skip klik Kirim OTP");
    }

    // ── Step 3: Tunggu form input OTP ────────────────────────────────────
    await setJobStatus(email, { message: "Menunggu form input OTP..." });
    try {
      await page.waitForFunction(
        () => {
          const text = document.body?.innerText ?? "";
          return text.includes("Masukkan kode") || text.includes("Enter code") || text.includes("OTP");
        },
        { timeout: 20_000 },
      );
    } catch {
      await debugPage(page, "timeout-otp-form");
      throw new Error("Form input OTP tidak muncul.");
    }
    await debugPage(page, "otp-form-ready");

    // ── Step 4: Tunggu OTP dari Redis ─────────────────────────────────────
    await setJobStatus(email, {
      status: "waiting_otp",
      message: "Menunggu OTP dari email (maks 2 menit)...",
    });
    const otp = await waitForOTP(email, 120_000, 2_000);
    if (!otp) throw new Error("Timeout: OTP tidak diterima dalam 2 menit");
    console.log(`[IDN] OTP diterima: ${otp}`);

    // ── Step 5: Input OTP ─────────────────────────────────────────────────
    await setJobStatus(email, { status: "running", message: `Memasukkan OTP ${otp}...` });
    const otpInputs = await page.$$("input");
    const otpDigits = otp.split("");
    console.log(`[IDN] Jumlah input box: ${otpInputs.length}, panjang OTP: ${otpDigits.length}`);

    if (otpInputs.length >= otpDigits.length && otpInputs.length <= 8) {
      // Input per kotak (6 kotak terpisah)
      for (let i = 0; i < otpDigits.length; i++) {
        if (otpInputs[i]) {
          await otpInputs[i].click();
          await otpInputs[i].type(otpDigits[i], { delay: 80 });
        }
      }
    } else {
      // Satu input field
      const input = otpInputs.find(async (inp: any) => {
        const type = await inp.evaluate((el: HTMLInputElement) => el.type);
        return type === "text" || type === "number" || type === "tel";
      }) ?? otpInputs[0];
      if (input) {
        await input.click();
        await input.type(otp, { delay: 80 });
      }
    }

    await new Promise((r) => setTimeout(r, 500));

    // Klik verifikasi
    const verified = await clickButton(page, ["Verifikasi", "Verify", "Submit", "Konfirmasi"]);
    if (!verified) {
      console.log("[IDN] Tombol verifikasi tidak ditemukan, coba Enter...");
      await page.keyboard.press("Enter");
    }

    // ── Step 6: Tunggu login selesai ──────────────────────────────────────
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

    // ── Step 7: Simpan session ────────────────────────────────────────────
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
