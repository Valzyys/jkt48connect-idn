import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { setOTP } from "./redis";

// ─── Config ───────────────────────────────────────────────────────────────────
interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

// ─── Extract OTP dari body email ─────────────────────────────────────────────
function extractOTP(text: string): string | null {
  // Cocokkan 6 digit angka yang berdiri sendiri (format IDN: "1 8 8 3 9 3" atau "188393")
  const patterns = [
    /\b(\d{6})\b/,                          // 6 digit langsung: 188393
    /(\d)\s(\d)\s(\d)\s(\d)\s(\d)\s(\d)/,  // spasi: 1 8 8 3 9 3
    /kode[^\d]*(\d{6})/i,                   // "kode verifikasi ... 188393"
    /(\d{6})[^\d]*berlaku/i,                // "188393 ... berlaku"
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      // Jika capture group pakai spasi, gabungkan
      if (match.length === 7) {
        return match.slice(1).join("");
      }
      return match[1];
    }
  }
  return null;
}

// ─── Deteksi apakah email dari IDN ───────────────────────────────────────────
function isIDNEmail(from: string, subject: string): boolean {
  const fromLower = from.toLowerCase();
  const subjectLower = subject.toLowerCase();
  return (
    fromLower.includes("idn") ||
    fromLower.includes("noreply") ||
    subjectLower.includes("kode verifikasi") ||
    subjectLower.includes("otp") ||
    subjectLower.includes("verification") ||
    subjectLower.includes("verifikasi")
  );
}

// ─── Main IMAP Listener ───────────────────────────────────────────────────────
export class IMAPOTPListener {
  private client: ImapFlow;
  private config: ImapConfig;
  private isRunning = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(config: ImapConfig) {
    this.config = config;
    this.client = this.createClient();
  }

  private createClient(): ImapFlow {
    return new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: {
        user: this.config.user,
        pass: this.config.pass,
      },
      logger: false,
    });
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    await this.connect();
  }

  private async connect() {
    try {
      console.log(`[IMAP] Connecting as ${this.config.user}...`);
      this.client = this.createClient();

      await this.client.connect();
      console.log("[IMAP] ✅ Connected");

      await this.client.mailboxOpen("INBOX");

      // Listener email baru masuk
      this.client.on("exists", async (data: any) => {
        console.log(`[IMAP] 📬 Email baru masuk (total: ${data.count})`);
        await this.fetchLatestEmail(data.count);
      });

      // Reconnect saat koneksi putus
      this.client.on("close", () => {
        console.log("[IMAP] ⚠️ Koneksi terputus, reconnect dalam 10s...");
        this.isRunning = false;
        this.reconnectTimer = setTimeout(() => this.connect(), 10_000);
      });

      this.client.on("error", (err: Error) => {
        console.error("[IMAP] Error:", err.message);
      });

    } catch (err: any) {
      console.error("[IMAP] Gagal connect:", err.message);
      this.isRunning = false;
      // Retry setelah 30s
      this.reconnectTimer = setTimeout(() => this.connect(), 30_000);
    }
  }

  private async fetchLatestEmail(seqNum: number) {
    try {
      const message = await this.client.fetchOne(`${seqNum}`, {
        envelope: true,
        source: true,
      });

      if (!message) return;

      const from = message.envelope?.from?.[0]?.address ?? "";
      const subject = message.envelope?.subject ?? "";
      const to = message.envelope?.to?.[0]?.address ?? "";

      console.log(`[IMAP] From: ${from} | Subject: ${subject} | To: ${to}`);

      // Cek apakah ini email OTP dari IDN
      if (!isIDNEmail(from, subject)) {
        console.log("[IMAP] Bukan email IDN, skip.");
        return;
      }

      // Parse body email
      const parsed = await simpleParser(message.source);
      const bodyText = parsed.text ?? parsed.html ?? "";

      console.log("[IMAP] 🔍 Body email (preview):", bodyText.slice(0, 200));

      const otp = extractOTP(bodyText);
      if (!otp) {
        console.log("[IMAP] ❌ OTP tidak ditemukan di body email");
        return;
      }

      console.log(`[IMAP] ✅ OTP ditemukan: ${otp} untuk email: ${to}`);

      // Simpan OTP ke Redis dengan TTL 5 menit
      await setOTP(to, otp, 300);
      console.log(`[IMAP] 💾 OTP ${otp} disimpan ke Redis untuk ${to}`);

    } catch (err: any) {
      console.error("[IMAP] Gagal fetch email:", err.message);
    }
  }

  async stop() {
    this.isRunning = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      await this.client.logout();
    } catch {}
    console.log("[IMAP] Listener dihentikan");
  }
}

// ─── Factory: buat listener dari env ─────────────────────────────────────────
export function createIMAPListener(): IMAPOTPListener {
  return new IMAPOTPListener({
    host: process.env.IMAP_HOST ?? "imap.gmail.com",
    port: parseInt(process.env.IMAP_PORT ?? "993"),
    secure: (process.env.IMAP_SECURE ?? "true") === "true",
    user: process.env.IMAP_USER!,
    pass: process.env.IMAP_PASS!,
  });
}
