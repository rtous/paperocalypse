import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface Session {
    adminId?: string;
    operatorId?: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    adminId?: string;
    operatorId?: string;
  }
}
