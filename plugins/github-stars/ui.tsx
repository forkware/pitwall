import { Star } from "lucide-react";
import { useEffect, useState } from "react";
import { addStrings, defineUiPlugin, rpc, t } from "#sdk/ui";
import type { Stars } from "./server.ts";

addStrings({
  en: {
    "github-stars.star": "Star",
    "github-stars.hint": "Like the app? Star it on GitHub ({repo}): more people find it",
  },
  ru: {
    "github-stars.star": "Звезда",
    "github-stars.hint": "Нравится приложение? Поставьте звезду на GitHub ({repo}): так его найдут другие",
  },
});

/** 1234 → "1.2k", like GitHub's own badge. */
export function shortCount(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k < 10 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}k`;
}

function StarsBadge() {
  const [stars, setStars] = useState<Stars | null>(null);
  useEffect(() => {
    let alive = true;
    // The server caches the count for an hour and never throws; a failed request leaves the badge hidden.
    const load = () => rpc<Stars>("github-stars", "stars").then((s) => alive && setStars(s), () => {});
    load();
    const timer = setInterval(load, 60 * 60 * 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  if (!stars) return null;
  return (
    <a
      href={stars.url}
      target="_blank"
      rel="noreferrer"
      title={t("github-stars.hint", { repo: stars.repo })}
      className="inline-flex h-8 select-none items-center gap-1.5 whitespace-nowrap rounded-md border border-line bg-raised px-2.5 text-[13px] font-medium text-text transition-colors duration-150 hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <Star size={15} strokeWidth={2} className="text-muted" />
      {stars.count === null ? t("github-stars.star") : <span className="tabular-nums">{shortCount(stars.count)}</span>}
    </a>
  );
}

export default defineUiPlugin({
  slots: { "header.actions": StarsBadge },
});
