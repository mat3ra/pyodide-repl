import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    type ReplHostConfig,
    createSessionFromConfig,
    DATA_FROM_HOST_GLOBAL,
} from "../src/config/hostConfig";

/**
 * The host's config is the page's ONLY domain knowledge, so these tests pin the mapping from
 * config to session lifecycle: which Python runs when, what the host's data is called inside
 * Python, and what comes back out.
 */
class FakePyodide {
    runPythonCalls: string[] = [];

    globalsSet = new Map<string, unknown>();

    /** What the next runPythonAsync resolves to; stands in for afterRunCode's value. */
    nextResult: unknown = undefined;

    globals = {
        set: (name: string, value: unknown) => {
            this.globalsSet.set(name, value);
        },
        get: (name: string) => (name === "_repl_last_error" ? null : this.globalsSet.get(name)),
    };

    FS = { mkdirTree: () => undefined, writeFile: () => undefined };

    // eslint-disable-next-line class-methods-use-this
    setStdout() {
        return undefined;
    }

    // eslint-disable-next-line class-methods-use-this
    setStderr() {
        return undefined;
    }

    // eslint-disable-next-line class-methods-use-this
    async loadPackage() {
        return undefined;
    }

    // eslint-disable-next-line class-methods-use-this
    pyimport() {
        return { install: { callKwargs: async () => undefined } };
    }

    runPython(code: string) {
        this.runPythonCalls.push(code);
        return "";
    }

    async runPythonAsync(code: string) {
        this.runPythonCalls.push(code);
        return this.nextResult;
    }
}

class FakeHost {
    sent: object[] = [];

    requests = 0;

    reply: { config?: ReplHostConfig; data?: unknown } = {};

    async requestFromHost() {
        this.requests += 1;
        return this.reply;
    }

    sendToHost(payload: object) {
        this.sent.push(payload);
    }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * PyodideSession enforces one interpreter per page, so every test must release its claim — hence a
 * helper that always disposes, even when an assertion throws.
 */
async function withSession(session: any, pyodide: FakePyodide, body: () => Promise<void>) {
    await session.initialize(pyodide as any);
    try {
        await body();
    } finally {
        session.dispose();
    }
}

describe("createSessionFromConfig", () => {
    it("runs the host's setupCode once, at initialization", async () => {
        const pyodide = new FakePyodide();
        const session = createSessionFromConfig(
            { setupCode: "import host_preamble" },
            new FakeHost(),
        );

        await withSession(session, pyodide, async () => {
            assert.ok(pyodide.runPythonCalls.includes("import host_preamble"));
        });
    });

    it("hands the host's data to Python as a JSON string, then runs beforeRunCode", async () => {
        const pyodide = new FakePyodide();
        const host = new FakeHost();
        host.reply = { data: { materials: [{ name: "Si" }], selectedIndex: 0 } };
        const session = createSessionFromConfig({ beforeRunCode: "bind()" }, host);

        await withSession(session, pyodide, async () => {
            await session.execute("1 + 1");

            assert.equal(
                pyodide.globalsSet.get(DATA_FROM_HOST_GLOBAL),
                '{"materials":[{"name":"Si"}],"selectedIndex":0}',
            );
            assert.ok(pyodide.runPythonCalls.includes("bind()"));
        });
    });

    it("asks the host again for every run, so data cannot go stale", async () => {
        const pyodide = new FakePyodide();
        const host = new FakeHost();
        host.reply = { data: { n: 1 } };
        const session = createSessionFromConfig({ beforeRunCode: "bind()" }, host);

        await withSession(session, pyodide, async () => {
            await session.execute("first");
            await session.execute("second");

            assert.equal(host.requests, 2);
        });
    });

    it("parses afterRunCode's JSON string and sends the host the object its Python built", async () => {
        const pyodide = new FakePyodide();
        const host = new FakeHost();
        const session = createSessionFromConfig({ afterRunCode: "scan()" }, host);

        await withSession(session, pyodide, async () => {
            pyodide.nextResult = '{"syncScope":"python-repl","entities":[]}';
            await session.execute("run");

            assert.deepEqual(host.sent, [{ syncScope: "python-repl", entities: [] }]);
        });
    });

    it("sends nothing when afterRunCode evaluates to nothing", async () => {
        const pyodide = new FakePyodide();
        const host = new FakeHost();
        const session = createSessionFromConfig({ afterRunCode: "scan()" }, host);

        await withSession(session, pyodide, async () => {
            pyodide.nextResult = undefined;
            await session.execute("run");

            assert.deepEqual(host.sent, []);
        });
    });

    it("runs no host Python at all when the config is empty — a bare Python REPL", async () => {
        const pyodide = new FakePyodide();
        const host = new FakeHost();
        const session = createSessionFromConfig({}, host);

        await withSession(session, pyodide, async () => {
            await session.execute("1 + 1");

            assert.equal(host.requests, 1, "still asks for data, in case the host pushes some");
            assert.deepEqual(host.sent, []);
        });
    });
});
