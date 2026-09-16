import { cn } from "@/lib/utils";

export function SkillPickerLight({
  skills,
  selected,
  onChange,
}: {
  skills: ReadonlyArray<{ slug: string; name: string }>;
  selected: readonly string[];
  onChange: (slugs: string[]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {skills.map((skill) => {
        const active = selected.includes(skill.slug);
        return (
          <button
            key={skill.slug}
            type="button"
            aria-pressed={active}
            onClick={() =>
              onChange(
                active ? selected.filter((slug) => slug !== skill.slug) : [...selected, skill.slug],
              )
            }
            className={cn(
              "interactive rounded-full border px-3 py-1 text-xs font-medium",
              active
                ? "border-accent/40 bg-accent-subtle text-accent"
                : "border-border bg-surface-raised text-ink-muted hover:border-border-strong",
            )}
          >
            {skill.name}
          </button>
        );
      })}
    </div>
  );
}
