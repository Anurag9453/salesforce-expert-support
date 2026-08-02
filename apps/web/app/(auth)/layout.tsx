import Link from "next/link";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <Link href="/" className="mb-8 block text-sm font-semibold tracking-tight text-ink">
          Salesforce Expert Support
        </Link>
        {children}
      </div>
    </div>
  );
}
