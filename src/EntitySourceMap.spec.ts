import { describe, expect, it } from "vitest";
import { type EntitySourceRange, Parser } from "./index.js";

interface TextEvent {
    data: string;
    startIndex: number;
    endIndex: number;
    entity: boolean;
}

interface AttributeEvent {
    name: string;
    value: string;
    entityRanges: EntitySourceRange[];
}

/** Parser that flags text events originating from a decoded entity. */
class CollectingParser extends Parser {
    isEntityEvent = false;

    override ontextentity(
        cp: number,
        startIndex: number,
        endIndex: number,
    ): void {
        this.isEntityEvent = true;
        super.ontextentity(cp, startIndex, endIndex);
        this.isEntityEvent = false;
    }
}

/**
 * Collect text events with the parser's `startIndex` / `endIndex` at the
 * time of the event, plus attribute events with their entity source ranges.
 *
 * Adjacent plain-text fragments are merged (chunk boundaries split them up
 * arbitrarily); entity events are always emitted atomically and keep their
 * explicit source range no matter how the input is chunked.
 * @param input
 * @param write
 */
function collect(
    input: string,
    write: (parser: Parser, input: string) => void,
): { text: TextEvent[]; attributes: AttributeEvent[] } {
    const text: TextEvent[] = [];
    const attributes: AttributeEvent[] = [];
    const parser = new CollectingParser({
        ontext(data) {
            const last = text.at(-1);
            if (
                last &&
                !last.entity &&
                !parser.isEntityEvent &&
                last.endIndex + 1 === parser.startIndex
            ) {
                last.data += data;
                last.endIndex = parser.endIndex;
                return;
            }
            text.push({
                data,
                startIndex: parser.startIndex,
                endIndex: parser.endIndex,
                entity: parser.isEntityEvent,
            });
        },
        onattribute(name, value) {
            attributes.push({
                name,
                value,
                entityRanges: parser.attribEntityRanges.map((range) => ({
                    ...range,
                })),
            });
        },
    });
    write(parser, input);
    parser.end();
    return { text, attributes };
}

/**
 * Parse the input in a single `write` call.
 * @param input
 */
function parseWhole(input: string) {
    return collect(input, (parser, data) => parser.write(data));
}

/**
 * Parse the input one byte (UTF-16 code unit) at a time.
 * @param input
 */
function parseBytewise(input: string) {
    return collect(input, (parser, data) => {
        for (let index = 0; index < data.length; index++) {
            parser.write(data.charAt(index));
        }
    });
}

describe("Entity source map", () => {
    it("maps a decoded text entity to the complete entity source range", () => {
        const input = "a&amp;b";
        const { text } = parseWhole(input);

        // Default text output is unchanged.
        expect(text.map((event) => event.data)).toEqual(["a", "&", "b"]);
        expect(text.map((event) => event.data).join("")).toBe("a&b");

        /*
         * `&` points at the complete `&amp;` entity, not at a position
         * shifted by the decoded output length.
         */
        const entity = text[1];
        expect(entity.entity).toBe(true);
        expect(entity.startIndex).toBe(1);
        expect(entity.endIndex).toBe(5);
        expect(input.slice(entity.startIndex, entity.endIndex + 1)).toBe(
            "&amp;",
        );

        // Plain fragments keep their absolute ranges.
        expect(input.slice(text[0].startIndex, text[0].endIndex + 1)).toBe("a");
        expect(input.slice(text[2].startIndex, text[2].endIndex + 1)).toBe("b");
    });

    it("reports explicit ranges for three entity forms decoding to `&`", () => {
        const input = "&amp;&#38;&#x26;";
        const { text } = parseWhole(input);

        expect(text.map((event) => event.data)).toEqual(["&", "&", "&"]);
        expect(text.every((event) => event.entity)).toBe(true);
        expect(
            text.map((event) =>
                input.slice(event.startIndex, event.endIndex + 1),
            ),
        ).toEqual(["&amp;", "&#38;", "&#x26;"]);
        // The ranges are contiguous and absolute.
        expect(text.map((event) => event.startIndex)).toEqual([0, 5, 10]);
        expect(text.map((event) => event.endIndex)).toEqual([4, 9, 15]);
    });

    it("produces identical mappings for bytewise input", () => {
        const inputs = [
            "a&amp;b",
            "&amp;&#38;&#x26;",
            '<a href="x&amp;y" title="&#65;&#x42;">t&hellip;</a>',
            "cross&am\np;chunk",
        ];

        for (const input of inputs) {
            expect(parseBytewise(input)).toEqual(parseWhole(input));
        }
    });

    it("keeps absolute ranges for entities spanning chunk boundaries", () => {
        const input = "ab&amp;&#x26;cd";
        const chunked = collect(input, (parser, data) => {
            // Split inside both entities.
            parser.write(data.slice(0, 4));
            parser.write(data.slice(4, 9));
            parser.write(data.slice(9));
        });

        expect(chunked).toEqual(parseWhole(input));
        expect(
            chunked.text.map((event) =>
                input.slice(event.startIndex, event.endIndex + 1),
            ),
        ).toEqual(["ab", "&amp;", "&#x26;", "cd"]);
    });
});

describe("Entity source map (attributes and edge cases)", () => {
    it("gives attribute entities independent positions", () => {
        const input = '<a href="x&amp;y" title="&#65;B">t</a>';
        const { attributes } = parseWhole(input);

        expect(attributes).toHaveLength(2);

        expect(attributes[0].name).toBe("href");
        expect(attributes[0].value).toBe("x&y");
        expect(attributes[0].entityRanges).toEqual([{ start: 10, end: 15 }]);
        expect(input.slice(10, 15)).toBe("&amp;");

        expect(attributes[1].name).toBe("title");
        expect(attributes[1].value).toBe("AB");
        expect(attributes[1].entityRanges).toEqual([{ start: 25, end: 30 }]);
        expect(input.slice(25, 30)).toBe("&#65;");
    });

    it("resets attribute entity ranges per attribute", () => {
        const input = '<a href="&amp;" data-x="plain" title="&amp;">t</a>';
        const { attributes } = parseWhole(input);

        expect(attributes.map((attribute) => attribute.entityRanges)).toEqual([
            [{ start: 9, end: 14 }],
            [],
            [{ start: 38, end: 43 }],
        ]);
    });

    it("handles invalid entities as before, without entity ranges", () => {
        const input = 'a&fake;b<c d="e&nope;f">&amp</c>';
        const whole = parseWhole(input);
        const bytewise = parseBytewise(input);

        // Invalid entities stay plain text; results are identical bytewise.
        expect(bytewise).toEqual(whole);
        expect(whole.text.map((event) => event.data).join("")).toBe(
            "a&fake;b&",
        );
        expect(whole.attributes[0].value).toBe("e&nope;f");
        expect(whole.attributes[0].entityRanges).toEqual([]);

        // The legacy `&amp` entity without semicolon still gets its range.
        const legacy = whole.text.at(-1);
        expect(legacy).toBeDefined();
        expect(legacy?.data).toBe("&");
        expect(legacy?.entity).toBe(true);
        expect(
            input.slice(legacy?.startIndex ?? 0, (legacy?.endIndex ?? 0) + 1),
        ).toBe("&amp");
    });

    it("maps multi-codepoint entities to a single shared source range", () => {
        // `&nLt;` decodes to two code points (U+226A U+20D2).
        const input = "x&nLt;y";
        const { text } = parseWhole(input);

        expect(text.map((event) => event.data)).toEqual([
            "x",
            "\u{226A}",
            "\u{20D2}",
            "y",
        ]);
        expect(text[1].startIndex).toBe(1);
        expect(text[1].endIndex).toBe(5);
        expect(text[2].startIndex).toBe(1);
        expect(text[2].endIndex).toBe(5);
        expect(input.slice(1, 6)).toBe("&nLt;");
    });

    it("maps astral entities to UTF-16 code unit source ranges", () => {
        // U+1D306 is a single code point encoded as two UTF-16 code units.
        const input = "&#x1D306;&amp;";
        const { text } = parseWhole(input);

        expect(text.map((event) => event.data)).toEqual(["\u{1D306}", "&"]);
        expect(text[0].startIndex).toBe(0);
        expect(text[0].endIndex).toBe(8);
        expect(input.slice(0, 9)).toBe("&#x1D306;");
        expect(text[1].startIndex).toBe(9);
        expect(text[1].endIndex).toBe(13);
    });
});
