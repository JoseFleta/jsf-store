import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

type ExchangePayload = {
  storeId?: string;
  code?: string;
  codeVerifier?: string;
  redirectUri?: string;
};

function normalizeOptional(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function parseErrorBody(res: Response): Promise<string> {
  const text = await res.text();
  if (!text) return `${res.status} ${res.statusText}`;
  return `${res.status} ${text}`;
}

export async function POST(req: Request) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return NextResponse.json({ error: "Missing bearer token" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as ExchangePayload;
  const storeId = (body.storeId || "").trim();
  const code = (body.code || "").trim();
  const codeVerifier = (body.codeVerifier || "").trim();
  const redirectUri = (body.redirectUri || "").trim();

  if (!storeId) return NextResponse.json({ error: "Missing storeId" }, { status: 400 });
  if (!code) return NextResponse.json({ error: "Missing code" }, { status: 400 });
  if (!codeVerifier) return NextResponse.json({ error: "Missing codeVerifier" }, { status: 400 });
  if (!redirectUri) return NextResponse.json({ error: "Missing redirectUri" }, { status: 400 });

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

  const { data: integration, error: integrationErr } = await supabaseAdmin
    .from("store_integrations")
    .select("etsy_keystring")
    .eq("store_id", storeId)
    .maybeSingle();

  if (integrationErr?.message.includes("Could not find the table 'public.store_integrations'")) {
    return NextResponse.json(
      { error: "Missing DB table: public.store_integrations. Run sql/store_integrations.sql in Supabase SQL Editor." },
      { status: 400 },
    );
  }

  const etsyKeystring = normalizeOptional(integration?.etsy_keystring) || normalizeOptional(process.env.ETSY_KEYSTRING);
  if (!etsyKeystring) {
    return NextResponse.json({ error: "Missing ETSY keystring in store settings." }, { status: 400 });
  }

  const params = new URLSearchParams();
  params.set("grant_type", "authorization_code");
  params.set("client_id", etsyKeystring);
  params.set("redirect_uri", redirectUri);
  params.set("code", code);
  params.set("code_verifier", codeVerifier);

  const tokenRes = await fetch("https://api.etsy.com/v3/public/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  if (!tokenRes.ok) {
    return NextResponse.json({ error: `Etsy token exchange failed: ${await parseErrorBody(tokenRes)}` }, { status: 400 });
  }

  const tokenData = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const accessToken = normalizeOptional(tokenData.access_token);
  const refreshToken = normalizeOptional(tokenData.refresh_token);
  if (!accessToken || !refreshToken) {
    return NextResponse.json({ error: "Etsy token exchange failed: missing token values." }, { status: 400 });
  }

  const expiresAt =
    typeof tokenData.expires_in === "number" && Number.isFinite(tokenData.expires_in)
      ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
      : null;

  const { error: saveErr } = await supabaseAdmin.from("store_integrations").upsert(
    {
      store_id: storeId,
      etsy_bearer: accessToken,
      etsy_refresh_token: refreshToken,
      etsy_token_expires_at: expiresAt,
      etsy_keystring: etsyKeystring,
      updated_at: new Date().toISOString(),
    } as any,
    { onConflict: "store_id" },
  );
  if (saveErr) return NextResponse.json({ error: saveErr.message }, { status: 400 });

  return NextResponse.json({ ok: true, expiresAt });
}
