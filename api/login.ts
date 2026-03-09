import type { VercelRequest, VercelResponse } from "@vercel/node";
import { setJobStatus, getJobStatus } from "../lib/redis";
import { runIDNLogin } from "../lib/idn-scraper";

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
    return res.status(400).json({ status: false, error: "email required in body" });
  }

  // Cek apakah job sudah running
  const existing = await getJobStatus(email);
  if (existing?.status === "running" || existing?.status === "waiting_otp") {
    return res.status(409).json({
      status: false,
      error: "Job sudah berjalan untuk email ini",
      jobStatus: existing,
    });
  }

  // Jalankan login secara async (tidak blocking response)
  // Di Vercel, kita perlu menunggu selesai karena tidak ada background worker
  // Gunakan maxDuration: 300 di vercel.json
  try {
    const session = await runIDNLogin(email);
    return res.status(200).json({
      status: true,
      message: "Login berhasil",
      data: {
        email: session.email,
        uuid: session.uuid,
        status: session.status,
        updatedAt: session.updatedAt,
        hasTokens: !!session.tokens.id_token,
      },
    });
  } catch (err: any) {
    return res.status(500).json({
      status: false,
      error: err.message,
    });
  }
}
