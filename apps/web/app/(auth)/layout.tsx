import Link from "next/link";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="aurora flex min-h-dvh flex-col items-center justify-center px-6 py-12">
      <div className="animate-scale-in w-full max-w-sm">
        <Link
          href="/"
          className="font-display interactive mb-7 block text-center text-base font-medium tracking-tight text-ink hover:text-accent"
        >
          Salesforce Expert Support
        </Link>
        {children}
        <p className="mt-8 text-center text-xs leading-relaxed text-ink-subtle">
          Never share passwords, access tokens, or production customer data through this platform.
        </p>
      </div>
    </div>
  );
}
