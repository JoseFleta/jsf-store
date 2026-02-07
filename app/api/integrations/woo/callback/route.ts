import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createHmac } from "crypto";

type WooCallbackBody = {
  consumer_key?: string;
  consumer_secret?: string;
  key_permissions?: string;
  user_id?: string;
};

function signPayload(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

function parseState(state: string) {
  const [payloadB64, signature] = state.split(".");
  if (!payloadB64 || !signature) return null;
  const expected = signPayload(payloadB64, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  if (signature !== expected) return null;

  try {
    const raw = Buffer.from(payloadB64, "base64url").toString("utf8");
    const parsed = JSON.parse(raw) as { storeId?: string; sessionId?: string; exp?: number };
    if (!parsed.storeId || !parsed.sessionId || !parsed.exp) return null;
    if (Date.now() > parsed.exp) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function parseBody(req: Request): Promise<WooCallbackBody> {
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return (await req.json().catch(() => ({}))) as WooCallbackBody;
  }

  const text = await req.text();
  const params = new URLSearchParams(text);
  return {
    consumer_key: params.get("consumer_key") || undefined,
    consumer_secret: params.get("consumer_secret") || undefined,
    key_permissions: params.get("key_permissions") || undefined,
    user_id: params.get("user_id") || undefined,
  };
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  const state = (url.searchParams.get("state") || "").trim();
  if (!state) return NextResponse.json({ error: "Missing state" }, { status: 400 });

  const parsed = parseState(state);
  if (!parsed) return NextResponse.json({ error: "Invalid state" }, { status: 400 });

  const body = await parseBody(req);
  const consumerKey = (body.consumer_key || "").trim();
  const consumerSecret = (body.consumer_secret || "").trim();
  const userId = (body.user_id || "").trim();

  if (!consumerKey || !consumerSecret || !userId) {
    return NextResponse.json({ error: "Missing Woo callback parameters" }, { status: 400 });
  }
  if (userId !== parsed.sessionId) {
    return NextResponse.json({ error: "Session mismatch" }, { status: 400 });
  }

  const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { error } = await supabaseAdmin.from("store_integrations").upsert(
    {
      store_id: parsed.storeId,
      woo_key: consumerKey,
      woo_secret: consumerSecret,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "store_id" },
  );

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
