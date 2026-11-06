import NextAuth, { type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import GitHub from "next-auth/providers/github";
import { getDb } from "@/lib/db";
import { resolveAdmin } from "@/lib/admin/allowlist";

/** Local-only email login, so the admin UI can be used without an OAuth callback on localhost. */
export const devLoginEnabled =
  process.env.NODE_ENV === "development" && process.env.AUTH_DEV_LOGIN === "true";

const providers: NextAuthConfig["providers"] = [GitHub];
if (devLoginEnabled) {
  providers.push(
    Credentials({
      id: "dev",
      name: "Dev login",
      credentials: { email: { label: "Email", type: "email" } },
      authorize: async (creds) => {
        const email = typeof creds?.email === "string" ? creds.email : null;
        return email ? { id: email, email, name: email } : null;
      },
    }),
  );
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers,
  session: { strategy: "jwt", maxAge: 60 * 60 * 12 },
  pages: { signIn: "/admin/login", error: "/admin/login" },
  callbacks: {
    // Only allowlisted admins can sign in at all.
    async signIn({ user }) {
      const admin = await resolveAdmin(getDb(), user.email, user.name);
      return admin !== null;
    },
    async jwt({ token, user }) {
      if (user) {
        const admin = await resolveAdmin(getDb(), user.email, user.name);
        token.adminId = admin?.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (typeof token.adminId === "string") session.adminId = token.adminId;
      return session;
    },
  },
});
