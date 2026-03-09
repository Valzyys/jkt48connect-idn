import type { VercelRequest, VercelResponse } from "@vercel/node";
import { setJobStatus } from "../../lib/redis";

/**
 * POST /api/job/reset
 * Reset job yang stuck di status "running" atau "waiting_otp"
 * Body: { email: string }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const apiKey = req.headers["x-api-key"] ?? req.query.apikey;
  if (apiKey !== process.env.API_SECRET_KEY) {
    return res.status(401).json({ status: false, error: "Unauthorized" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ status: false, error: "Method not allowed" });
  }

  const { email } = req.body ?? {};
  if (!email) {
    return res.status(400).json({ status: false, error: "email required" });
  }

  await setJobStatus(email, {
    status: "idle",
    message: "Reset manual oleh admin",
    startedAt: null,
    finishedAt: new Date().toISOString(),
  });

  return res.status(200).json({
    status: true,
    message: `Job untuk ${email} berhasil direset ke idle`,
  });
}
