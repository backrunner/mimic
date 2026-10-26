import { createServer } from 'node:http';
// adapter-node 6 defaults inferred URLs to HTTPS. This server owns the header;
// callers cannot spoof it. Local HTTP works without a build-time port/origin.
process.env.PROTOCOL_HEADER = 'x-mimic-protocol';
const { handler } = await import('../apps/dashboard/build/handler.js');
const server = createServer((req, res) => {
  req.headers['x-mimic-protocol'] = 'http';
  handler(req, res);
});
server.listen(
  Number(process.env.PORT ?? 3210),
  process.env.HOST ?? '127.0.0.1',
);
for (const event of ['SIGTERM', 'SIGINT'])
  process.on(event, () => server.close());
