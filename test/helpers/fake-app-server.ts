import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const message = JSON.parse(line) as { id?: number; method?: string; result?: unknown };
  if (message.method === 'initialize') process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: 'fixture' } }) + '\n');
  if (message.method === 'initialized') process.stdout.write(JSON.stringify({ method: 'ready', params: { simulated: true } }) + '\n');
  if (message.method === 'echo') process.stdout.write(JSON.stringify({ id: message.id, result: { ok: true } }) + '\n');
  if (message.method === 'ask') process.stdout.write(JSON.stringify({ id: 'approval-1', method: 'approval/request', params: { reason: 'fixture' } }) + '\n');
  if (message.id === 'approval-1' as unknown as number) process.stdout.write(JSON.stringify({ method: 'response-observed', params: message.result }) + '\n');
});
