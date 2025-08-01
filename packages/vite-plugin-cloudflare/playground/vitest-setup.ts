import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-chromium";
import {
	createBuilder,
	createServer,
	loadConfigFromFile,
	mergeConfig,
	preview,
	Rollup,
} from "vite";
import { beforeAll, inject } from "vitest";
import type * as http from "node:http";
import type { Browser, Page } from "playwright-chromium";
import type {
	ConfigEnv,
	InlineConfig,
	Logger,
	PluginOption,
	PreviewServer,
	ResolvedConfig,
	UserConfig,
	ViteDevServer,
} from "vite";
import type { RunnerTestFile } from "vitest";

export const workspaceRoot = path.resolve(__dirname, "../");

export const isBuild = !!process.env.VITE_TEST_BUILD;
export const isWindows = process.platform === "win32";

export const isCINonLinux =
	process.platform !== "linux" && process.env.CI === "true";

/**
 * Vite Dev Server when testing serve
 */
export let viteServer: ViteDevServer;
/**
 * Root of the Vite fixture
 */
export let rootDir: string;
/**
 * Path to the current test file
 */
export let testPath: string;
/**
 * Path to the test folder
 */
export let testDir: string;
/**
 * Test folder name
 */
export let testName: string;

export const serverLogs: {
	info: string[];
	warns: string[];
	errors: string[];
} = {
	info: [],
	warns: [],
	errors: [],
};
export const browserLogs: string[] = [];
export const browserErrors: Error[] = [];

export let resolvedConfig: ResolvedConfig = undefined!;

export let page: Page = undefined!;
export let browser: Browser = undefined!;
export let viteTestUrl: string = "";
export let watcher: Rollup.RollupWatcher | undefined = undefined;

export function setViteUrl(url: string): void {
	viteTestUrl = url;
}

export function resetServerLogs() {
	serverLogs.info = [];
	serverLogs.warns = [];
	serverLogs.errors = [];
}

beforeAll(async (s) => {
	let server: ViteDevServer | http.Server | PreviewServer | undefined;

	const suite = s as RunnerTestFile;

	testPath = suite.filepath!;
	testName = slash(testPath).match(/playground\/([\w-]+)\//)?.[1]!;
	testDir = path.dirname(testPath);
	if (testName) {
		testDir = path.resolve(workspaceRoot, "playground", testName);
	}

	const wsEndpoint = inject("wsEndpoint");
	if (!wsEndpoint) {
		throw new Error("wsEndpoint not found");
	}

	browser = await chromium.connect(wsEndpoint);
	// `@vitejs/plugin-basic-ssl` requires a manual confirmation step in the browser so we enable `ignoreHTTPSErrors` to bypass this
	page = await browser.newPage({ ignoreHTTPSErrors: true });

	const globalConsole = console;
	const warn = globalConsole.warn;
	globalConsole.warn = (msg: string, ...args: unknown[]) => {
		if (msg.includes("Generated an empty chunk")) return;
		warn.call(globalConsole, msg, ...args);
	};

	try {
		page.on("console", (msg) => {
			// ignore favicon requests in headed browser
			if (
				process.env.VITE_DEBUG_SERVE &&
				msg.text().includes("Failed to load resource:") &&
				msg.location().url.includes("favicon.ico")
			) {
				return;
			}
			browserLogs.push(msg.text());
		});
		page.on("pageerror", (error) => {
			browserErrors.push(error);
		});

		// if this is a test placed under playground/xxx/__tests__
		// start a vite server in that directory.
		if (testName) {
			// when `root` dir is present, use it as vite's root
			const testCustomRoot = path.resolve(testDir, "root");
			rootDir = fs.existsSync(testCustomRoot) ? testCustomRoot : testDir;

			// separate rootDir for variant
			const variantName = path.basename(path.dirname(testPath));
			if (variantName !== "__tests__") {
				const variantTestDir = testDir + "__" + variantName;
				if (fs.existsSync(variantTestDir)) {
					rootDir = testDir = variantTestDir;
				}
			}

			const testCustomServe = [
				path.resolve(path.dirname(testPath), "serve.ts"),
				path.resolve(path.dirname(testPath), "serve.js"),
			].find((i) => fs.existsSync(i));

			if (testCustomServe) {
				// test has custom server configuration.
				const mod = await import(testCustomServe);
				const serve = mod.serve || mod.default?.serve;
				const preServe = mod.preServe || mod.default?.preServe;
				if (preServe) {
					await preServe();
				}
				if (serve) {
					server = (await serve()) ?? server;
					viteServer = mod.viteServer ?? viteServer;
					viteTestUrl = mod.viteTestUrl ?? viteTestUrl;
				}
			} else {
				server = await startDefaultServe();
			}
		}
	} catch (e) {
		// Closing the page since an error in the setup, for example a runtime error
		// when building the playground should skip further tests.
		// If the page remains open, a command like `await page.click(...)` produces
		// a timeout with an exception that hides the real error in the console.
		await page.close();
		await server?.close();
		throw e;
	}

	return async () => {
		resetServerLogs();

		await page?.close();
		await server?.close();
		await watcher?.close();
		await browser?.close();
	};
}, 15_000);

export async function loadConfig(configEnv: ConfigEnv) {
	let config: UserConfig | null = null;
	let cacheDir = "node_modules/.vite";

	// config file named by convention as the *.spec.ts folder
	const variantName = path.basename(path.dirname(testPath));
	if (variantName !== "__tests__") {
		cacheDir += "/" + variantName;
		for (const extension of ["js", "ts", "mjs", "cjs", "mts", "cts"]) {
			const configVariantPath = path.resolve(
				rootDir,
				`vite.config.${variantName}.${extension}`
			);
			if (fs.existsSync(configVariantPath)) {
				const res = await loadConfigFromFile(configEnv, configVariantPath);
				if (res) {
					config = res.config;
					break;
				}
			}
		}
	}
	// config file from test root dir
	if (!config) {
		const res = await loadConfigFromFile(configEnv, undefined, rootDir);
		if (res) {
			config = res.config;
		}
	}

	const options: InlineConfig = {
		cacheDir,
		root: rootDir,
		logLevel: "silent",
		configFile: false,
		server: {
			watch: {
				// During tests we edit the files too fast and sometimes chokidar
				// misses change events, so enforce polling for consistency
				usePolling: true,
				interval: 100,
			},
			fs: {
				strict: !isBuild,
			},
		},
		build: {
			// esbuild do not minify ES lib output since that would remove pure annotations and break tree-shaking
			// skip transpilation during tests to make it faster
			target: "esnext",
			// tests are flaky when `emptyOutDir` is `true`
			emptyOutDir: false,
		},
		customLogger: createInMemoryLogger(
			serverLogs.info,
			serverLogs.warns,
			serverLogs.errors
		),
	};
	return mergeConfig(options, config || {});
}

export async function startDefaultServe(): Promise<
	ViteDevServer | http.Server | PreviewServer
> {
	setupConsoleWarnCollector(serverLogs.warns);

	if (!isBuild) {
		process.env.VITE_INLINE = "inline-serve";
		const config = await loadConfig({ command: "serve", mode: "development" });
		viteServer = await (await createServer(config)).listen();
		viteTestUrl = viteServer.resolvedUrls!.local[0]!;
		if (viteServer.config.base === "/") {
			viteTestUrl = viteTestUrl.replace(/\/$/, "");
		}
		await page.goto(viteTestUrl);
		return viteServer;
	} else {
		process.env.VITE_INLINE = "inline-build";
		// determine build watch
		const resolvedPlugin: () => PluginOption = () => ({
			name: "vite-plugin-watcher",
			configResolved(config) {
				resolvedConfig = config;
			},
		});
		const buildConfig = mergeConfig(
			await loadConfig({
				command: "build",
				mode: "production",
			}),
			{
				plugins: [resolvedPlugin()],
			}
		);
		const builder = await createBuilder(buildConfig);
		await builder.buildApp();

		const previewConfig = await loadConfig({
			command: "serve",
			mode: "development",
			isPreview: true,
		});
		const _nodeEnv = process.env.NODE_ENV;
		// Make sure we are running from within the playground.
		// Otherwise workerd will error with messages about not being allowed to escape the starting directory with `..`.
		process.chdir(previewConfig.root);
		const previewServer = await preview(previewConfig);
		// prevent preview change NODE_ENV
		process.env.NODE_ENV = _nodeEnv;
		viteTestUrl = previewServer!.resolvedUrls!.local[0]!;
		if (previewServer.config.base === "/") {
			viteTestUrl = viteTestUrl.replace(/\/$/, "");
		}
		await page.goto(viteTestUrl);
		return previewServer;
	}
}

/**
 * Send the rebuild complete message in build watch
 */
export async function notifyRebuildComplete(
	watcher: Rollup.RollupWatcher
): Promise<Rollup.RollupWatcher> {
	let resolveFn: undefined | (() => void);
	const callback = (event: Rollup.RollupWatcherEvent): void => {
		if (event.code === "END") {
			resolveFn?.();
		}
	};
	watcher.on("event", callback);
	await new Promise<void>((resolve) => {
		resolveFn = resolve;
	});
	return watcher.off("event", callback);
}

export function createInMemoryLogger(
	info: string[],
	warns: string[],
	errors: string[]
): Logger {
	const loggedErrors = new WeakSet<Error | Rollup.RollupError>();
	const warnedMessages = new Set<string>();

	const logger: Logger = {
		hasWarned: false,
		hasErrorLogged: (err) => loggedErrors.has(err),
		clearScreen: () => {},
		info(msg) {
			info.push(msg);
		},
		warn(msg) {
			warns.push(msg);
			logger.hasWarned = true;
		},
		warnOnce(msg) {
			if (warnedMessages.has(msg)) return;
			warns.push(msg);
			logger.hasWarned = true;
			warnedMessages.add(msg);
		},
		error(msg, opts) {
			errors.push(msg);
			if (opts?.error) {
				loggedErrors.add(opts.error);
			}
		},
	};

	return logger;
}

function setupConsoleWarnCollector(logs: string[]) {
	const warn = console.warn;
	console.warn = (...args: unknown[]) => {
		logs.push(args.join(" "));
		return warn.call(console, ...args);
	};
}

export function slash(p: string): string {
	return p.replace(/\\/g, "/");
}

declare module "vitest" {
	export interface ProvidedContext {
		wsEndpoint: string;
	}
}
