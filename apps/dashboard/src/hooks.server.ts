import type { Handle } from '@sveltejs/kit/hooks';
export const handle: Handle = async ({ event, resolve }) => {
  const host = event.url.hostname;
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(host) &&
    host !== process.env.MIMIC_DASHBOARD_HOSTNAME
  )
    return new Response('Invalid host', { status: 403 });
  const origin = event.request.headers.get('origin');
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes(event.request.method) &&
    origin !== event.url.origin
  )
    return new Response('Same-origin request required', { status: 403 });
  const result = await resolve(event);
  result.headers.set('X-Content-Type-Options', 'nosniff');
  result.headers.set('Referrer-Policy', 'same-origin');
  result.headers.set('X-Frame-Options', 'DENY');
  result.headers.set('Cache-Control', 'no-store');
  return result;
};
