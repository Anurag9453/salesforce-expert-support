import { LandingHeader } from "@/components/landing/landing-header";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh overflow-x-clip">
      <LandingHeader simple />
      <div className="mx-auto w-full max-w-md px-6 py-12">{children}</div>
    </div>
  );
}
