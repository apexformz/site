import { jsonResponse, readManifest } from '../../_lib';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ sport: string }> }): Promise<Response> {
  const m = await readManifest((await params).sport);
  if (!m) return Response.json({ success: false, error: 'UNKNOWN_SPORT_PACK' }, { status: 404 });
  return jsonResponse(req, m.text);
}
