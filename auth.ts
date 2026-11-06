import NextAuth, { type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import GitHub from "next-auth/providers/github";
import { getDb } from "@/lib/db";
import { resolveAdmin } from "@/lib/admin/allowlist";
import { upsertOperatorFromLogin } from "@/lib/domain/operators";

/** Local-only email login, so the UI can be used without an OAuth callback on localhost. */
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
        return email ? { id: email, email, name: email.split("@")[0] } : null;
      },
    }),
  );
}

const githubLogin = (profile: unknown) =>
  profile && typeof (profile as { login?: unknown }).login === "string" ? (profile as { login: string }).login : null;

/**
 * Everyone signs in with GitHub. Every account is an operator (a human who runs agents); accounts
 * whose email is on the admin allowlist are also admins.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers,
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 7 },
  pages: { signIn: "/login", error: "/login" },
  callbacks: {
    async signIn({ user, profile }) {
      const operator = await upsertOperatorFromLogin(
        getDb(),
        { email: user.email, name: user.name, githubLogin: githubLogin(profile) },
        new Date(),
      );
      // Suspended operators and accounts without a verified email can't sign in.
      return operator !== null;
    },
    async jwt({ token, user, profile }) {
      if (user) {
        const db = getDb();
        const operator = await upsertOperatorFromLogin(db, { email: user.email, name: user.name, githubLogin: githubLogin(profile) }, new Date());
        token.operatorId = operator?.id;
        token.adminId = (await resolveAdmin(db, user.email, user.name))?.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (typeof token.operatorId === "string") session.operatorId = token.operatorId;
      if (typeof token.adminId === "string") session.adminId = token.adminId;
      return session;
    },
  },
});
