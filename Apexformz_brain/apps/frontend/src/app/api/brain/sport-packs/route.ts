import { listPacks } from './_lib';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const packs = await listPacks();
  return Response.json({ success: true, data: packs });
}
