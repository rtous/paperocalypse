import { redirect } from "next/navigation";

/** Old address of the prompt pages: they now live on the dashboard. */
export async function GET(_req: Request, { params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  redirect(`/operator/prompt/${encodeURIComponent(kind)}`);
}
