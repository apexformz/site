import { jsonResponse, readAsset } from '../../../_lib';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ sport: string; asset: string }> }): Promise<Response> {
  const resolved = await params;
  const asset = decodeURIComponent(resolved.asset);
  const text = await readAsset(resolved.sport, asset);
  if (text === null) return Response.json({ success: false, error: 'ASSET_NOT_LISTED' }, { status: 404 });
  return jsonResponse(req, text);
}
