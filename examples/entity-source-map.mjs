/**
 * Demo: explicit source ranges for decoded entities.
 *
 * Run with:  npm run build && node examples/entity-source-map.mjs
 *
 * All ranges are absolute UTF-16 code unit indices into the input string
 * (the same unit as `String.prototype.slice`), stable across `write()`
 * chunk boundaries. A single decoded character can map to multiple source
 * code units, so ranges are reported explicitly instead of being shifted
 * by the decoded output length.
 */
import { Parser } from "../dist/index.js";

// Three entity forms that all decode to `&`, plus an attribute entity.
const input = `<p title="a&amp;b">&amp;&#38;&#x26;</p>`;

const parser = new Parser({
    ontext(data) {
        // `startIndex`/`endIndex` (inclusive end) point at the source of
        // this event; for entities that is the complete entity.
        console.log(
            `text ${JSON.stringify(data)} <- [${parser.startIndex}, ${
                parser.endIndex + 1
            }) ${JSON.stringify(
                input.slice(parser.startIndex, parser.endIndex + 1),
            )}`,
        );
    },
    onattribute(name, value) {
        // Attribute entities have independent positions.
        const ranges = parser.attribEntityRanges.map(
            ({ start, end }) => `[${start}, ${end}) ${JSON.stringify(input.slice(start, end))}`,
        );
        console.log(
            `attr ${name}=${JSON.stringify(value)} entities: ${ranges.join(", ")}`,
        );
    },
});

// Feeding the input byte by byte yields the same mapping.
for (let index = 0; index < input.length; index++) {
    parser.write(input.charAt(index));
}
parser.end();
