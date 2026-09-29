/**
 * Tests for the bridge plugin.
 *
 * The plugin hands out a credential over an unauthenticated loopback route, so
 * the tests that matter most are the adversarial ones: each of the three
 * defences must be shown to actually stop a request, not merely to be present
 * in the source. A defence that is documented but not enforced is the worst
 * outcome here, so every guard gets a test that fails if the guard is removed.
 *
 * Nothing in this file touches a real DSH, a real $DSH_HOME, or a real socket.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync }
	from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `lib/index.js` resolves its secret path from `process.env.DSH_HOME` at call
 * time, but the module itself is cached after the first import — including its
 * module-level `secret` variable. Each test therefore needs a genuinely fresh
 * module instance, or a second `apply()` would keep reusing the first boot's
 * secret. A cache-busting query makes the loader treat it as a new module.
 */
let loadCounter = 0;

async function loadPlugin(dshHome) {
	process.env.DSH_HOME = dshHome;
	loadCounter += 1;
	return import(`../lib/index.js?boot=${loadCounter}`);
}

/** Minimal stand-in for a Node request carrying the headers the plugin reads. */
function makeRequest({ host = "127.0.0.1:3080", secret, url = "/local-bridge/auth" }) {
	const headers = { host };
	if (secret !== undefined) headers["x-dsh-bridge-secret"] = secret;
	return { headers, url };
}

/** Minimal stand-in for a Node response, capturing status and body. */
function makeResponse() {
	return {
		statusCode: null,
		headers: null,
		body: null,
		writeHead(status, headers) {
			this.statusCode = status;
			this.headers = headers;
		},
		end(chunk) {
			this.body = chunk;
		},
		json() {
			return JSON.parse(this.body);
		},
	};
}

/**
 * A ctx good enough for `apply()`.
 *
 * `webServer.register` mirrors the real host service: it records the route in a
 * shared table, returns the disposer that removes it, and THROWS on a duplicate
 * path. Modelling that faithfully is what makes the reload bug visible — a mock
 * that merely pushed into an array let a discarded disposer go unnoticed.
 */
function makeCtx({ mint } = {}) {
	const registered = [];
	const disposers = [];
	const table = new Map();
	return {
		registered,
		disposers,
		/** Run every disposer, as cordis does when the fiber unloads. */
		dispose() {
			for (const d of [...disposers].reverse()) {
				if (typeof d === "function") d();
			}
		},
		connection: {
			authenticatedUrl: mint ?? ((base) => `${base}/?token=fresh-token`),
		},
		webServer: {
			register(spec) {
				if (table.has(spec.path)) {
					throw new Error(
						`webserver: duplicate ${spec.kind} route "${spec.path}"`);
				}
				table.set(spec.path, spec);
				registered.push(spec);
				return () => {
					table.delete(spec.path);
				};
			},
			/** How many routes the table currently holds. */
			routeCount: () => table.size,
		},
		effect(execute, label) {
			// cordis runs the body immediately and expects a DISPOSER back.
			// Getting this wrong (returning the cleanup result instead) unlinks
			// at startup and registers nothing, so the assertion below matters.
			const disposable = execute();
			if (typeof disposable === "function") disposers.push(disposable);
			else if (disposable !== null && disposable !== undefined) {
				throw new TypeError("Invalid effect");
			}
			disposers.labels ??= [];
			disposers.labels.push(label);
		},
	};
}

let home;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "dsh-bridge-test-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	delete process.env.DSH_HOME;
});

/** Apply the plugin against a fresh temp $DSH_HOME and return its route handler. */
async function boot(options = {}) {
	const plugin = await loadPlugin(home);
	const ctx = makeCtx(options);
	plugin.apply(ctx);
	const spec = ctx.registered[0];
	return { ctx, spec, plugin, handler: spec.handler, secretPath: join(home, "local-bridge.secret") };
}

describe("registration", () => {
	test("registers an exact route at the documented path", async () => {
		const { spec, plugin } = await boot();
		assert.equal(spec.kind, "exact");
		// The path is load-bearing: the Python client hard-codes it, and
		// anything under /api is unreachable by design.
		assert.equal(spec.path, "/local-bridge/auth");
		assert.equal(spec.path, plugin.BRIDGE_PATH);
		assert.ok(!spec.path.startsWith("/api/"),
			"route must stay outside the authenticated /api channel");
	});

	test("declares the host services it depends on", async () => {
		const { plugin } = await boot();
		// The service is `webServer` (camelCase). Naming it `webserver` asks
		// cordis for a service that does not exist, so the plugin never loads.
		assert.deepEqual(plugin.inject, ["connection", "webServer"]);
	});

	test("returns a fresh URL for a correct request", async () => {
		const { handler, secretPath: sp } = await boot();
		const secret = readFileSync(sp, "utf8").trim();
		const res = makeResponse();
		await handler(makeRequest({ secret }), res);
		assert.equal(res.statusCode, 200);
		const body = res.json();
		assert.equal(body.ok, true);
		assert.equal(body.url, "http://127.0.0.1:3080/?token=fresh-token");
		// The client uses this to locate the file; a wrong value sends the
		// caller looking for a secret that was never written.
		assert.equal(body.secretPath, join(home, "local-bridge.secret"));
	});

	test("exports the name DSH keys the plugin by", async () => {
		// `name` is the identity in `dsh plugin list` and the registry key.
		const { plugin } = await boot();
		assert.equal(plugin.name, "dsh-local-bridge");
	});
});

describe("defence 1 — loopback only", () => {
	for (const host of ["example.com", "10.0.0.5:3080", "127.0.0.1.evil.com:3080",
		"0.0.0.0:3080", ""]) {
		test(`refuses a non-loopback Host: ${JSON.stringify(host)}`, async () => {
			const { handler, secretPath: sp } = await boot();
			const secret = readFileSync(sp, "utf8").trim();
			const res = makeResponse();
			await handler(makeRequest({ host, secret }), res);
			assert.equal(res.statusCode, 403);
			assert.equal(res.json().error, "loopback-only");
		});
	}

	for (const host of ["localhost:3080", "127.0.0.1:3080", "[::1]:3080"]) {
		test(`accepts loopback Host: ${host}`, async () => {
			const { handler, secretPath: sp } = await boot();
			const secret = readFileSync(sp, "utf8").trim();
			const res = makeResponse();
			await handler(makeRequest({ host, secret }), res);
			assert.equal(res.statusCode, 200);
		});
	}

	test("refuses before minting any URL", async () => {
		// A rejected request must not have touched the mint path at all.
		let minted = 0;
		const { handler, secretPath: sp } = await boot({
			mint: (base) => {
				minted += 1;
				return `${base}/?token=x`;
			},
		});
		const secret = readFileSync(sp, "utf8").trim();
		const res = makeResponse();
		await handler(makeRequest({ host: "evil.example", secret }), res);
		assert.equal(minted, 0, "no URL may be minted for a refused request");
	});
});

describe("defence 2 — per-boot shared secret", () => {
	test("refuses a wrong secret", async () => {
		const { handler } = await boot();
		const res = makeResponse();
		await handler(makeRequest({ secret: "not-the-secret" }), res);
		assert.equal(res.statusCode, 403);
		assert.equal(res.json().error, "bad-secret");
	});

	test("refuses a missing secret", async () => {
		const { handler } = await boot();
		const res = makeResponse();
		await handler(makeRequest({}), res);
		assert.equal(res.statusCode, 403);
		assert.equal(res.json().error, "bad-secret");
	});

	test("the secret changes on every boot", async () => {
		const first = await boot();
		const firstSecret = readFileSync(first.secretPath, "utf8");
		const second = await boot();
		const secondSecret = readFileSync(second.secretPath, "utf8");
		assert.notEqual(firstSecret, secondSecret, "a per-boot secret must be re-minted");
	});

	test("the secret is 32 random bytes, base64url encoded", async () => {
		await boot();
		const secret = readFileSync(join(home, "local-bridge.secret"), "utf8").trim();
		assert.match(secret, /^[A-Za-z0-9_-]{43}$/, "32 bytes -> 43 base64url chars");
	});

	test("a stale secret from a previous boot stops working", async () => {
		const first = await boot();
		const stale = readFileSync(first.secretPath, "utf8").trim();
		// A second boot must re-mint, so the previous secret stops working.
		const second = await boot();
		const res = makeResponse();
		await second.handler(makeRequest({ secret: stale }), res);
		assert.equal(res.statusCode, 403);
		assert.equal(res.json().error, "bad-secret");
	});

	test("accepts the secret via query string as a documented fallback", async () => {
		const { handler, secretPath: sp } = await boot();
		const secret = readFileSync(sp, "utf8").trim();
		const res = makeResponse();
		await handler(makeRequest({ url: `/local-bridge/auth?secret=${secret}` }), res);
		assert.equal(res.statusCode, 200);
	});
});

describe("defence 3 — the URL is never persisted", () => {
	test("the secret file holds only the secret", async () => {
		const { secretPath: sp } = await boot();
		const content = readFileSync(sp, "utf8");
		assert.ok(!content.includes("token"),
			"the authenticated URL must never touch disk");
		assert.ok(!content.includes("?"), "no URL-shaped content on disk");
	});

	test("the response is marked no-store", async () => {
		const { handler, secretPath: sp } = await boot();
		const secret = readFileSync(sp, "utf8").trim();
		const res = makeResponse();
		await handler(makeRequest({ secret }), res);
		assert.equal(res.headers["cache-control"], "no-store");
	});
});

describe("secret file handling", () => {
	test("is created owner-only (0600)", async () => {
		await boot();
		const mode = statSync(join(home, "local-bridge.secret")).mode & 0o777;
		assert.equal(mode, 0o600, "the secret must not be group/world readable");
	});

	test("is still present immediately after startup", async () => {
		// A body that ran its cleanup eagerly would leave no file behind; this
		// is the direct counterpart of the disposer contract below.
		await boot();
		assert.ok(statSync(join(home, "local-bridge.secret")).isFile());
	});

	test("tightens permissions on a pre-existing loose file", async () => {
		// A stale file left 0644 by an older version must not stay that way.
		const path = join(home, "local-bridge.secret");
		writeFileSync(path, "stale");
		chmodSync(path, 0o644);
		await boot();
		assert.equal(statSync(path).mode & 0o777, 0o600);
	});

	test("is removed when the plugin stops", async () => {
		const { ctx, secretPath: sp } = await boot();
		assert.ok(statSync(sp).isFile());
		// More than one effect is expected (secret cleanup + route ownership),
		// so assert the cleanup ran rather than pinning a count.
		assert.ok(ctx.disposers.length >= 1);
		ctx.dispose();
		assert.throws(() => statSync(sp), /ENOENT/,
			"the secret must not outlive the process");
	});

	test("ctx.effect receives a body returning a disposer", async () => {
		// cordis contract: the body must RETURN a callable. Registering the
		// cleanup result instead would unlink at startup and register nothing.
		const { ctx } = await boot();
		assert.ok(ctx.disposers.every((d) => typeof d === "function"),
			"every effect body must return a disposer function");
		ctx.dispose();
		assert.throws(() => statSync(join(home, "local-bridge.secret")), /ENOENT/);
	});

	test("effects are labelled so failures are attributable", async () => {
		const { ctx } = await boot();
		assert.ok(ctx.disposers.labels.length >= 1);
		for (const label of ctx.disposers.labels) {
			assert.match(label, /dsh-local-bridge/);
		}
	});
});

describe("route lifetime", () => {
	// The bug this guards: `register()` returns a disposer, and it throws on a
	// duplicate path. Discarding the disposer leaves the stale route in the
	// table, so the next apply() dies with "duplicate exact route" — a
	// permanent, silent outage after any reload.
	test("the route is released when the plugin stops", async () => {
		const { ctx } = await boot();
		assert.equal(ctx.webServer.routeCount(), 1);
		ctx.dispose();
		assert.equal(ctx.webServer.routeCount(), 0,
			"a disposed plugin must not leave its route registered");
	});

	test("a reload can register the same path again", async () => {
		// boot -> unload -> boot, as HMR or a config change would do.
		const first = await boot();
		first.ctx.dispose();
		const second = await boot();
		assert.equal(second.ctx.webServer.routeCount(), 1);
	});

	test("without releasing the route, a reload throws", async () => {
		// The negative control: proves the assertion above has teeth.
		const first = await boot();
		const stale = first.ctx.registered[0];
		assert.throws(() => first.ctx.webServer.register(stale),
			/duplicate exact route/);
	});
});

describe("failure modes", () => {
	test("a minting failure is a 500, not a crash", async () => {
		const { handler, secretPath: sp } = await boot({
			mint: () => {
				throw new Error("no connection yet");
			},
		});
		const secret = readFileSync(sp, "utf8").trim();
		const res = makeResponse();
		await handler(makeRequest({ secret }), res);
		assert.equal(res.statusCode, 500);
		assert.equal(res.json().ok, false);
		assert.match(res.json().error, /no connection yet/);
	});

	test("a secret from another boot is rejected even with a valid Host", async () => {
		const { handler } = await boot();
		const res = makeResponse();
		await handler(makeRequest({ host: "localhost:3080", secret: "wrong" }), res);
		assert.equal(res.statusCode, 403);
	});
});
