import { describe, expect, it } from "vitest";
import { Tokenizer } from "./index.js";
import { Parser } from "./Parser.js";
import type { Callbacks } from "./Tokenizer.js";

interface TextEvent {
    text: string;
    startIndex: number;
    endIndex: number;
}

/**
 * Collect text events with their source ranges. Ranges use absolute UTF-16
 * code unit indices; `endIndex` is inclusive (matching `parser.endIndex`).
 * @param input
 * @param chunks
 */
function collectTextEvents(input: string, chunks?: string[]): TextEvent[] {
    const events: TextEvent[] = [];
    let parser: Parser;
    const instance = new Parser({
        onparserinit(p) {
            parser = p;
        },
        ontext(data) {
            events.push({
                text: data,
                startIndex: parser.startIndex,
                endIndex: parser.endIndex,
            });
        },
    });

    if (chunks) {
        for (const chunk of chunks) instance.write(chunk);
        instance.end();
    } else {
        instance.end(input);
    }

    return events;
}

/**
 * Collect text events with the input written byte by byte.
 * @param input
 */
function collectTextEventsBytewise(input: string): TextEvent[] {
    return collectTextEvents(input, [...input]);
}

/**
 * Collect text events with the input split into two chunks at `split`.
 * @param input
 * @param split
 */
function collectTextEventsSplit(input: string, split: number): TextEvent[] {
    return collectTextEvents(input, [
        input.slice(0, split),
        input.slice(split),
    ]);
}

function tokenize(input: string, chunks?: string[]): unknown[][] {
    const log: unknown[][] = [];
    const tokenizer = new Tokenizer(
        {},
        new Proxy(
            { isInForeignContext: () => false },
            {
                get(target, property) {
                    if (property === "isInForeignContext") {
                        return target.isInForeignContext;
                    }
                    return (...values: unknown[]) =>
                        log.push([property, ...values]);
                },
            },
        ) as Callbacks,
    );

    if (chunks) {
        for (const chunk of chunks) tokenizer.write(chunk);
        tokenizer.end();
    } else {
        tokenizer.write(input);
        tokenizer.end();
    }

    return log;
}

describe("Entity source mapping", () => {
    it("maps a decoded entity to its complete source range", () => {
        const input = "a&amp;b";
        const events = collectTextEvents(input);

        // Decoded text output is unchanged.
        expect(events.map((event) => event.text).join("")).toBe("a&b");
        expect(events).toEqual([
            { text: "a", startIndex: 0, endIndex: 0 },
            // The single decoded `&` covers the whole `&amp;` source.
            { text: "&", startIndex: 1, endIndex: 5 },
            { text: "b", startIndex: 6, endIndex: 6 },
        ]);

        const entity = events[1];
        expect(input.slice(entity.startIndex, entity.endIndex + 1)).toBe(
            "&amp;",
        );
    });

    it("produces the identical mapping for byte-by-byte input", () => {
        const input = "a&amp;b";
        const whole = collectTextEvents(input);

        expect(collectTextEventsBytewise(input)).toEqual(whole);

        // Entities split across two chunks at every possible position.
        for (let split = 0; split <= input.length; split++) {
            expect(collectTextEventsSplit(input, split)).toEqual(whole);
        }
    });

    it("maps three consecutive entities to absolute ranges", () => {
        const input = "&lt;&amp;&gt;";
        const expected: TextEvent[] = [
            { text: "<", startIndex: 0, endIndex: 3 },
            { text: "&", startIndex: 4, endIndex: 8 },
            { text: ">", startIndex: 9, endIndex: 12 },
        ];

        expect(collectTextEvents(input)).toEqual(expected);
        expect(collectTextEventsBytewise(input)).toEqual(expected);

        const texts = ["<", "&", ">"];
        const sources = ["&lt;", "&amp;", "&gt;"];
        for (const [index, event] of expected.entries()) {
            expect(event.text).toBe(texts[index]);
            expect(input.slice(event.startIndex, event.endIndex + 1)).toBe(
                sources[index],
            );
        }
    });

    it("maps entities inside RCDATA tags", () => {
        const input = "<title>&amp;</title>";
        const events = collectTextEvents(input);

        expect(events).toEqual([{ text: "&", startIndex: 7, endIndex: 11 }]);
        expect(collectTextEventsBytewise(input)).toEqual(events);
    });

    it("maps multi-codepoint entities to the same full range", () => {
        const input = "&NotGreaterFullEqual;";
        const events = collectTextEvents(input);

        /*
         * Decodes to U+2267 U+0338, emitted as two code points that both
         * cover the complete entity source.
         */
        expect(events).toEqual([
            { text: "≧", startIndex: 0, endIndex: 20 },
            { text: "̸", startIndex: 0, endIndex: 20 },
        ]);
        expect(events.map((event) => event.text).join("")).toBe("≧̸");
        expect(collectTextEventsBytewise(input)).toEqual(events);
    });

    it("maps non-BMP numeric entities to their source range", () => {
        const input = "&#x1D306;";
        expect(collectTextEvents(input)).toEqual([
            { text: "\u{1D306}", startIndex: 0, endIndex: 8 },
        ]);
    });

    it("keeps invalid entities as plain text", () => {
        expect(collectTextEvents("M&M")).toEqual([
            { text: "M&M", startIndex: 0, endIndex: 2 },
        ]);
        expect(collectTextEvents("a&;b")).toEqual([
            { text: "a&;b", startIndex: 0, endIndex: 3 },
        ]);
        expect(collectTextEvents("&#x;")).toEqual([
            { text: "&#x;", startIndex: 0, endIndex: 3 },
        ]);
    });

    it("gives attribute entities independent positions", () => {
        const input = '<a href="x&amp;y">z</a>';
        let value: string | undefined;
        let ranges: { startIndex: number; endIndex: number }[] = [];
        const parser = new Parser({
            onattribute(_name, attributeValue) {
                value = attributeValue;
                ranges = parser.attribEntityRanges.map((range) => ({
                    ...range,
                }));
            },
        });

        parser.end(input);

        expect(value).toBe("x&y");
        expect(ranges).toEqual([{ startIndex: 10, endIndex: 14 }]);
        expect(input.slice(10, 15)).toBe("&amp;");
    });

    it("maps three entities inside an attribute value", () => {
        const input = '<a href="&lt;&amp;&gt;">';
        let ranges: { startIndex: number; endIndex: number }[] = [];
        const parser = new Parser({
            onattribute() {
                ranges = parser.attribEntityRanges.map((range) => ({
                    ...range,
                }));
            },
        });

        for (const char of input) parser.write(char);
        parser.end();

        expect(ranges).toEqual([
            { startIndex: 9, endIndex: 12 },
            { startIndex: 13, endIndex: 17 },
            { startIndex: 18, endIndex: 21 },
        ]);
        expect(
            ranges.map(({ startIndex, endIndex }) =>
                input.slice(startIndex, endIndex + 1),
            ),
        ).toEqual(["&lt;", "&amp;", "&gt;"]);
    });

    it("resets attribute entity ranges for every attribute", () => {
        const input = '<a x="&amp;" y="plain" z="&lt;">';
        const seen: { startIndex: number; endIndex: number }[][] = [];
        const parser = new Parser({
            onattribute() {
                seen.push(parser.attribEntityRanges.map((r) => ({ ...r })));
            },
        });

        parser.end(input);

        expect(seen).toEqual([
            [{ startIndex: 6, endIndex: 10 }],
            [],
            [{ startIndex: 26, endIndex: 29 }],
        ]);
    });

    it("keeps invalid attribute entities out of the ranges", () => {
        const input = '<a href="&;&amp">';
        let value: string | undefined;
        let ranges: { startIndex: number; endIndex: number }[] = [];
        const parser = new Parser({
            onattribute(_name, attributeValue) {
                value = attributeValue;
                ranges = parser.attribEntityRanges.map((r) => ({ ...r }));
            },
        });

        parser.end(input);

        /*
         * `&;` is not an entity and stays plain text; `&amp` is a legacy
         * attribute entity without a semicolon.
         */
        expect(value).toBe("&;&");
        expect(ranges).toEqual([{ startIndex: 11, endIndex: 14 }]);
    });

    it("reports explicit ranges at the tokenizer level", () => {
        const input = '<a b="&amp;">x&amp;';
        const log = tokenize(input);

        expect(log).toContainEqual(["onattribentity", 38, 6, 11]);
        expect(log).toContainEqual(["ontext", 13, 14]);
        expect(log).toContainEqual(["ontextentity", 38, 14, 19]);
    });

    it("reports absolute ranges for entities split across chunks", () => {
        const whole = tokenize("xy&amp;z");
        const split = tokenize("xy&amp;z", ["xy&am", "p;z"]);

        expect(split).toEqual(whole);
        expect(whole).toContainEqual(["ontext", 0, 2]);
        expect(whole).toContainEqual(["ontextentity", 38, 2, 7]);
        expect(whole).toContainEqual(["ontext", 7, 8]);
    });
});
