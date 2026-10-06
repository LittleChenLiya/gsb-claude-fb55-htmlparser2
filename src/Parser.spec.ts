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

describe("pause/resume", () => {
    it("should stop at the event boundary and only emit remaining events on resume", () => {
        const events: string[] = [];
        const p = new Parser({
            onopentag(name) {
                events.push(`opentag:${name}`);
                // Pause while the second of three tags in one chunk is delivered
                if (name === "b") p.pause();
            },
            onclosetag(name) {
                events.push(`closetag:${name}`);
            },
        });

        p.write("<a></a><b></b><c></c>");

        // Events up to and including the one that paused were delivered
        expect(events).toEqual(["opentag:a", "closetag:a", "opentag:b"]);
        expect(p.paused).toBe(true);

        p.resume();

        // Resume emitted exactly the remaining events, without re-sending the prefix
        expect(events).toEqual([
            "opentag:a",
            "closetag:a",
            "opentag:b",
            "closetag:b",
            "opentag:c",
            "closetag:c",
        ]);
        expect(p.paused).toBe(false);
    });

    it("should acknowledge pause requests explicitly", () => {
        const p = new Parser(null);

        // Not started yet: pause is accepted
        expect(p.pause()).toBe(true);
        expect(p.paused).toBe(true);
        p.resume();
        expect(p.paused).toBe(false);

        // After the input EOF completed, there is nothing left to pause
        p.end("<a></a>");
        expect(p.pause()).toBe(false);
    });

    it("should keep remaining input of the current chunk when pausing", () => {
        const events: string[] = [];
        const p = new Parser({
            ontext(data) {
                events.push(data);
                if (data === "one") p.pause();
            },
        });

        p.write("one<b>two</b>three");
        expect(events).toEqual(["one"]);

        // Writing while paused queues the input
        p.write("four");
        expect(events).toEqual(["one"]);

        p.resume();
        expect(events).toEqual(["one", "two", "three", "four"]);
        p.end();
    });

    it("should decode entities split across chunks as a single text", () => {
        const events: string[] = [];
        const p = new Parser({
            ontext(data) {
                events.push(data);
            },
        });

        p.write("a&am");
        p.write("p;b");
        p.end();

        // `&amp;` was split across chunks, but is delivered as one `&` text
        expect(events).toEqual(["a", "&", "b"]);
    });

    it("should continue entities across chunks when pausing in between", () => {
        const events: string[] = [];
        const p = new Parser({
            ontext(data) {
                events.push(data);
            },
        });

        p.write("x&am");
        p.pause();
        // The second half of the entity is queued while paused
        p.write("p;y");
        // The text before the entity is emitted once the entity resolves
        expect(events).toEqual([]);
        p.resume();
        p.end();

        expect(events).toEqual(["x", "&", "y"]);
    });

    it("should not complete early when end() is called in an event callback", () => {
        const events: string[] = [];
        const p = new Parser({
            onopentagname(name) {
                events.push(`opentagname:${name}`);
                if (name === "a") p.end();
            },
            onclosetag(name, isImplied) {
                events.push(`closetag:${name}:${isImplied}`);
            },
            onend() {
                events.push("end");
            },
        });

        p.write("<a><b><c>");

        // EOF was finalized only after the remaining events of the chunk
        expect(events).toEqual([
            "opentagname:a",
            "opentagname:b",
            "opentagname:c",
            "closetag:c:true",
            "closetag:b:true",
            "closetag:a:true",
            "end",
        ]);
    });

    it("should not call onend while paused, and only once", () => {
        const onend = vi.fn();
        const events: string[] = [];
        const p = new Parser({
            onopentagname(name) {
                events.push(name);
                if (name === "a") p.pause();
            },
            onend,
        });

        p.write("<a><b>");
        p.end();
        expect(onend).not.toHaveBeenCalled();

        p.resume();
        expect(events).toEqual(["a", "b"]);
        expect(onend).toHaveBeenCalledTimes(1);

        // A stray resume must not complete a second time
        p.resume();
        expect(onend).toHaveBeenCalledTimes(1);
    });

    it("should not share queued state between parser instances", () => {
        const eventsA: string[] = [];
        const eventsB: string[] = [];
        const a = new Parser({
            ontext(data) {
                eventsA.push(data);
                if (data === "a1") a.pause();
            },
        });
        const b = new Parser({
            ontext(data) {
                eventsB.push(data);
            },
        });

        a.write("a1<i>a2</i>");
        b.write("b1<i>b2</i>");
        b.end();

        // The paused instance kept its remaining input; the other is unaffected
        expect(eventsA).toEqual(["a1"]);
        expect(eventsB).toEqual(["b1", "b2"]);

        a.resume();
        a.end();
        expect(eventsA).toEqual(["a1", "a2"]);
    });

    it("should stay in a consistent state when a callback throws", () => {
        const events: string[] = [];
        const p = new Parser({
            onopentag(name) {
                events.push(`opentag:${name}`);
                if (name === "a") throw new Error("boom");
            },
            ontext(data) {
                events.push(`text:${data}`);
            },
        });

        // The error propagates to the caller of `write`
        expect(() => p.write("<a>t1<b>t2</b>")).toThrow("boom");
        expect(events).toEqual(["opentag:a"]);
        /*
         * The failed event was finalized: the parser sits at the event
         * boundary right after the `<a>` tag.
         */
        expect(p.startIndex).toBe(3);
        expect(p.endIndex).toBe(2);

        // Parsing continues at the event boundary; no event is delivered twice
        p.write("<c>t3</c>");
        p.end();
        expect(events).toEqual([
            "opentag:a",
            "text:t1",
            "opentag:b",
            "text:t2",
            "opentag:c",
            "text:t3",
        ]);
    });
});
