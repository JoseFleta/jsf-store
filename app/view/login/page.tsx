"use client";

import { useState } from "react";
import { supabaseBrowser } from "../../../lib/supabaseBrowser";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const supabase = supabaseBrowser();
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<string>("");
  const [storeName, setStoreName] = useState("");
  const [storeMsg, setStoreMsg] = useState<string>("");

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
    router.push("/view/dashboard");
  };

  const createStore = async () => {
    setStoreMsg("");

    const { data: sessionRes } = await supabase.auth.getSession();
    const token = sessionRes.session?.access_token;
    if (!token) {
      setStoreMsg("Inicia sesión para crear una tienda.");
      return;
    }

    if (!storeName.trim()) return setStoreMsg("Pon un nombre.");

    const res = await fetch("/api/stores/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: storeName }),
    });

    const json = await res.json();
    if (!res.ok) return setStoreMsg(json.error || "Error creando tienda");

    router.push("/view/dashboard");
  };

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-12 lg:flex-row">
        <section className="flex-1 rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-indigo-700">
            Stock SaaS
          </span>
          <h1 className="mt-4 text-2xl font-semibold text-slate-900">Bienvenido</h1>
          <p className="mt-2 text-sm text-slate-500">
            Inicia sesión o crea una cuenta para acceder al panel.
          </p>

          <div className="mt-6 space-y-4">
            <div>
              <label className="text-sm font-medium text-slate-700">Email</label>
              <input
                className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <div>
              <label className="text-sm font-medium text-slate-700">Password</label>
              <input
                type="password"
                className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </div>

          <div className="mt-6 flex flex-wrap gap-3">
            <button
              onClick={signIn}
              className="rounded-full bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700"
              type="button"
            >
              Entrar
            </button>
            <button
              onClick={signUp}
              className="rounded-full border border-slate-200 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-indigo-200 hover:text-indigo-700"
              type="button"
            >
              Crear cuenta
            </button>
          </div>

          {msg && <p className="mt-4 text-sm text-slate-600">{msg}</p>}
        </section>

        <section className="flex-1 rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">Crear tienda</h2>
          <p className="mt-2 text-sm text-slate-500">
            Define el nombre de tu nueva tienda y empieza a trabajar.
          </p>

          <div className="mt-6">
            <label className="text-sm font-medium text-slate-700">Nombre de la tienda</label>
            <input
              className="mt-2 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
              value={storeName}
              onChange={(e) => setStoreName(e.target.value)}
            />
          </div>

          <button
            onClick={createStore}
            className="mt-6 w-full rounded-full bg-slate-900 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
            type="button"
          >
            Crear tienda
          </button>

          {storeMsg && <p className="mt-4 text-sm text-slate-600">{storeMsg}</p>}
        </section>
      </div>
    </main>
  );
}
