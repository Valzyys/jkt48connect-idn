import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getAllSessions, updateSessionStatus, setJobStatus } from "../../lib/redis";
import { runIDNLogin } from "../../lib/idn-scraper";

/**
 * GET /api/cron/refresh
 * Dipanggil otomatis oleh Vercel Cron setiap 24 jam (lihat vercel.json)
 * Juga bisa dipanggil manual dengan header Authorization
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Vercel Cron pakai header ini, atau bisa manual pakai x-api-key
  const cronSecret = req.headers["authorization"]?.replace("Bearer ", "");
  const apiKey     = req.headers["x-api-key"] ?? req.query.apikey;

  const isVercelCron = cronSecret === process.env.CRON_SECRET;
  const isManual     = apiKey === process.env.API_SECRET_KEY;

  if (!isVercelCron && !isManual) {
    return res.status(401).json({ status: false, error: "Unauthorized" });
  }

  const sessions = await getAllSessions();
  if (sessions.length === 0) {
    return res.status(200).json({ status: true, message: "Tidak ada session untuk direfresh" });
  }

  const results: { email: string; result: string }[] = [];

  for (const session of sessions) {
    const email = session.email;
    try {
      // Tandai sebagai refreshing
      await updateSessionStatus(email, "refreshing");
      await setJobStatus(email, {
        status: "running",
        message: "Auto-refresh oleh cron",
        startedAt: new Date().toISOString(),
        finishedAt: null,
      });

      await runIDNLogin(email);
      results.push({ email, result: "success" });
    } catch (err: any) {
      await updateSessionStatus(email, "failed");
      results.push({ email, result: `failed: ${err.message}` });
    }
  }

  return res.status(200).json({
    status: true,
    refreshedAt: new Date().toISOString(),
    total: sessions.length,
    results,
  });
}
