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
      if (!data.user) router.push("/view/login");
      else router.push("/view/dashboard");
    })();
  }, [router, supabase]);

  return null;
}