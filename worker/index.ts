/**
 * worker/index.ts
 *
 * Long-running IMAP listener.
 * Jalankan di server/VPS terpisah (bukan Vercel, karena Vercel serverless).
 * Fungsinya: dengarkan email masuk → ekstrak OTP → simpan ke KV Redis.
 *
 * Deploy: Railway, Render, VPS, atau PM2 di server sendiri.
 *
 * Env yang dibutuhkan:
 *   KV_REST_API_URL
 *   KV_REST_API_TOKEN
 *   IMAP_HOST   (default: imap.gmail.com)
 *   IMAP_PORT   (default: 993)
 *   IMAP_SECURE (default: true)
 *   IMAP_USER   → email Gmail yang dipakai login IDN
 *   IMAP_PASS   → App Password Gmail (bukan password biasa)
 */

import { createIMAPListener } from "../lib/imap-listener";

async function main() {
  console.log("╔════════════════════════════════════════╗");
  console.log("║  IDN OTP IMAP Listener — Worker Start  ║");
  console.log("╚════════════════════════════════════════╝");
  console.log(`[Worker] Email : ${process.env.IMAP_USER}`);
  console.log(`[Worker] Host  : ${process.env.IMAP_HOST ?? "imap.gmail.com"}`);
  console.log(`[Worker] KV    : ${process.env.KV_REST_API_URL ? "✅ Connected" : "❌ Missing"}`);

  if (!process.env.IMAP_USER || !process.env.IMAP_PASS) {
    console.error("[Worker] ❌ IMAP_USER dan IMAP_PASS wajib diisi!");
    process.exit(1);
  }
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    console.error("[Worker] ❌ KV_REST_API_URL dan KV_REST_API_TOKEN wajib diisi!");
    process.exit(1);
  }

  const listener = createIMAPListener();

  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\n[Worker] Menerima SIGINT, mematikan listener...");
    await listener.stop();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    console.log("\n[Worker] Menerima SIGTERM, mematikan listener...");
    await listener.stop();
    process.exit(0);
  });

  await listener.start();
  console.log("[Worker] ✅ IMAP Listener aktif, menunggu email OTP...\n");
}

main().catch((err) => {
  console.error("[Worker] Fatal error:", err);
  process.exit(1);
});
