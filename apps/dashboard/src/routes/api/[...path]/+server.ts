import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { RequestHandler } from './$types';
const proxy: RequestHandler = async ({ params, request, url }) => {
  try {
    const token =
      process.env.MIMIC_INTERNAL_TOKEN ??
      (
        await readFile(
          resolve(process.env.MIMIC_DATA_DIR ?? '../../data', 'control.token'),
          'utf8',
        )
      ).trim();
    const response = await fetch(
      `${process.env.MIMIC_API_URL ?? 'http://127.0.0.1:3212'}/api/${params.path}${url.search}`,
      {
        method: request.method,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        ...(['GET', 'HEAD'].includes(request.method)
          ? {}
          : { body: await request.text() }),
        signal: AbortSignal.timeout(60000),
        redirect: 'error',
      },
    );
    return new Response(response.body, {
      status: response.status,
      headers: {
        'content-type':
          response.headers.get('content-type') ?? 'application/json',
        'cache-control': 'no-store',
      },
    });
  } catch {
    return Response.json({ error: 'daemon_unavailable' }, { status: 503 });
  }
};
export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const DELETE = proxy;
