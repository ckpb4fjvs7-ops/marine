import { createServerFn } from "@tanstack/react-start";
import { parseUmmQasrPage, type TideTurn } from "./tide";

const PAGE = "https://almadwaaljazer.com/iq/iraq/umm-qasr";

export const getUmmQasrTide = createServerFn({ method: "GET" }).handler(async (): Promise<TideTurn[]> => {
  const response = await fetch(PAGE, {
    headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "ar" },
  });
  if (!response.ok) throw new Error("tide");
  const turns = parseUmmQasrPage(await response.text());
  if (!turns) throw new Error("tide");
  return turns;
});
