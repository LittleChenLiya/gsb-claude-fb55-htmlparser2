/**
 * Pause / resume example for htmlparser2.
 *
 * Run with Node.js:
 *
 * ```sh
 * npm run build && node examples/pause-resume.mjs
 * ```
 *
 * (The example imports the built package, so `npm run build` has to run first.)
 */
import { Parser } from "htmlparser2";

const events = [];
let parser;

parser = new Parser({
    onparserinit(p) {
        parser = p;
    },
    onopentagname(name) {
        events.push(`opentagname ${name}`);
        if (name === "b") {
            /*
             * Pause at the second event. `pause()` acknowledges the request
             * explicitly: it returns `true` if the parser was running and is
             * now paused, `false` if it was already paused.
             */
            console.log("pause acknowledged:", parser.pause());
        }
    },
    onopentag(name) {
        events.push(`opentag ${name}`);
    },
    ontext(text) {
        events.push(`text ${text}`);
    },
    onend() {
        events.push("end");
    },
});

// Three tags in a single chunk; the pause stops at the second event.
parser.write("<a><b><c>");
console.log("paused:", parser.paused, "| events so far:", events);

// Resume emits only the remaining events — no already-delivered event repeats.
parser.resume();
console.log("after resume:   ", events);

/*
 * Entities split across chunks continue across the boundary and are
 * delivered as a single text event once complete.
 */
parser.write("x&am");
parser.write("p;y");
console.log("after entity:   ", events);

// `end()` while paused does not complete early: no `end` event yet.
parser.pause();
parser.end("<d>");
console.log("end while paused:", events);

// `onend` fires once all retained input has been parsed after `resume()`.
parser.resume();
console.log("final events:   ", events);

