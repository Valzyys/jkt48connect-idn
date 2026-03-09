import puppeteer, { Browser, Page } from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import {
  IDNSession,
  saveSession,
  waitForOTP,
  setJobStatus,
  getSession,
} from "./redis";

// ─── Config ───────────────────────────────────────────────────────────────────
const LOGIN_URL =
  "https://connect.idn.media/?client_id=6gnaj30oomhtl0t3qtkfp2uir9&redirect_uri=https://www.idn.app/&authorization_code=ef04562d-89e7-4322-b8ef-86dc4bf49814&state=dU5LvM8nvbI0REKm86t3hPjyXghAWS4m";

// ─── Launch browser ───────────────────────────────────────────────────────────
async function launchBrowser(): Promise<Browser> {
  const isVercel = !!process.env.VERCEL;

  if (isVercel) {
    return puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
  }

  // Local development — pakai chrome yang terinstall
  return puppeteer.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      "/usr/bin/google-chrome" ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
  });
}

// ─── Main scraper ─────────────────────────────────────────────────────────────
export async function runIDNLogin(email: string): Promise<IDNSession> {
  await setJobStatus(email, {
    status: "running",
    message: "Membuka browser...",
    startedAt: new Date().toISOString(),
    finishedAt: null,
  });

  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  // ─── Capture responses ────────────────────────────────────────────────────
  const captured: IDNSession["responses"] & { tokens?: any } = {
    cognitoIDN: null,
    initiateAuth: null,
    respondToAuth: null,
    sendChallenge: null,
    profileDetail: null,
  };

  page.on("response", async (res) => {
    const url = res.url();
    const method = res.request().method();
    if (method === "OPTIONS") return;
    try {
      if (url.includes("/api/v1/user/cognito") && method === "POST") {
        captured.cognitoIDN = await res.json();
      }
      if (url.includes("cognito-idp.ap-southeast-1.amazonaws.com") && method === "POST") {
        const target = res.request().headers()["x-amz-target"] ?? "";
        const json = await res.json();
        if (target.includes("InitiateAuth")) captured.initiateAuth = json;
        else if (target.includes("RespondToAuthChallenge")) captured.respondToAuth = json;
      }
      if (url.includes("/api/auth/send-challenge") && method === "POST") {
        captured.sendChallenge = await res.json();
      }
      if (url.includes("connect.idn.media") && method === "POST" && url.includes("token")) {
        captured.tokens = await res.json();
      }
      if (url.includes("/api/v2/profile/detail")) {
        captured.profileDetail = await res.json();
      }
    } catch {}
  });

  try {
    // ── Step 1: Buka halaman login ─────────────────────────────────────────
    await setJobStatus(email, { message: "Membuka halaman login IDN..." });
    console.log(`[IDN] [${email}] Step 1: goto login`);
    await page.goto(LOGIN_URL, { waitUntil: "networkidle2", timeout: 30_000 });

    await page.waitForSelector('input[name="identity"]', { timeout: 15_000 });
    await page.type('input[name="identity"]', email, { delay: 80 });
    await page.click('button[type="submit"]');
    console.log(`[IDN] [${email}] Email diisi`);

    // ── Step 2: Klik Kirim OTP ────────────────────────────────────────────
    await setJobStatus(email, { message: "Menunggu halaman pilihan login..." });
    await page.waitForFunction(
      () => document.body.innerText.includes("Kirim OTP"),
      { timeout: 20_000 },
    );
    const buttons = await page.$$("button");
    for (const btn of buttons) {
      const text = await btn.evaluate((el: Element) => (el as HTMLElement).innerText.trim());
      if (text === "Kirim OTP") {
        await btn.click();
        break;
      }
    }
    console.log(`[IDN] [${email}] Klik Kirim OTP`);

    // ── Step 3: Tunggu halaman OTP ────────────────────────────────────────
    await setJobStatus(email, { message: "Menunggu halaman input OTP..." });
    await page.waitForFunction(
      () => document.body.innerText.includes("Masukkan kode"),
      { timeout: 20_000 },
    );
    console.log(`[IDN] [${email}] Halaman OTP muncul, menunggu OTP dari email...`);

    // ── Step 4: Tunggu OTP dari IMAP listener via Redis ───────────────────
    await setJobStatus(email, {
      status: "waiting_otp",
      message: "Menunggu OTP dari email (maks 2 menit)...",
    });

    const otp = await waitForOTP(email, 120_000, 2_000);
    if (!otp) {
      throw new Error("Timeout: OTP tidak diterima dalam 2 menit");
    }
    console.log(`[IDN] [${email}] OTP diterima: ${otp}`);

    // ── Step 5: Input OTP ─────────────────────────────────────────────────
    await setJobStatus(email, { status: "running", message: `Memasukkan OTP ${otp}...` });
    const otpInputs = await page.$$("input");
    const otpDigits = otp.split("");

    if (otpInputs.length >= otpDigits.length) {
      for (let i = 0; i < otpDigits.length; i++) {
        if (otpInputs[i]) {
          await otpInputs[i].click();
          await otpInputs[i].type(otpDigits[i], { delay: 50 });
        }
      }
    } else if (otpInputs.length > 0) {
      await otpInputs[0].click();
      await otpInputs[0].type(otp, { delay: 50 });
    }

    // Klik verifikasi
    await new Promise((r) => setTimeout(r, 500));
    const allButtons = await page.$$("button");
    for (const btn of allButtons) {
      const text = await btn.evaluate((el: Element) => (el as HTMLElement).innerText.trim());
      if (text === "Verifikasi" || text.toLowerCase().includes("verif")) {
        await btn.click();
        console.log(`[IDN] [${email}] Klik Verifikasi`);
        break;
      }
    }

    // ── Step 6: Tunggu login selesai ──────────────────────────────────────
    await setJobStatus(email, { message: "Menunggu login selesai..." });
    await new Promise((r) => setTimeout(r, 5_000));

    // Ambil cookies
    const cookies = await page.cookies();
    const importantKeys = ["id_token", "access_token", "refresh_token", "client_id"];
    const cookieMap: Record<string, string> = {};
    cookies.forEach((c) => {
      if (importantKeys.includes(c.name)) cookieMap[c.name] = c.value;
    });

    // ── Step 7: Build & simpan session ───────────────────────────────────
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

    console.log(`[IDN] [${email}] ✅ Session saved`);
    return session;

  } catch (err: any) {
    console.error(`[IDN] [${email}] ❌ Error:`, err.message);
    await setJobStatus(email, {
      status: "failed",
      message: `Gagal: ${err.message}`,
      finishedAt: new Date().toISOString(),
    });
    throw err;
  } finally {
    await browser.close();
  }
}
