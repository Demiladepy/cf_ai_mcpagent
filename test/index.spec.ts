import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src';

describe('Resource Allocation Agent worker', () => {
	describe('request for /message', () => {
		it('responds with Resource Allocation Agent message (unit style)', async () => {
			const request = new Request<unknown, IncomingRequestCfProperties>('http://example.com/message');
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(await response.text()).toMatchInlineSnapshot(`"Hello, Resource Allocation Agent!"`);
		});

		it('responds with Resource Allocation Agent message (integration style)', async () => {
			const request = new Request('http://example.com/message');
			const response = await SELF.fetch(request);
			expect(await response.text()).toMatchInlineSnapshot(`"Hello, Resource Allocation Agent!"`);
		});
	});

	describe('request for /random', () => {
		it('/ responds with a random UUID (unit style)', async () => {
			const request = new Request<unknown, IncomingRequestCfProperties>('http://example.com/random');
			// Create an empty context to pass to `worker.fetch()`.
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			// Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
			await waitOnExecutionContext(ctx);
			expect(await response.text()).toMatch(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/);
		});

		it('responds with a random UUID (integration style)', async () => {
			const request = new Request('http://example.com/random');
			const response = await SELF.fetch(request);
			expect(await response.text()).toMatch(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/);
		});
	});

	describe('GET /api/utilization', () => {
		it('returns JSON with byResource array', async () => {
			const request = new Request('http://example.com/api/utilization');
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(response.headers.get('Content-Type')).toContain('application/json');
			const data = (await response.json()) as { byResource: unknown[] };
			expect(Array.isArray(data.byResource)).toBe(true);
		});
	});
});
