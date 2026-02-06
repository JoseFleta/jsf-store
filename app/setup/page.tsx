"use client";

import { useEffect, useState } from "react";
import { supabaseBrowser } from "../../lib/supabaseBrowser";
import { useRouter } from "next/navigation";

type Store = { id: string; name: string; created_at: string };

export default function SetupPage() {
  const supabase = supabaseBrowser();
  const router = useRouter();

  const [stores, setStores] = useState<Store[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState<string>("");
  const [msg, setMsg] = useState<string>("");

  useEffect(() => {
    (async () => {
      const { data: userRes } = await supabase.auth.getUser();
      if (!userRes.user) {
        router.push("/login");
        return;
      }

      const { data, error } = await supabase
        .from("stores")
        .select("id,name,created_at")
        .order("created_at", { ascending: false });

      if (error) {
        setMsg(error.message);
        return;
      }

      setStores(data ?? []);
      if (data && data.length > 0) setSelectedStoreId(data[0].id);
    })();
  }, [router, supabase]);

  const linkMe = async () => {
    setMsg("");
    const { data: userRes } = await supabase.auth.getUser();
    const user = userRes.user;
    if (!user) return router.push("/view/login");
    if (!selectedStoreId) return setMsg("Selecciona una tienda.");

    const { error } = await supabase.from("store_memberships").insert({
      store_id: selectedStoreId,
      user_id: user.id,
      role: "owner",
    });

    if (error) return setMsg(error.message);

    router.push("/view/dashboard");
  };

  return (
    <main style={{ padding: 24, fontFamily: "system-ui", maxWidth: 520, background: "#fff", color: "#111", minHeight: "100vh" }}>
      <h1>Setup</h1>
      <p>Elige tu tienda y enlázate como owner.</p>

      <label>Tienda</label>
      <select
        style={{ width: "100%", padding: 10, margin: "6px 0 12px", border: "1px solid #ddd", borderRadius: 8 }}
        value={selectedStoreId}
        onChange={(e) => setSelectedStoreId(e.target.value)}
      >
        {stores.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>

      <button
        onClick={linkMe}
        style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #111", background: "#111", color: "#fff" }}
      >
        Enlazarme como owner
      </button>

      {msg && <p style={{ marginTop: 12 }}>{msg}</p>}
    </main>
  );
}
