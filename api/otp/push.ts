import type { VercelRequest, VercelResponse } from "@vercel/node";
import { setOTP, getJobStatus } from "../../lib/redis";

/**
 * Endpoint fallback: push OTP secara manual ke Redis
 * Dipakai jika IMAP listener tidak berjalan di environment tertentu
 *
 * POST /api/otp/push
 * Body: { email: string, otp: string }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const apiKey = req.headers["x-api-key"] ?? req.query.apikey;
  if (apiKey !== process.env.API_SECRET_KEY) {
    return res.status(401).json({ status: false, error: "Unauthorized" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ status: false, error: "Method not allowed" });
  }

  const { email, otp } = req.body ?? {};
  if (!email || !otp) {
    return res.status(400).json({ status: false, error: "email dan otp required" });
  }

  if (!/^\d{6}$/.test(otp)) {
    return res.status(400).json({ status: false, error: "OTP harus 6 digit angka" });
  }

  try {
    await setOTP(email, otp, 300);
    const jobStatus = await getJobStatus(email);

    return res.status(200).json({
      status: true,
      message: `OTP ${otp} disimpan untuk ${email}, berlaku 5 menit`,
      jobStatus,
    });
  } catch (err: any) {
    return res.status(500).json({ status: false, error: err.message });
  }
}
