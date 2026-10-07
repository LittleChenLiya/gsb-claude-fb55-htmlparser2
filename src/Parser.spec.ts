import { describe, expect, it, vi } from "vitest";
import { Parser, Tokenizer } from "./index.js";
import type { Handler } from "./Parser.js";

describe("API", () => {
    it("should work without callbacks", () => {
        const cbs: Partial<Handler> = { onerror: vi.fn() };
        const p = new Parser(cbs, {
            xmlMode: true,
            lowerCaseAttributeNames: true,
        });

        p.end("<a foo><bar></a><!-- --><![CDATA[]]]><?foo?><!bar><boo/>boohay");
        p.write("foo");

        // Check for an error
        p.end();
        p.write("foo");
        expect(cbs.onerror).toHaveBeenLastCalledWith(
            new Error(".write() after done!"),
        );
        p.end();
        expect(cbs.onerror).toHaveBeenLastCalledWith(
            new Error(".end() after done!"),
        );

        // Should ignore the error if there is no callback
        delete cbs.onerror;
        p.write("foo");

        p.reset();

        // Remove method
        cbs.onopentag = vi.fn();
        p.write("<a foo");
        delete cbs.onopentag;
        p.write(">");

        // Pause/resume
        const onText = vi.fn();
        cbs.ontext = onText;
        p.pause();
        p.write("foo");
        expect(onText).not.toHaveBeenCalled();
        p.resume();
        expect(onText).toHaveBeenLastCalledWith("foo");
        p.pause();
        expect(onText).toHaveBeenCalledTimes(1);
        p.resume();
        expect(onText).toHaveBeenCalledTimes(1);
        p.pause();
        p.end("bar");
        expect(onText).toHaveBeenCalledTimes(1);
        p.resume();
        expect(onText).toHaveBeenCalledTimes(2);
        expect(onText).toHaveBeenLastCalledWith("bar");
    });

    it("should back out of numeric entities (#125)", () => {
        const onend = vi.fn();
        let text = "";
        const p = new Parser({
            ontext(data) {
                text += data;
            },
            onend,
        });

        p.end("id=770&#anchor");

        expect(onend).toHaveBeenCalledTimes(1);
        expect(text).toBe("id=770&#anchor");

        p.reset();
        text = "";

        p.end("0&#xn");

        expect(onend).toHaveBeenCalledTimes(2);
        expect(text).toBe("0&#xn");
    });

    it("should not have the start index be greater than the end index", () => {
        const onopentag = vi.fn();
        const onclosetag = vi.fn();

        const p = new Parser({
            onopentag(tag) {
                expect(p.startIndex).toBeLessThanOrEqual(p.endIndex);
                onopentag(tag, p.startIndex, p.endIndex);
            },
            onclosetag(tag) {
                expect(p.startIndex).toBeLessThanOrEqual(p.endIndex);
                onclosetag(tag, p.endIndex);
            },
        });

        p.write("<p>");

        expect(onopentag).toHaveBeenLastCalledWith("p", 0, 2);
        expect(onclosetag).not.toHaveBeenCalled();

        p.write("Foo");

        p.write("<hr>");

        expect(onopentag).toHaveBeenLastCalledWith("hr", 6, 9);
        expect(onclosetag).toHaveBeenCalledTimes(2);
        expect(onclosetag).toHaveBeenNthCalledWith(1, "p", 9);
        expect(onclosetag).toHaveBeenNthCalledWith(2, "hr", 9);
    });

    it("should preserve declaration names outside of HTML mode", () => {
        const onprocessinginstruction = vi.fn();

        new Parser(
            {
                onprocessinginstruction,
            },
            { xmlMode: true },
        ).end("<!DOCTYPEhtml>");

        expect(onprocessinginstruction).toHaveBeenCalledWith(
            "!DOCTYPEhtml",
            "!DOCTYPEhtml",
        );
    });

    it("should preserve declaration casing when lowerCaseTags is disabled", () => {
        const onprocessinginstruction = vi.fn();

        new Parser(
            {
                onprocessinginstruction,
            },
            { lowerCaseTags: false },
        ).end("<!DOCTYPEhtml>");

        expect(onprocessinginstruction).toHaveBeenCalledWith(
            "!DOCTYPE",
            "!DOCTYPEhtml",
        );
    });

    it("should update the position when a single tag is spread across multiple chunks", () => {
        let called = false;
        const p = new Parser({
            onopentag() {
                called = true;
                expect(p.startIndex).toBe(0);
                expect(p.endIndex).toBe(12);
            },
        });

        p.write("<div ");
        p.write("foo=bar>");

        expect(called).toBe(true);
    });

    it("should have the correct position for implied opening tags", () => {
        let called = false;
        const p = new Parser({
            onopentag() {
                called = true;
                expect(p.startIndex).toBe(0);
                expect(p.endIndex).toBe(3);
            },
        });

        p.write("</p>");
        expect(called).toBe(true);
    });

    it("should parse <__proto__> (#387)", () => {
        const p = new Parser(null);

        // Should not throw
        p.write("<__proto__>");
    });

    it("should implicitly close table sections when another section opens", () => {
        const onopentagname = vi.fn();
        const onclosetag = vi.fn();

        // <tbody> must auto-close <tfoot>
        new Parser({ onopentagname, onclosetag }).end(
            "<table><tfoot><tr><td>F<tbody><tr><td>B</table>",
        );

        expect(onclosetag).toHaveBeenCalledWith("tfoot", true);
        const tfootClose = onclosetag.mock.calls.findIndex(
            ([name]) => name === "tfoot",
        );
        const tbodyOpen = onopentagname.mock.calls.findIndex(
            ([name]) => name === "tbody",
        );
        expect(tfootClose).toBeLessThan(tbodyOpen);
    });

    it("should implicitly close <tbody> when <thead> opens", () => {
        const onopentagname = vi.fn();
        const onclosetag = vi.fn();

        new Parser({ onopentagname, onclosetag }).end(
            "<table><tbody><tr><td>B<thead><tr><th>H</table>",
        );

        expect(onclosetag).toHaveBeenCalledWith("tbody", true);
        const tbodyClose = onclosetag.mock.calls.findIndex(
            ([name]) => name === "tbody",
        );
        const theadOpen = onopentagname.mock.calls.findIndex(
            ([name]) => name === "thead",
        );
        expect(tbodyClose).toBeLessThan(theadOpen);
    });

    it("should implicitly close <td> when <th> opens", () => {
        const onclosetag = vi.fn();
        const onopentagname = vi.fn();

        new Parser({ onclosetag, onopentagname }).end(
            "<table><tr><td>A<th>B</tr></table>",
        );

        // <th> must auto-close <td>, making them siblings per the HTML spec
        expect(onclosetag).toHaveBeenCalledWith("td", true);
        const tdClose = onclosetag.mock.calls.findIndex(
            ([name]) => name === "td",
        );
        const thOpen = onopentagname.mock.calls.findIndex(
            ([name]) => name === "th",
        );
        expect(tdClose).toBeLessThan(thOpen);
    });

    it("should support custom tokenizer", () => {
        class CustomTokenizer extends Tokenizer {}

        const p = new Parser(
            {
                onparserinit(parser: Parser) {
                    // @ts-expect-error Accessing private tokenizer here
                    expect(parser.tokenizer).toBeInstanceOf(CustomTokenizer);
                },
            },
            { Tokenizer: CustomTokenizer },
        );
        p.end();
    });
});

/**
 * In-memory fixture recording every `write`/`end`/`reset` call plus the
 * events emitted by the parser, so tests can assert on exact counts.
 * @param options
 * @param options.strictLifecycle
 */
function createRecorder(options?: { strictLifecycle: boolean }) {
    const events: string[] = [];
    const parser = new Parser(
        {
            ontext: (data) => events.push(`text:${data}`),
            onopentag: (name) => events.push(`opentag:${name}`),
            onend: () => events.push("onend"),
            onreset: () => events.push("onreset"),
            onerror: (error) => events.push(`onerror:${error.message}`),
        },
        options,
    );
    return {
        events,
        parser,
        write(chunk: string) {
            events.push(`write:${chunk}`);
            parser.write(chunk);
        },
        end(chunk?: string) {
            events.push("end");
            parser.end(chunk);
        },
        reset() {
            events.push("reset");
            parser.reset();
        },
    };
}

describe("lifecycle", () => {
    it("should throw on write after end in strict mode without emitting events", () => {
        const fixture = createRecorder({ strictLifecycle: true });

        fixture.write("<b>bold");
        fixture.end("</b>");

        const eventsAfterEnd = fixture.events.length;
        expect(() => fixture.write("late")).toThrow(
            new Error(".write() after done!"),
        );
        /*
         * The failed write must not trigger any parser events; only the
         * recorded call itself was added to the log.
         */
        expect(fixture.events.length).toBe(eventsAfterEnd + 1);
        expect(fixture.events).toStrictEqual([
            "write:<b>bold",
            "opentag:b",
            "text:bold",
            "end",
            "onend",
            "write:late",
        ]);
    });

    it("should not emit onend twice for repeated end calls in strict mode", () => {
        const fixture = createRecorder({ strictLifecycle: true });

        fixture.end("<i>x</i>");
        expect(() => fixture.end()).toThrow(new Error(".end() after done!"));
        expect(() => fixture.end("ignored")).toThrow(
            new Error(".end() after done!"),
        );

        expect(
            fixture.events.filter((event) => event === "onend"),
        ).toHaveLength(1);
        expect(fixture.events).toStrictEqual([
            "end",
            "opentag:i",
            "text:x",
            "onend",
            "end",
            "end",
        ]);
    });

    it("should allow a new document after reset in strict mode", () => {
        const fixture = createRecorder({ strictLifecycle: true });

        fixture.end("<a>first</a>");
        fixture.reset();
        fixture.write("<b>second</b>");
        fixture.end();

        expect(fixture.events).toStrictEqual([
            "end",
            "opentag:a",
            "text:first",
            "onend",
            "reset",
            "onreset",
            "write:<b>second</b>",
            "opentag:b",
            "text:second",
            "end",
            "onend",
        ]);
        expect(
            fixture.events.filter((event) => event === "onend"),
        ).toHaveLength(2);
    });

    it("should keep lenient behavior by default for write/end after done", () => {
        const fixture = createRecorder();

        fixture.end("<b>bold</b>");
        const eventsAfterEnd = fixture.events.length;

        // Late write/end calls report via onerror and emit no other events.
        fixture.write("late");
        fixture.end();
        fixture.end("also late");

        expect(
            fixture.events.filter((event) => event === "onend"),
        ).toHaveLength(1);
        expect(
            fixture.events.filter((event) => event.startsWith("onerror:")),
        ).toStrictEqual([
            "onerror:.write() after done!",
            "onerror:.end() after done!",
            "onerror:.end() after done!",
        ]);
        // No text/opentag events were emitted for the late input.
        expect(
            fixture.events
                .slice(eventsAfterEnd)
                .filter(
                    (event) =>
                        event.startsWith("text:") ||
                        event.startsWith("opentag:"),
                ),
        ).toHaveLength(0);

        // Reset still allows a new document in the default mode.
        fixture.reset();
        fixture.end("<i>next</i>");
        expect(
            fixture.events.filter((event) => event === "onend"),
        ).toHaveLength(2);
        expect(fixture.events.at(-2)).toBe("text:next");
    });
});
