import { redirect } from "next/navigation";

/** Admins use the common sign-in page; admin rights come from the allowlist. */
export default async function AdminLogin({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  redirect(error ? `/login?error=${encodeURIComponent(error)}&callbackUrl=/admin` : "/login?callbackUrl=/admin");
}
