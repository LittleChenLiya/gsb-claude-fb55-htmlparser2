import { describe, expect, it, vi } from "vitest";
import type { Handler } from "./Parser.js";
import { Parser } from "./Parser.js";

describe("Pause / resume", () => {
    it("should acknowledge pause requests explicitly", () => {
        const p = new Parser(null);

        expect(p.paused).toBe(false);
        // The pause is acknowledged: the parser was running.
        expect(p.pause()).toBe(true);
        expect(p.paused).toBe(true);
        // A repeated pause is not acknowledged again.
        expect(p.pause()).toBe(false);
        expect(p.paused).toBe(true);

        p.resume();
        expect(p.paused).toBe(false);
        expect(p.pause()).toBe(true);
        p.resume();
        p.end();
    });

    it("should stop at the boundary of the delivered event and only emit remaining events on resume", () => {
        const events: string[] = [];
        let p!: Parser;
        const cbs: Partial<Handler> = {
            onparserinit(parser) {
                p = parser;
            },
            onopentagname(name) {
                events.push(`opentagname:${name}`);
                if (name === "b") {
                    // Pause at the second event; the rest of the chunk is retained.
                    expect(p.pause()).toBe(true);
                }
            },
            onopentag(name) {
                events.push(`opentag:${name}`);
            },
        };
        p = new Parser(cbs);

        // Three tags in a single chunk; pause at the second event.
        p.write("<a><b><c>");

        /*
         * The pause stopped parsing at the event boundary: `onopentag` for
         * `b` has not fired yet, and nothing from `<c>` has been emitted.
         */
        expect(events).toEqual(["opentagname:a", "opentag:a", "opentagname:b"]);
        expect(p.paused).toBe(true);

        // Resume emits only the remaining events; no prefix is re-emitted.
        p.resume();
        expect(events).toEqual([
            "opentagname:a",
            "opentag:a",
            "opentagname:b",
            "opentag:b",
            "opentagname:c",
            "opentag:c",
        ]);

        p.end();
    });

    it("should retain the rest of the current chunk and chunks written while paused", () => {
        const events: string[] = [];
        let p!: Parser;
        p = new Parser({
            onparserinit(parser) {
                p = parser;
            },
            ontext(text) {
                events.push(text);
                p.pause();
            },
        });

        p.write("one<b>two");
        expect(events).toEqual(["one"]);

        // Written while paused; must be parsed after the retained input.
        p.write("<c>three");

        p.resume();
        /*
         * `two` is emitted after `<b>` was parsed, then the pause from the
         * `two` event stops parsing again before `three`.
         */
        expect(events).toEqual(["one", "two"]);

        p.resume();
        expect(events).toEqual(["one", "two", "three"]);
        p.end();
    });

    it("should emit an entity split across chunks as a single text event", () => {
        const ontext = vi.fn();
        const p = new Parser({ ontext });

        p.write("&am");
        p.write("p;");
        p.end();

        // `&amp;` arrives as exactly one text event, not as fragments.
        expect(ontext).toHaveBeenCalledTimes(1);
        expect(ontext).toHaveBeenLastCalledWith("&");
    });

    it("should continue entities across chunks when paused in between", () => {
        const texts: string[] = [];
        const p = new Parser({
            ontext(text) {
                texts.push(text);
            },
        });

        p.write("a&am");
        p.pause();
        p.write("p;");

        // Nothing is emitted while paused.
        expect(texts).toEqual([]);

        p.resume();
        p.end();

        // The entity decoder state survived the pause: one `&` text event.
        expect(texts).toEqual(["a", "&"]);
    });

    it("should not complete on EOF while paused", () => {
        const events: string[] = [];
        let p!: Parser;
        p = new Parser({
            onparserinit(parser) {
                p = parser;
            },
            onopentagname(name) {
                events.push(name);
                if (name === "b") p.pause();
            },
            onend() {
                events.push("END");
            },
        });

        p.write("<a><b>");
        // EOF is signaled while paused; it must not complete early.
        p.end("<c>");
        expect(events).toEqual(["a", "b"]);

        // Resume parses the retained input and the final chunk, then ends.
        p.resume();
        expect(events).toEqual(["a", "b", "c", "END"]);
    });

    it("should settle end() called from within an event callback after the current chunk", () => {
        const events: string[] = [];
        let p!: Parser;
        p = new Parser({
            onparserinit(parser) {
                p = parser;
            },
            onopentagname(name) {
                events.push(`open:${name}`);
                if (name === "a") p.end();
            },
            ontext(text) {
                events.push(`text:${text}`);
            },
            onend() {
                events.push("END");
            },
        });

        p.write("<a>tail");

        // The rest of the chunk was parsed before `onend` fired, exactly once.
        expect(events).toEqual(["open:a", "text:tail", "END"]);

        p.resume();
        expect(events.filter((event) => event === "END")).toHaveLength(1);
    });

    it("should parse chunks passed to end() within a callback after the current chunk", () => {
        const events: string[] = [];
        let p!: Parser;
        p = new Parser({
            onparserinit(parser) {
                p = parser;
            },
            onopentagname(name) {
                events.push(name);
                if (name === "a") p.end("<b>");
            },
            onend() {
                events.push("END");
            },
        });

        p.write("<a>");

        // `<b>` was queued behind the chunk currently being parsed.
        expect(events).toEqual(["a", "b", "END"]);
    });

    it("should not share staging state between parser instances", () => {
        const first: string[] = [];
        const second: string[] = [];
        const p1 = new Parser({
            ontext(text) {
                first.push(text);
            },
        });
        const p2 = new Parser({
            ontext(text) {
                second.push(text);
            },
        });

        p1.write("one&am");
        p2.write("two&am");

        p1.pause();
        // The second instance completes its entity independently.
        p2.write("p;");
        // Buffered on the first instance while paused.
        p1.write("p;");

        expect(first).toEqual([]);
        expect(second).toEqual(["two", "&"]);

        p1.resume();
        p1.end();
        p2.end();

        expect(first).toEqual(["one", "&"]);
        expect(second).toEqual(["two", "&"]);
    });

    it("should be left in an incomplete state when a callback throws, and recover on reset", () => {
        let shouldThrow = true;
        const names: string[] = [];
        const p = new Parser({
            onopentagname(name) {
                if (shouldThrow) throw new Error("boom");
                names.push(name);
            },
        });

        // The error propagates; the parser is left mid-chunk (incomplete).
        expect(() => p.write("<a><b>")).toThrow("boom");

        // After a reset, the parser is usable again.
        shouldThrow = false;
        p.reset();
        p.end("<a><b>");
        expect(names).toEqual(["a", "b"]);
    });

    it("should keep default callbacks and parsing modes working with pause/resume", () => {
        // No callbacks at all, XML mode.
        const p = new Parser(null, { xmlMode: true });
        p.pause();
        p.write("<a/>");
        expect(p.paused).toBe(true);
        p.resume();
        p.end();
        expect(p.paused).toBe(false);

        // Self-closing tags are still recognized in XML mode after a pause.
        const events: string[] = [];
        const xmlParser = new Parser(
            {
                onopentagname(name) {
                    events.push(`open:${name}`);
                    xmlParser.pause();
                },
                onclosetag(name) {
                    events.push(`close:${name}`);
                },
            },
            { xmlMode: true },
        );
        xmlParser.write("<a/><b/>");
        expect(events).toEqual(["open:a"]);
        xmlParser.resume();
        expect(events).toEqual(["open:a", "close:a", "open:b"]);
        xmlParser.resume();
        xmlParser.end();
        expect(events).toEqual(["open:a", "close:a", "open:b", "close:b"]);
    });
});
