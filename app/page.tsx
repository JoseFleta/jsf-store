"use client";

import { useEffect } from "react";
import { supabaseBrowser } from "../lib/supabaseBrowser";
import { useRouter } from "next/navigation";

export default function Home() {
  const supabase = supabaseBrowser();
  const router = useRouter();

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getUser();
      if (!data.user) router.push("/login");
      else router.push("/dashboard");
    })();
  }, [router, supabase]);

  return null;
}
