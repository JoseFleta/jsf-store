"use client";

import { useState } from "react";
import { supabaseBrowser } from "../../lib/supabaseBrowser";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const supabase = supabaseBrowser();
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<string>("");

  const signUp = async () => {
    setMsg("");
    const { error } = await supabase.auth.signUp({ email, password });
    if (error) return setMsg(error.message);
    setMsg("Cuenta creada. Ahora inicia sesión.");
  };

  const signIn = async () => {
    setMsg("");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return setMsg(error.message);
    router.push("/");
  };

  return (
    <main style={{ padding: 24, fontFamily: "system-ui", maxWidth: 420 }}>
      <h1>Login</h1>

      <label>Email</label>
      <input
        style={{ width: "100%", padding: 8, margin: "6px 0 12px" }}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />

      <label>Password</label>
      <input
        type="password"
        style={{ width: "100%", padding: 8, margin: "6px 0 12px" }}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />

      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={signIn} style={{ padding: "8px 12px" }}>
          Entrar
        </button>
        <button onClick={signUp} style={{ padding: "8px 12px" }}>
          Crear cuenta
        </button>
      </div>

      {msg && <p style={{ marginTop: 12 }}>{msg}</p>}
    </main>
  );
}
