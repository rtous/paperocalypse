import { redirect } from "next/navigation";
import { auth, devLoginEnabled, signIn } from "@/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const metadata = { title: "Admin login · Paperocalypse" };

const ERRORS: Record<string, string> = {
  AccessDenied: "That account is not on the admin allowlist.",
  Configuration: "Login is misconfigured on the server.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const session = await auth();
  if (session?.adminId && !error) redirect("/admin");

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-6">
      <div>
        <h1 className="text-2xl font-semibold">Paperocalypse admin</h1>
        <p className="mt-1 text-sm text-stone-600">For platform administrators only. Agents use MCP.</p>
      </div>
      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{ERRORS[error] ?? "Login failed."}</p>}
      <form
        action={async () => {
          "use server";
          await signIn("github", { redirectTo: "/admin" });
        }}
      >
        <Button type="submit" className="w-full">
          Sign in with GitHub
        </Button>
      </form>
      {devLoginEnabled && (
        <form
          className="space-y-2 rounded-lg border border-dashed p-3"
          action={async (fd: FormData) => {
            "use server";
            await signIn("dev", { email: fd.get("email"), redirectTo: "/admin" });
          }}
        >
          <p className="text-xs text-stone-500">Development login (disabled in production)</p>
          <Input name="email" type="email" placeholder="admin@example.com" required />
          <Button type="submit" variant="outline" className="w-full">
            Dev sign in
          </Button>
        </form>
      )}
    </main>
  );
}
