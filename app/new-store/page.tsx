"use client";

import { useState } from "react";
import { supabaseBrowser } from "../../lib/supabaseBrowser";
import { useRouter } from "next/navigation";

export default function NewStorePage() {
  const supabase = supabaseBrowser();
  const router = useRouter();
  const [name, setName] = useState("");
  const [msg, setMsg] = useState("");

  const create = async () => {
  setMsg("");

  const { data: sessionRes } = await supabase.auth.getSession();
  const token = sessionRes.session?.access_token;
  if (!token) {
    router.push("/login");
    return;
  }

  if (!name.trim()) return setMsg("Pon un nombre.");

  const res = await fetch("/api/stores/create", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ name }),
  });

  const json = await res.json();
  if (!res.ok) return setMsg(json.error || "Error creando tienda");

  router.push("/dashboard");
};


  return (
    <main style={{ padding: 24, fontFamily: "system-ui", maxWidth: 520 }}>
      <h1>Nueva tienda</h1>

      <label>Nombre</label>
      <input
        style={{ width: "100%", padding: 10, margin: "6px 0 12px" }}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />

      <button onClick={create} style={{ padding: "10px 14px" }}>
        Crear
      </button>

      {msg && <p style={{ marginTop: 12 }}>{msg}</p>}
    </main>
  );
}
