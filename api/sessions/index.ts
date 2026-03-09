import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getAllSessions } from "../../lib/redis";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const apiKey = req.headers["x-api-key"] ?? req.query.apikey;
  if (apiKey !== process.env.API_SECRET_KEY) {
    return res.status(401).json({ status: false, error: "Unauthorized" });
  }

  if (req.method !== "GET") {
    return res.status(405).json({ status: false, error: "Method not allowed" });
  }

  try {
    const sessions = await getAllSessions();

    const sanitized = sessions.map((s) => ({
      email: s.email,
      uuid: s.uuid,
      status: s.status,
      refreshCount: s.refreshCount,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      currentUrl: s.currentUrl,
      hasIdToken: !!s.tokens.id_token,
      hasAccessToken: !!s.tokens.access_token,
      hasRefreshToken: !!s.tokens.refresh_token,
      profileName:
        s.responses.profileDetail?.data?.name ??
        s.responses.profileDetail?.data?.username ??
        null,
    }));

    return res.status(200).json({
      status: true,
      total: sessions.length,
      data: sanitized,
    });
  } catch (err: any) {
    return res.status(500).json({ status: false, error: err.message });
  }
}
