import assert from "node:assert/strict";
import test from "node:test";
import { buildSymbolFacts } from "../src/symbols/symbol_facts.mjs";


function analyze(source) {
    const facts = buildSymbolFacts(source, "fixture.js");
    assert.equal(facts.parseError, null);
    return facts;
}


function variablesNamed(facts, name) {
    return facts.scopes.flatMap(scope =>
        scope.variables
            .filter(variable => variable.name === name)
            .map(variable => ({ scope, variable }))
    );
}


function onlyVariable(facts, name) {
    const matches = variablesNamed(facts, name);
    assert.equal(matches.length, 1, `expected one binding named ${name}`);
    return matches[0];
}


test("var declared in an if includes a read later in the same block", () => {
    const { variable } = onlyVariable(analyze(`
        if (cond) {
            var x = 1;
            use(x);
        }
    `), "x");

    assert.equal(variable.reads, 1);
    assert.equal(variable.writes, 0);
    assert.equal(variable.references.length, 1);
});


test("var binding includes a read from a nested if block", () => {
    const { variable } = onlyVariable(analyze(`
        if (cond) {
            var x = 1;

            if (other) {
                use(x);
            }
        }
    `), "x");

    assert.equal(variable.reads, 1);
    assert.equal(variable.references.length, 1);
});


test("realDone-style reads remain resolved after direct eval", () => {
    const { variable } = onlyVariable(analyze(`
        function update(responseText) {
            eval(responseText);

            if (cond) {
                var realDone = total - remain;

                if (realDone > current) {
                    current = realDone;
                }
            }
        }
    `), "realDone");

    assert.equal(variable.definitions.length, 1);
    assert.equal(variable.reads, 2);
    assert.equal(variable.writes, 0);
    assert.equal(variable.references.length, 2);
});


test("var remains function-scoped when declared inside a block", () => {
    const { scope, variable } = onlyVariable(analyze(`
        function f() {
            if (cond) {
                var x = 1;
            }

            use(x);
        }
    `), "x");

    assert.equal(scope.type, "function");
    assert.equal(variable.reads, 1);
    assert.equal(variable.references.length, 1);
});


test("let remains block-scoped and does not capture an outside use", () => {
    const facts = analyze(`
        function f() {
            if (cond) {
                let x = 1;
                use(x);
            }

            use(x);
        }
    `);
    const { scope, variable } = onlyVariable(facts, "x");
    const unresolvedOutsideReads = facts.globalThrough.filter(reference =>
        reference.name === "x" && reference.read
    );

    assert.equal(scope.type, "block");
    assert.equal(variable.reads, 1);
    assert.equal(variable.references.length, 1);
    assert.equal(unresolvedOutsideReads.length, 1);
});


test("nested shadowing assigns each read to its resolved lexical binding", () => {
    const facts = analyze(`
        function f() {
            let x = 1;

            if (cond) {
                let x = 2;
                use(x);
            }

            use(x);
        }
    `);
    const bindings = variablesNamed(facts, "x");

    assert.equal(bindings.length, 2);
    assert.deepEqual(
        bindings.map(({ variable }) => variable.reads).sort(),
        [1, 1]
    );
    assert(bindings.every(({ variable }) =>
        variable.references.length === 1
    ));
});


test("member property names do not reference a same-name variable", () => {
    const { variable } = onlyVariable(analyze(`
        var x = 1;
        obj.x = 2;
    `), "x");

    assert.equal(variable.reads, 0);
    assert.equal(variable.writes, 0);
    assert.equal(variable.references.length, 0);
});


test("an explicit assignment remains write-only without a fabricated read", () => {
    const { variable } = onlyVariable(analyze(`
        var x;
        x = foo();
    `), "x");

    assert.equal(variable.reads, 0);
    assert.equal(variable.writes, 1);
    assert.equal(variable.references.length, 1);
    assert.equal(variable.references[0].read, false);
    assert.equal(variable.references[0].write, true);
});


test("resolved references are not duplicated across nested scope traversal", () => {
    const { variable } = onlyVariable(analyze(`
        function f() {
            var x = 1;

            if (one) {
                if (two) {
                    use(x);
                }
            }
        }
    `), "x");

    assert.equal(variable.reads, 1);
    assert.equal(variable.references.length, 1);
});
