import { useEffect, useState } from "react";

export const MOBILE_CHAT_QUERY = "(max-width: 760px), (max-width: 1000px) and (pointer: coarse)";

export function useMobileChat() {
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_CHAT_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(MOBILE_CHAT_QUERY);
    const update = () => setMobile(query.matches);
    query.addEventListener("change", update);
    update();
    return () => query.removeEventListener("change", update);
  }, []);
  return mobile;
}
