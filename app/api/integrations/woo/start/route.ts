import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createHmac, randomUUID } from "crypto";

type StartPayload = {
  storeId?: string;
  wooUrl?: string;
};

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function signPayload(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

export async function POST(req: Request) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return NextResponse.json({ error: "Missing bearer token" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as StartPayload;
  const storeId = (body.storeId || "").trim();
  const wooUrlRaw = (body.wooUrl || "").trim();
  if (!storeId) return NextResponse.json({ error: "Missing storeId" }, { status: 400 });
  if (!wooUrlRaw) return NextResponse.json({ error: "Missing Woo URL" }, { status: 400 });

  let wooUrl = wooUrlRaw;
  try {
    const parsed = new URL(wooUrlRaw);
    wooUrl = parsed.origin;
  } catch {
    return NextResponse.json({ error: "Invalid Woo URL" }, { status: 400 });
  }

  const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: userRes, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userRes?.user) return NextResponse.json({ error: "Invalid session" }, { status: 401 });

  const { data: membership, error: memErr } = await supabaseAdmin
    .from("store_memberships")
    .select("role")
    .eq("store_id", storeId)
    .eq("user_id", userRes.user.id)
    .maybeSingle();
  if (memErr || !membership) return NextResponse.json({ error: "Store access denied" }, { status: 403 });

  const sessionId = randomUUID();
  const payload = {
    storeId,
    sessionId,
    exp: Date.now() + 15 * 60 * 1000,
  };
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signature = signPayload(payloadB64, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const state = `${payloadB64}.${signature}`;

  const configuredBaseUrl =
    (process.env.APP_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || "").trim() ||
    new URL(req.url).origin;

  let appBaseUrl: URL;
  try {
    appBaseUrl = new URL(configuredBaseUrl);
  } catch {
    return NextResponse.json({ error: "Invalid APP_BASE_URL / NEXT_PUBLIC_APP_URL configuration." }, { status: 400 });
  }

  if (appBaseUrl.protocol !== "https:") {
    return NextResponse.json(
      {
        error:
          "Woo callback_url must use SSL (HTTPS). Set APP_BASE_URL to your HTTPS app domain (for example https://your-app.vercel.app).",
      },
      { status: 400 },
    );
  }

  const callbackUrl = `${appBaseUrl.origin}/api/integrations/woo/callback?state=${encodeURIComponent(state)}`;
  const returnUrl = `${appBaseUrl.origin}/view/dashboard/settings/woo/callback?store=${encodeURIComponent(storeId)}&success=1`;

  const authorizeUrl = new URL("/wc-auth/v1/authorize", wooUrl);
  authorizeUrl.searchParams.set("app_name", "Stock SaaS");
  authorizeUrl.searchParams.set("scope", "read_write");
  authorizeUrl.searchParams.set("user_id", sessionId);
  authorizeUrl.searchParams.set("return_url", returnUrl);
  authorizeUrl.searchParams.set("callback_url", callbackUrl);

  return NextResponse.json({ authorizeUrl: authorizeUrl.toString(), sessionId });
}
