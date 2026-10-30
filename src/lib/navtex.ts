import { createServerFn } from "@tanstack/react-start";

const PAGE = "https://www.sealagom.com/navarea/9/messages/";
const CACHE_MS = 3 * 60 * 1000;

export type NavtexMessage = {
  id: string;
  number: string;
  title: string;
  category: string;
  time: string;
  body: string;
  arabic: string;
  href: string;
};

export type NavtexFeed = {
  messages: NavtexMessage[];
  fetchedAt: string;
  source: string;
};

const PHRASES: Array<[RegExp, string]> = [
  [/strait of hormuz/gi, "مضيق هرمز"],
  [/gulf of oman/gi, "خليج عُمان"],
  [/arabian gulf|persian gulf|the gulf/gi, "الخليج"],
  [/central gulf/gi, "وسط الخليج"],
  [/southern gulf/gi, "جنوب الخليج"],
  [/red sea/gi, "البحر الأحمر"],
  [/port muhammad bin qasim/gi, "ميناء محمد بن قاسم"],
  [/approach channel/gi, "قناة الاقتراب"],
  [/oil tanker/gi, "ناقلة نفط"],
  [/security incident/gi, "حادث أمني"],
  [/on fire/gi, "تشتعل"],
  [/drifting/gi, "تنجرف"],
  [/temporarily removed/gi, "رُفعت مؤقتاً"],
  [/removed/gi, "رُفعت"],
  [/reported unlit/gi, "مطفأة"],
  [/re-laid|relaid/gi, "أُعيد وضعها"],
  [/exclusion zone/gi, "منطقة ممنوع الاقتراب منها"],
  [/seismic survey/gi, "مسح زلزالي"],
  [/firing exercise|gunnery/gi, "رماية"],
  [/floating hose/gi, "خرطوم عائم"],
  [/towing/gi, "قطر"],
  [/anchorage|anchoring/gi, "رسو"],
  [/pipeline/gi, "خط أنابيب"],
  [/lightbuoy|light buoy/gi, "عوامة مضيئة"],
  [/buoys/gi, "عوامات"],
  [/buoy/gi, "عوامة"],
  [/unlit/gi, "غير مضاءة"],
  [/missing/gi, "مفقودة"],
  [/wreck/gi, "حطام"],
  [/dredging/gi, "حفر"],
  [/survey/gi, "مسح"],
  [/platform|rig/gi, "منصة"],
  [/cable/gi, "كابل"],
  [/piracy/gi, "قرصنة"],
  [/previous warning/gi, "تحذير سابق"],
  [/charts updated/gi, "الخرائط حُدّثت"],
  [/anchored/gi, "راسية"],
  [/near/gi, "قرب"],
  [/after/gi, "بعد"],
  [/harbour/gi, "الميناء"],
  [/in progress/gi, "جارية"],
  [/multiple/gi, "عدة"],
  [/dubai/gi, "دبي"],
  [/fujairah/gi, "الفجيرة"],
  [/karachi/gi, "كراتشي"],
  [/pakistan/gi, "باكستان"],
  [/qatar/gi, "قطر"],
  [/oman/gi, "عُمان"],
  [/kuwait/gi, "الكويت"],
  [/bahrain/gi, "البحرين"],
  [/uae/gi, "الإمارات"],
];

function decode(value: string): string {
  const amp = "&";
  return value
    .replaceAll(`${amp}#x27;`, "'")
    .replaceAll(`${amp}#39;`, "'")
    .replaceAll(`${amp}apos;`, "'")
    .replaceAll(`${amp}quot;`, '"')
    .replaceAll(`${amp}amp;`, amp)
    .replaceAll(`${amp}lt;`, "<")
    .replaceAll(`${amp}gt;`, ">")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function lastGroup(source: string, pattern: RegExp): string {
  let value = "";
  for (const match of source.matchAll(pattern)) value = match[1] ?? "";
  return value;
}

function translate(text: string): string {
  let next = text;
  for (const [pattern, arabic] of PHRASES) next = next.replace(pattern, arabic);
  return next.replace(/\s+/g, " ").trim();
}

function hasArabic(text: string): boolean {
  return /[\u0600-\u06FF]/.test(text);
}

function categoryLine(category: string): string {
  const key = category.toLowerCase();
  if (key.includes("piracy") || key.includes("security")) return "خطر أمني";
  if (key.includes("aid")) return "عطل في الإشارات أو العوامات";
  if (key.includes("tow")) return "عملية قطر";
  if (key.includes("offshore") || key.includes("operation")) return "أعمال بحرية";
  if (key.includes("cancel")) return "إلغاء تحذير سابق";
  if (key.includes("survey") || key.includes("seismic")) return "مسح بحري";
  if (key.includes("drill") || key.includes("rig")) return "أعمال حفر أو منصة";
  if (key.includes("military") || key.includes("firing")) return "نشاط عسكري أو رماية";
  if (key.includes("cable")) return "أعمال كابل";
  if (category) return "تحذير ملاحي";
  return "تحذير ملاحي";
}

export function explainNavtex(title: string, category: string, body: string): string {
  const translated = translate(title);
  const parts = [categoryLine(category)];
  if (hasArabic(translated) && translated.length > 4) parts.push(translated.replace(/\.$/, ""));
  else if (/unlit/i.test(body)) parts.push("هناك عوامات أو أضواء غير مضاءة");
  else if (/fire|drifting|security incident/i.test(body)) parts.push("سفينة في حادث وقد تكون مشتعلة أو منجرفة");
  else if (/dredg/i.test(body)) parts.push("أعمال حفر في القناة أو الميناء");
  else if (/tow/i.test(body)) parts.push("سفينة تجر حمولة أو خرطوماً في الممر");
  else if (/survey|seismic/i.test(body)) parts.push("مسح بحري قد يعيق الملاحة");
  else if (/missing/i.test(body)) parts.push("مساعد ملاحي مفقود من موقعه");
  if (/MARINERS CAUTIONED|ADVISED TO NAVIGATE/i.test(body)) parts.push("على السفن الانتباه");
  if (!category.toLowerCase().includes("cancel") && /^CANCEL NAVAREA/im.test(body)) parts.push("يلغي تحذيراً سابقاً");
  return `${parts.join(". ")}.`;
}

export function parseNavareaPage(html: string): NavtexMessage[] {
  const parts = html.split(/<div id="content-(\d+)"[^>]*class="message-content[^"]*">/);
  const messages: NavtexMessage[] = [];
  for (let index = 1; index < parts.length; index += 2) {
    const id = parts[index] ?? "";
    const rest = parts[index + 1] ?? "";
    const end = rest.indexOf("</div>");
    const raw = end >= 0 ? rest.slice(0, end) : rest;
    const body = decode(raw.replace(/<[^>]+>/g, ""));
    if (body.length < 12) continue;
    const before = (parts[index - 1] ?? "").slice(-2800);
    const number = body.match(/NAVAREA IX\s+(\d{2,4}\/\d{2})/i)?.[1] ?? lastGroup(before, />(\d{2,4}\/\d{2})</g);
    const title = decode(lastGroup(before, /<span>([^<]{12,220})<\/span>/g));
    const category = decode(lastGroup(before, /class="text-xs font-medium [^"]*">([^<]+)<\/span>/g));
    const time = decode(lastGroup(before, /<time[^>]*>([^<]+)<\/time>/g));
    messages.push({
      id,
      number,
      title,
      category,
      time,
      body,
      arabic: explainNavtex(title, category, body),
      href: `https://www.sealagom.com/navarea/9/message/${id}/`,
    });
  }
  const seen = new Set<string>();
  return messages.filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}

let cache: { at: number; feed: NavtexFeed } | null = null;

async function loadNavtex(force: boolean): Promise<NavtexFeed> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.feed;
  const response = await fetch(PAGE, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "text/html",
    },
  });
  if (!response.ok) throw new Error("navtex");
  const messages = parseNavareaPage(await response.text()).slice(0, 40);
  if (!messages.length) throw new Error("navtex");
  const feed: NavtexFeed = {
    messages,
    fetchedAt: new Date().toISOString(),
    source: PAGE,
  };
  cache = { at: Date.now(), feed };
  return feed;
}

export const getNavtex = createServerFn({ method: "POST" })
  .validator((data: { force?: boolean } | undefined) => data ?? {})
  .handler(async ({ data }): Promise<NavtexFeed> => loadNavtex(Boolean(data?.force)));
