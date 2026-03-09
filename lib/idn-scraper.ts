import {
  IDNSession,
  saveSession,
  waitForOTP,
  setJobStatus,
  getSession,
} from "./redis";

const IDN_API = "https://api.idn.app";
const COGNITO_ENDPOINT = "https://cognito-idp.ap-southeast-1.amazonaws.com/";
const COGNITO_CLIENT_ID = "6gnaj30oomhtl0t3qtkfp2uir9";

const COMMON_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "Accept": "application/json",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Origin": "https://connect.idn.media",
  "Referer": "https://connect.idn.media/",
};

// ── Step 1: InitiateAuth → dapat Session + USERNAME (UUID) ───────────────────
async function initiateAuth(email: string) {
  console.log("[IDN-API] Step 1: InitiateAuth...");
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
      AuthParameters: { USERNAME: email },
      ClientMetadata: {},
    }),
  });
  const data = await res.json() as any;
  console.log("[IDN-API] InitiateAuth:", JSON.stringify(data).slice(0, 300));
  if (!data.Session) throw new Error(`InitiateAuth gagal: ${JSON.stringify(data)}`);
  return {
    session: data.Session,
    cognitoUsername: data.ChallengeParameters?.USERNAME ?? email, // UUID dari Cognito
  };
}

// ── Step 2: Hit IDN send-challenge → trigger kirim OTP ke email ──────────────
async function sendChallenge(email: string, cognitoUsername: string, cognitoSession: string) {
  console.log("[IDN-API] Step 2: send-challenge (trigger OTP ke email)...");
  const res = await fetch(`${IDN_API}/api/auth/send-challenge`, {
    method: "POST",
    headers: COMMON_HEADERS,
    body: JSON.stringify({
      email,
      username: cognitoUsername,
      session: cognitoSession,
      type: "email_otp", // atau "otp" tergantung API IDN
    }),
  });
  const text = await res.text();
  console.log("[IDN-API] send-challenge response:", text.slice(0, 300));
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// ── Step 3: RespondToAuthChallenge dengan OTP ─────────────────────────────────
async function respondToChallenge(email: string, otp: string, cognitoUsername: string, cognitoSession: string) {
  console.log("[IDN-API] Step 3: RespondToAuthChallenge...");
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
        USERNAME: cognitoUsername,
        ANSWER: otp,
      },
      Session: cognitoSession,
      ClientMetadata: {},
    }),
  });
  const data = await res.json() as any;
  console.log("[IDN-API] RespondToAuth:", JSON.stringify(data).slice(0, 300));
  if (!data.AuthenticationResult) throw new Error(`OTP salah atau expired: ${JSON.stringify(data)}`);
  return {
    idToken: data.AuthenticationResult.IdToken,
    accessToken: data.AuthenticationResult.AccessToken,
    refreshToken: data.AuthenticationResult.RefreshToken,
  };
}

// ── Step 4: Exchange ke IDN token ─────────────────────────────────────────────
async function exchangeToken(idToken: string) {
  console.log("[IDN-API] Step 4: Exchange token...");
  const res = await fetch(`${IDN_API}/api/v1/user/cognito`, {
    method: "POST",
    headers: { ...COMMON_HEADERS, "Authorization": `Bearer ${idToken}` },
    body: JSON.stringify({ id_token: idToken }),
  });
  const data = await res.json() as any;
  console.log("[IDN-API] cognito exchange:", JSON.stringify(data).slice(0, 200));
  return data;
}

// ── Step 5: Get profile ────────────────────────────────────────────────────────
async function getProfile(accessToken: string) {
  console.log("[IDN-API] Step 5: Get profile...");
  const res = await fetch(`${IDN_API}/api/v2/profile/detail`, {
    method: "GET",
    headers: { ...COMMON_HEADERS, "Authorization": `Bearer ${accessToken}` },
  });
  const data = await res.json() as any;
  console.log("[IDN-API] profile:", JSON.stringify(data).slice(0, 200));
  return data;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export async function runIDNLogin(email: string): Promise<IDNSession> {
  await setJobStatus(email, {
    status: "running",
    message: "Memulai login via API...",
    startedAt: new Date().toISOString(),
    finishedAt: null,
  });

  try {
    // 1. InitiateAuth
    await setJobStatus(email, { message: "Menginisiasi auth Cognito..." });
    const { session: cognitoSession, cognitoUsername } = await initiateAuth(email);

    // 2. Trigger kirim OTP ke email via IDN send-challenge
    await setJobStatus(email, { message: "Mengirim OTP ke email..." });
    const challengeResult = await sendChallenge(email, cognitoUsername, cognitoSession);
    console.log("[IDN] send-challenge result:", JSON.stringify(challengeResult).slice(0, 200));

    // Ambil session baru dari response send-challenge jika ada
    const activeSession = challengeResult?.session ?? challengeResult?.data?.session ?? cognitoSession;

    // 3. Tunggu OTP dari Redis
    await setJobStatus(email, {
      status: "waiting_otp",
      message: "OTP dikirim ke email. Menunggu input OTP (maks 2 menit)...",
    });
    const otp = await waitForOTP(email, 120_000, 2_000);
    if (!otp) throw new Error("Timeout: OTP tidak diterima dalam 2 menit");
    console.log(`[IDN] OTP diterima: ${otp}`);

    // 4. Submit OTP
    await setJobStatus(email, { status: "running", message: `Verifikasi OTP...` });
    const tokens = await respondToChallenge(email, otp, cognitoUsername, activeSession);
    console.log("[IDN] ✅ Tokens didapat");

    // 5. Exchange token
    await setJobStatus(email, { message: "Menukar token ke IDN..." });
    const cognitoIDN = await exchangeToken(tokens.idToken);

    // 6. Get profile
    const profileDetail = await getProfile(tokens.accessToken);

    // 7. Simpan session
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
        sendChallenge: challengeResult,
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
