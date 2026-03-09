import {
  IDNSession,
  saveSession,
  waitForOTP,
  setJobStatus,
  getSession,
} from "./redis";

const BASE = "https://connect.idn.media";
const IDN_API = "https://api.idn.app";

// ─── Cognito config IDN (dari capture network) ───────────────────────────────
const COGNITO_ENDPOINT = "https://cognito-idp.ap-southeast-1.amazonaws.com/";
const COGNITO_CLIENT_ID = "6gnaj30oomhtl0t3qtkfp2uir9"; // sama dengan client_id di URL

const COMMON_HEADERS = {
  "Content-Type": "application/json",
  "Accept": "application/json",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Origin": "https://connect.idn.media",
  "Referer": "https://connect.idn.media/",
};

// ── Step 1: Kirim email ke IDN untuk trigger OTP ──────────────────────────────
async function requestOTP(email: string): Promise<{ session: string; challengeName: string }> {
  console.log("[IDN-API] Step 1: InitiateAuth (request OTP)...");

  const res = await fetch(COGNITO_ENDPOINT, {
    method: "POST",
    headers: {
      ...COMMON_HEADERS,
      "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
      "Content-Type": "application/x-amz-json-1.1",
    },
    body: JSON.stringify({
      AuthFlow: "CUSTOM_AUTH",
      ClientId: COGNITO_CLIENT_ID,
      AuthParameters: {
        USERNAME: email,
      },
      ClientMetadata: {},
    }),
  });

  const data = await res.json() as any;
  console.log("[IDN-API] InitiateAuth response:", JSON.stringify(data).slice(0, 200));

  if (!data.Session) {
    throw new Error(`InitiateAuth gagal: ${JSON.stringify(data)}`);
  }

  return {
    session: data.Session,
    challengeName: data.ChallengeName,
  };
}

// ── Step 2: Submit OTP ke Cognito ─────────────────────────────────────────────
async function submitOTP(
  email: string,
  otp: string,
  session: string
): Promise<{ idToken: string; accessToken: string; refreshToken: string }> {
  console.log("[IDN-API] Step 2: RespondToAuthChallenge (submit OTP)...");

  const res = await fetch(COGNITO_ENDPOINT, {
    method: "POST",
    headers: {
      ...COMMON_HEADERS,
      "X-Amz-Target": "AWSCognitoIdentityProviderService.RespondToAuthChallenge",
      "Content-Type": "application/x-amz-json-1.1",
    },
    body: JSON.stringify({
      ChallengeName: "CUSTOM_CHALLENGE",
      ClientId: COGNITO_CLIENT_ID,
      ChallengeResponses: {
        USERNAME: email,
        ANSWER: otp,
      },
      Session: session,
      ClientMetadata: {},
    }),
  });

  const data = await res.json() as any;
  console.log("[IDN-API] RespondToAuth response:", JSON.stringify(data).slice(0, 200));

  if (!data.AuthenticationResult) {
    throw new Error(`Submit OTP gagal: ${JSON.stringify(data)}`);
  }

  return {
    idToken: data.AuthenticationResult.IdToken,
    accessToken: data.AuthenticationResult.AccessToken,
    refreshToken: data.AuthenticationResult.RefreshToken,
  };
}

// ── Step 3: Tukar token Cognito → token IDN ───────────────────────────────────
async function exchangeToken(idToken: string): Promise<any> {
  console.log("[IDN-API] Step 3: Exchange Cognito token ke IDN...");

  const res = await fetch(`${IDN_API}/api/v1/user/cognito`, {
    method: "POST",
    headers: {
      ...COMMON_HEADERS,
      "Authorization": `Bearer ${idToken}`,
    },
    body: JSON.stringify({ id_token: idToken }),
  });

  const data = await res.json() as any;
  console.log("[IDN-API] cognito response:", JSON.stringify(data).slice(0, 200));
  return data;
}

// ── Step 4: Ambil profile detail ──────────────────────────────────────────────
async function getProfile(accessToken: string): Promise<any> {
  console.log("[IDN-API] Step 4: Get profile...");

  const res = await fetch(`${IDN_API}/api/v2/profile/detail`, {
    method: "GET",
    headers: {
      ...COMMON_HEADERS,
      "Authorization": `Bearer ${accessToken}`,
    },
  });

  const data = await res.json() as any;
  console.log("[IDN-API] profile:", JSON.stringify(data).slice(0, 200));
  return data;
}

// ─── Main login flow ──────────────────────────────────────────────────────────
export async function runIDNLogin(email: string): Promise<IDNSession> {
  await setJobStatus(email, {
    status: "running",
    message: "Memulai login via API...",
    startedAt: new Date().toISOString(),
    finishedAt: null,
  });

  try {
    // Step 1: Request OTP
    await setJobStatus(email, { message: "Mengirim OTP ke email..." });
    const { session: cognitoSession } = await requestOTP(email);
    console.log("[IDN] OTP terkirim, menunggu input...");

    // Step 2: Tunggu OTP dari Redis (diisi manual atau IMAP listener)
    await setJobStatus(email, {
      status: "waiting_otp",
      message: "Menunggu OTP dari email (maks 2 menit)...",
    });
    const otp = await waitForOTP(email, 120_000, 2_000);
    if (!otp) throw new Error("Timeout: OTP tidak diterima dalam 2 menit");
    console.log(`[IDN] OTP diterima: ${otp}`);

    // Step 3: Submit OTP
    await setJobStatus(email, { status: "running", message: `Verifikasi OTP ${otp}...` });
    const tokens = await submitOTP(email, otp, cognitoSession);
    console.log("[IDN] ✅ Token Cognito didapat");

    // Step 4: Exchange ke IDN token
    await setJobStatus(email, { message: "Menukar token ke IDN..." });
    const cognitoIDN = await exchangeToken(tokens.idToken);

    // Step 5: Get profile
    const profileDetail = await getProfile(tokens.accessToken);

    // Step 6: Simpan session
    const existing = await getSession(email);
    const session: IDNSession = {
      email,
      uuid: cognitoIDN?.data?.uuid ?? null,
      cookies: {
        id_token: tokens.idToken,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
      },
      tokens: {
        id_token: tokens.idToken,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
      },
      responses: {
        cognitoIDN,
        initiateAuth: null,
        respondToAuth: null,
        sendChallenge: null,
        profileDetail,
      },
      currentUrl: `${IDN_API}/api/v2/profile/detail`,
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
    console.error(`[IDN] ❌ ${err.message}`);
    await setJobStatus(email, {
      status: "failed",
      message: `Gagal: ${err.message}`,
      finishedAt: new Date().toISOString(),
    });
    throw err;
  }
}
