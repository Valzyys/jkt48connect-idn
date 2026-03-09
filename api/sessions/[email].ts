import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSession, getJobStatus } from "../../lib/redis";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const apiKey = req.headers["x-api-key"] ?? req.query.apikey;
  if (apiKey !== process.env.API_SECRET_KEY) {
    return res.status(401).json({ status: false, error: "Unauthorized" });
  }

  if (req.method !== "GET") {
    return res.status(405).json({ status: false, error: "Method not allowed" });
  }

  const email = decodeURIComponent(req.query.email as string);
  if (!email) {
    return res.status(400).json({ status: false, error: "Email required" });
  }

  try {
    const [session, jobStatus] = await Promise.all([
      getSession(email),
      getJobStatus(email),
    ]);

    if (!session) {
      return res.status(404).json({
        status: false,
        error: "Session not found",
        jobStatus,
      });
    }

    return res.status(200).json({
      status: true,
      data: session,
      jobStatus,
    });
  } catch (err: any) {
    return res.status(500).json({ status: false, error: err.message });
  }
}
