"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { buttonClasses } from "@/components/ui";

const POPULAR = ["Apex", "Agentforce", "Sales Cloud", "Service Cloud", "CPQ", "MuleSoft"] as const;

export function HeroSearch() {
  const router = useRouter();
  const [query, setQuery] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = query.trim();
    router.push(trimmed ? `/request-help?q=${encodeURIComponent(trimmed)}` : "/request-help");
  }

  return (
    <div className="w-full min-w-0 max-w-2xl">
      <form
        onSubmit={submit}
        className="flex w-full min-w-0 flex-col overflow-hidden rounded-xl bg-surface-raised shadow-lifted sm:flex-row sm:items-stretch"
      >
        <label className="sr-only" htmlFor="hero-skill-search">
          Search Salesforce skills
        </label>
        <input
          id="hero-skill-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="What Salesforce skill do you need?"
          className="h-12 w-full min-w-0 flex-1 border-0 bg-transparent px-5 text-sm text-ink outline-none placeholder:text-ink-subtle"
        />
        <button
          type="submit"
          className={buttonClasses({ size: "md", className: "m-1.5 w-[calc(100%-0.75rem)] shrink-0 sm:w-auto" })}
        >
          Find experts
        </button>
      </form>

      <p className="mt-4 flex max-w-full flex-wrap items-center gap-2 text-sm text-white/65">
        <span className="text-white/45">Popular:</span>
        {POPULAR.map((skill) => (
          <a
            key={skill}
            href={`/request-help?q=${encodeURIComponent(skill)}`}
            className="rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-medium text-white/85 transition-colors hover:border-white/35 hover:bg-white/10"
          >
            {skill}
          </a>
        ))}
      </p>
    </div>
  );
}
