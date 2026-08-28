import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PyodideSession } from "../src/session/PyodideSession";

/**
 * A stand-in for Pyodide covering only the surface PyodideSession touches. This is what
 * `initialize(pyodide)` exists for: the install ordering, the `emfs:` wheel handling and the error
 * extraction are all load-bearing and all testable without a WASM interpreter.
 */
interface RecordedInstall {
    spec: string;
    deps: boolean;
}

class FakePyodide {
    installs: RecordedInstall[] = [];

    loadedPackages: string[] = [];

    runPythonCalls: string[] = [];

    writtenFiles: string[] = [];

    createdDirectories: string[] = [];

    /** Value `_repl_last_error` resolves to; `null` means the run succeeded. */
    lastError: unknown = null;

    private stdout: ((text: string) => void) | null = null;

    globals = {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        store: new Map<string, any>(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        set: (name: string, value: any) => {
            this.globals.store.set(name, value);
        },
        get: (name: string) => {
            if (name === "_repl_last_error") return this.lastError;
            return this.globals.store.get(name);
        },
    };

    FS = {
        mkdirTree: (path: string) => this.createdDirectories.push(path),
        writeFile: (path: string) => this.writtenFiles.push(path),
    };

    setStdout({ batched }: { batched: (text: string) => void }) {
        this.stdout = batched;
    }

    // eslint-disable-next-line class-methods-use-this
    setStderr() {
        return undefined;
    }

    async loadPackage(packages: string[]) {
        this.loadedPackages.push(...packages);
    }

    pyimport(name: string) {
        assert.equal(name, "micropip");
        return {
            install: {
                callKwargs: async (spec: string, { deps }: { deps: boolean }) => {
                    this.installs.push({ spec, deps });
                },
            },
        };
    }

    /** JSON the completion helpers return; the real ones always hand back a JSON string. */
    completionsJson = "[]";

    signatureJson = '{"signature": "", "docstring": ""}';

    runPython(code: string) {
        this.runPythonCalls.push(code);
        if (code.startsWith("_repl_complete(")) return this.completionsJson;
        if (code.startsWith("_repl_describe(")) return this.signatureJson;
        return "";
    }

    async runPythonAsync(code: string) {
        this.runPythonCalls.push(code);
        // Stand in for the Python runner writing to stdout.
        this.stdout?.("printed by user code");
    }

    // eslint-disable-next-line class-methods-use-this
    toPy(value: unknown) {
        return value;
    }
}

const WHEEL = "example_package-1.0.0-py3-none-any.whl";

const makeSpec = () => ({
    indexUrl: "https://cdn.example/pyodide/v0.24.0/full/",
    loadPackages: ["numpy"],
    pypiPinnedPackages: ["sympy==1.12", "ase==3.25.0"],
    wheelFilenames: [WHEEL],
    postWheelPackages: ["mat3ra-made", "jedi==0.19.2"],
    wheelBaseUrl: "https://wheels.example/repl-wheels",
});

/** Minimal `fetch` stub: the session only reads `ok`, `status` and `arrayBuffer()`. */
function stubFetch(response: { ok: boolean; status?: number }) {
    const calls: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async (url: string, options: { cache?: string }) => {
        calls.push(`${url} cache=${options?.cache}`);
        return {
            ok: response.ok,
            status: response.status ?? 200,
            arrayBuffer: async () => new ArrayBuffer(8),
        };
    };
    return calls;
}

function deferredFetch() {
    const resolvers: Array<() => void> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async () => {
        await new Promise<void>((resolve) => resolvers.push(resolve));
        return {
            ok: true,
            status: 200,
            arrayBuffer: async () => new ArrayBuffer(8),
        };
    };
    return resolvers;
}

async function initializedSession(fake = new FakePyodide()) {
    const session = new PyodideSession(makeSpec());
    await session.initialize(fake);
    return { session, fake };
}

describe("PyodideSession.initialize", () => {
    it("installs pinned deps, then wheels, then post-wheel packages — in that order", async () => {
        stubFetch({ ok: true });
        const { fake, session } = await initializedSession();

        assert.deepEqual(
            fake.installs.map(({ spec }) => spec),
            [
                "sympy==1.12",
                "ase==3.25.0",
                "emfs:/tmp/pyodide_wheels/example_package-1.0.0-py3-none-any.whl",
                "mat3ra-made",
                "jedi==0.19.2",
            ],
        );
        session.dispose();
    });

    it("installs wheels with deps=False and everything else with deps=True", async () => {
        stubFetch({ ok: true });
        const { fake, session } = await initializedSession();

        const wheelInstall = fake.installs.find(({ spec }) => spec.startsWith("emfs:"));
        const pypiInstalls = fake.installs.filter(({ spec }) => !spec.startsWith("emfs:"));

        // deps=False is essential: these wheels exist because their transitive deps do not build
        // under Pyodide or conflict with the pinned set.
        assert.equal(wheelInstall?.deps, false);
        assert.ok(pypiInstalls.every(({ deps }) => deps === true));
        session.dispose();
    });

    it("always loads micropip alongside the spec's base packages", async () => {
        stubFetch({ ok: true });
        const { fake, session } = await initializedSession();

        assert.deepEqual(fake.loadedPackages, ["micropip", "numpy"]);
        session.dispose();
    });

    it("reuses versioned wheels from browser cache and installs them from the virtual FS", async () => {
        const fetchCalls = stubFetch({ ok: true });
        const { fake, session } = await initializedSession();

        // We fetch the body ourselves, so versioned wheel URLs can safely use the browser cache.
        assert.deepEqual(fetchCalls, [
            `https://wheels.example/repl-wheels/${WHEEL} cache=force-cache`,
        ]);
        assert.deepEqual(fake.createdDirectories, ["/tmp/pyodide_wheels"]);
        assert.deepEqual(fake.writtenFiles, [`/tmp/pyodide_wheels/${WHEEL}`]);
        session.dispose();
    });

    it("can stage wheels for a package-owned installer without installing them", async () => {
        const fetchCalls = stubFetch({ ok: true });
        const session = new PyodideSession({
            ...makeSpec(),
            wheelFilenames: [],
        });
        const fake = new FakePyodide();

        await session.initialize(fake);
        await session.stageWheels([WHEEL]);

        assert.deepEqual(fetchCalls, [
            `https://wheels.example/repl-wheels/${WHEEL} cache=force-cache`,
        ]);
        assert.deepEqual(fake.writtenFiles, [`/tmp/pyodide_wheels/${WHEEL}`]);
        assert.equal(fake.installs.some(({ spec }) => spec.includes(WHEEL)), false);
        session.dispose();
    });

    it("fetches independently staged wheels concurrently", async () => {
        const fetchResolvers = deferredFetch();
        const session = new PyodideSession({
            ...makeSpec(),
            wheelFilenames: [],
        });
        const fake = new FakePyodide();

        await session.initialize(fake);
        const staging = session.stageWheels(["first.whl", "second.whl"]);
        await new Promise((resolve) => setTimeout(resolve, 0));

        assert.equal(fetchResolvers.length, 2);
        fetchResolvers.forEach((resolve) => resolve());
        await staging;
        session.dispose();
    });

    it("fails loudly when a wheel cannot be fetched", async () => {
        stubFetch({ ok: false, status: 404 });
        const session = new PyodideSession(makeSpec());

        await assert.rejects(
            () => session.initialize(new FakePyodide()),
            /Failed to fetch wheel .*: HTTP 404/,
        );
        assert.equal(session.isInitialized, false);
        session.dispose();
    });

    it("rejects wheelFilenames given without a wheelBaseUrl", async () => {
        const session = new PyodideSession({ ...makeSpec(), wheelBaseUrl: undefined });

        await assert.rejects(
            () => session.initialize(new FakePyodide()),
            /wheelFilenames given without a wheelBaseUrl/,
        );
        session.dispose();
    });

    it("is idempotent — a second initialize does not reinstall", async () => {
        stubFetch({ ok: true });
        const { session, fake } = await initializedSession();
        const installCountAfterFirst = fake.installs.length;

        await session.initialize(fake);

        assert.equal(fake.installs.length, installCountAfterFirst);
        session.dispose();
    });

    it("refuses a second, differently-configured session — one interpreter per page", async () => {
        stubFetch({ ok: true });
        const { session: first } = await initializedSession();
        const second = new PyodideSession(makeSpec());

        await assert.rejects(
            () => second.initialize(new FakePyodide()),
            /already owned by another session/,
        );

        // ...and disposing the first hands ownership back, which is how tests (and env swaps) recover.
        first.dispose();
        await second.initialize(new FakePyodide());
        assert.equal(second.isInitialized, true);
        second.dispose();
    });
});

describe("PyodideSession.execute", () => {
    it("awaits beforeRun and afterRun around every user run", async () => {
        stubFetch({ ok: true });
        const events: string[] = [];
        const session = new PyodideSession({
            ...makeSpec(),
            beforeRun: () => {
                events.push("before");
            },
            afterRun: () => {
                events.push("after");
            },
        });
        const fake = new FakePyodide();
        const originalRun = fake.runPythonAsync.bind(fake);
        fake.runPythonAsync = async (code: string) => {
            events.push("execute");
            await originalRun(code);
        };
        await session.initialize(fake);

        await session.execute("1 + 1");

        assert.deepEqual(events, ["before", "execute", "after"]);
        session.dispose();
    });

    it("still runs afterRun when user code raises, so results are not lost", async () => {
        stubFetch({ ok: true });
        const events: string[] = [];
        const session = new PyodideSession({
            ...makeSpec(),
            afterRun: () => {
                events.push("after");
            },
        });
        const fake = new FakePyodide();
        fake.lastError = { ename: "ValueError", evalue: "boom", traceback: "..." };
        await session.initialize(fake);

        const result = await session.execute("raise ValueError('boom')");

        assert.equal(result.ok, false);
        assert.deepEqual(events, ["after"]);
        session.dispose();
    });

    it("runs setupNamespace once the environment is built, before reporting ready", async () => {
        stubFetch({ ok: true });
        const seen: boolean[] = [];
        const session = new PyodideSession({
            ...makeSpec(),
            setupNamespace: () => {
                seen.push(session.isInitialized);
            },
        });
        await session.initialize(new FakePyodide());

        assert.deepEqual(seen, [false], "setupNamespace must run before isInitialized flips");
        assert.equal(session.isInitialized, true);
        session.dispose();
    });

    it("returns ok with the buffered stdout when the run succeeds", async () => {
        stubFetch({ ok: true });
        const { session, fake } = await initializedSession();

        const result = await session.execute("print('hi')");

        assert.equal(result.ok, true);
        assert.equal(result.error, null);
        assert.match(result.output, /printed by user code/);
        // The code goes through a global, never interpolated into the Python source.
        assert.equal(fake.globals.store.get("_repl_src"), "print('hi')");
        session.dispose();
    });

    it("surfaces a user error as ename/evalue/traceback rather than throwing", async () => {
        stubFetch({ ok: true });
        const fake = new FakePyodide();
        const { session } = await initializedSession(fake);
        fake.lastError = {
            ename: "ValueError",
            evalue: "boom",
            traceback: "Traceback...\nValueError: boom\n",
        };

        const result = await session.execute("raise ValueError('boom')");

        assert.equal(result.ok, false);
        assert.equal(result.error?.ename, "ValueError");
        assert.equal(result.error?.evalue, "boom");
        session.dispose();
    });

    it("clears output between runs, so the console does not accumulate stale text", async () => {
        stubFetch({ ok: true });
        const { session } = await initializedSession();

        const first = await session.execute("print('one')");
        const second = await session.execute("print('two')");

        assert.equal(first.output, second.output);
        assert.equal(second.output.match(/printed by user code/g)?.length, 1);
        session.dispose();
    });

    it("throws before initialization instead of silently doing nothing", async () => {
        const session = new PyodideSession(makeSpec());

        await assert.rejects(() => session.execute("1"), /not initialized/);
        session.dispose();
    });
});

describe("PyodideSession completions", () => {
    it("passes source, line and column as globals, never interpolated into the source", async () => {
        stubFetch({ ok: true });
        const fake = new FakePyodide();
        fake.completionsJson = '[{"name": "create_supercell", "type": "function"}]';
        const { session } = await initializedSession(fake);

        const completions = session.complete("create_sup", 1, 10);

        assert.deepEqual(completions, [{ name: "create_supercell", type: "function" }]);
        assert.equal(fake.globals.store.get("_repl_c_src"), "create_sup");
        assert.equal(fake.globals.store.get("_repl_c_line"), 1);
        assert.equal(fake.globals.store.get("_repl_c_column"), 10);
        const lastCall = fake.runPythonCalls[fake.runPythonCalls.length - 1];
        assert.equal(lastCall, "_repl_complete(_repl_c_src, _repl_c_line, _repl_c_column)");
        session.dispose();
    });

    it("returns no completions before initialization rather than throwing at the editor", () => {
        const session = new PyodideSession(makeSpec());

        assert.deepEqual(session.complete("x", 1, 1), []);
        assert.equal(session.describe("x", 1, 1, "x"), null);
        session.dispose();
    });
});
