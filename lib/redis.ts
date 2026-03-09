/**
 * lib/redis.ts
 * Vercel KV (Upstash) via REST API — sama persis pola storage.js
 */

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

// ─── Core KV fetch ────────────────────────────────────────────────────────────
async function kv(command: string, ...args: (string | number)[]): Promise<any> {
  if (!KV_URL || !KV_TOKEN) {
    throw new Error("KV_REST_API_URL atau KV_REST_API_TOKEN tidak ditemukan.");
  }
  const path = [command, ...args].map(encodeURIComponent).join("/");
  const res = await fetch(`${KV_URL}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`KV HTTP ${res.status}: ${text}`);
  }
  const json = await res.json();
  if (json.error) throw new Error(`KV error: ${json.error}`);
  return json.result;
}

// ─── Types ────────────────────────────────────────────────────────────────────
export interface IDNSession {
  email: string;
  uuid: string | null;
  cookies: Record<string, string>;
  tokens: {
    id_token: string | null;
    access_token: string | null;
    refresh_token: string | null;
  };
  responses: {
    cognitoIDN: any;
    initiateAuth: any;
    respondToAuth: any;
    sendChallenge: any;
    profileDetail: any;
  };
  currentUrl: string;
  createdAt: string;
  updatedAt: string;
  status: "active" | "expired" | "refreshing" | "failed";
  refreshCount: number;
}

export interface JobStatus {
  email: string;
  status: "idle" | "running" | "waiting_otp" | "done" | "failed";
  message: string;
  startedAt: string | null;
  finishedAt: string | null;
}

// ─── Key schema ───────────────────────────────────────────────────────────────
const KEYS = {
  session:   (email: string) => `idn:session:${email}`,
  allEmails: ()               => `idn:emails`,
  otp:       (email: string) => `idn:otp:${email}`,
  otpReady:  (email: string) => `idn:otp:ready:${email}`,
  jobStatus: (email: string) => `idn:job:${email}`,
};

// ─── Session ──────────────────────────────────────────────────────────────────
export async function saveSession(session: IDNSession): Promise<void> {
  await kv("SET", KEYS.session(session.email), JSON.stringify(session));
  await kv("SADD", KEYS.allEmails(), session.email);
}

export async function getSession(email: string): Promise<IDNSession | null> {
  const raw: string | null = await kv("GET", KEYS.session(email));
  if (!raw) return null;
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw as IDNSession;
  } catch {
    return null;
  }
}

export async function getAllSessions(): Promise<IDNSession[]> {
  const emails: string[] = await kv("SMEMBERS", KEYS.allEmails());
  if (!Array.isArray(emails) || emails.length === 0) return [];
  const sessions: IDNSession[] = [];
  for (const email of emails) {
    const s = await getSession(email);
    if (s) sessions.push(s);
  }
  return sessions;
}

export async function deleteSession(email: string): Promise<void> {
  await kv("DEL", KEYS.session(email));
  await kv("SREM", KEYS.allEmails(), email);
}

export async function updateSessionStatus(
  email: string,
  status: IDNSession["status"],
): Promise<void> {
  const session = await getSession(email);
  if (!session) return;
  session.status = status;
  session.updatedAt = new Date().toISOString();
  await saveSession(session);
}

// ─── OTP ──────────────────────────────────────────────────────────────────────
export async function setOTP(
  email: string,
  otp: string,
  ttlSeconds = 300,
): Promise<void> {
  await kv("SET", KEYS.otp(email), otp, "EX", ttlSeconds);
  await kv("SET", KEYS.otpReady(email), "1", "EX", ttlSeconds);
}

export async function getOTP(email: string): Promise<string | null> {
  return await kv("GET", KEYS.otp(email));
}

export async function clearOTP(email: string): Promise<void> {
  await kv("DEL", KEYS.otp(email));
  await kv("DEL", KEYS.otpReady(email));
}

/**
 * Poll Redis setiap intervalMs sampai OTP siap atau timeout.
 * Dipakai scraper untuk menunggu IMAP listener menyimpan OTP.
 */
export async function waitForOTP(
  email: string,
  timeoutMs = 120_000,
  intervalMs = 2_000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready: string | null = await kv("GET", KEYS.otpReady(email));
    if (ready === "1") {
      const otp: string | null = await kv("GET", KEYS.otp(email));
      await clearOTP(email);
      return otp;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

// ─── Job Status ───────────────────────────────────────────────────────────────
function defaultJob(email: string): JobStatus {
  return { email, status: "idle", message: "", startedAt: null, finishedAt: null };
}

export async function setJobStatus(
  email: string,
  update: Partial<JobStatus>,
): Promise<void> {
  const raw: string | null = await kv("GET", KEYS.jobStatus(email));
  let prev: JobStatus = defaultJob(email);
  if (raw) {
    try { prev = typeof raw === "string" ? JSON.parse(raw) : raw; } catch {}
  }
  const updated: JobStatus = { ...prev, ...update };
  await kv("SET", KEYS.jobStatus(email), JSON.stringify(updated), "EX", 3600);
}

export async function getJobStatus(email: string): Promise<JobStatus | null> {
  const raw: string | null = await kv("GET", KEYS.jobStatus(email));
  if (!raw) return null;
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw as JobStatus;
  } catch {
    return null;
  }
}
