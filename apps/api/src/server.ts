import Fastify from 'fastify';

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? '0.0.0.0';

const app = Fastify({ logger: true });

app.get('/health', async () => ({ status: 'ok', service: 'diktat-api' }));

app.listen({ port: PORT, host: HOST }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
