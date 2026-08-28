const UNKNOWN_MARKER = "\u{fffc}";


export const URL_RESOLUTION_STATE = Object.freeze({
    RESOLVED: "RESOLVED",
    PARTIALLY_RESOLVED: "PARTIALLY_RESOLVED",
    UNRESOLVED: "UNRESOLVED"
});


function stringComponent(value) {
    return {
        type: "STRING",
        value
    };
}


function mergeStrings(components) {
    const merged = [];

    for (const component of components) {
        const previous = merged.at(-1);

        if (component.type === "STRING" && previous?.type === "STRING") {
            previous.value += component.value;
        } else {
            merged.push({ ...component });
        }
    }

    return merged;
}


function normalizeOrigins(components) {
    const normalized = [];

    for (let index = 0; index < components.length; index++) {
        const first = components[index];
        const separator = components[index + 1];
        const host = components[index + 2];

        if (
            first?.type === "CURRENT_PROTOCOL" &&
            separator?.type === "STRING" &&
            separator.value === "//" &&
            ["CURRENT_HOST", "CURRENT_HOSTNAME"].includes(host?.type)
        ) {
            normalized.push({ type: "CURRENT_ORIGIN" });
            index += 2;
            continue;
        }

        if (
            first?.type === "STRING" &&
            /^(?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\/$/.test(first.value) &&
            ["CURRENT_HOST", "CURRENT_HOSTNAME"].includes(separator?.type)
        ) {
            normalized.push({ type: "CURRENT_ORIGIN" });
            index += 1;
            continue;
        }

        normalized.push(first);
    }

    return mergeStrings(normalized);
}


function unknownComponent(symbol) {
    return {
        type: "UNKNOWN",
        symbol
    };
}


export function evaluateUrlExpression(
    expression,
    {
        bindings = new Map(),
        helpers = new Map(),
        resolvingBindings = new Set(),
        resolvingHelpers = new Set()
    } = {}
) {
    if (!expression) {
        return {
            components: [unknownComponent("missing-expression")],
            unresolvedSymbols: ["missing-expression"]
        };
    }

    if (expression.type === "STRING") {
        return {
            components: [stringComponent(expression.value)],
            unresolvedSymbols: []
        };
    }

    if (expression.type === "LOCATION_VALUE") {
        return {
            components: [{ type: expression.valueType }],
            unresolvedSymbols: []
        };
    }

    if (expression.type === "IDENTIFIER") {
        if (!bindings.has(expression.name) || resolvingBindings.has(expression.name)) {
            return {
                components: [unknownComponent(expression.name)],
                unresolvedSymbols: [expression.name]
            };
        }

        const binding = bindings.get(expression.name);

        if (binding.components) {
            return binding;
        }

        resolvingBindings.add(expression.name);
        const evaluated = evaluateUrlExpression(binding, {
            bindings,
            helpers,
            resolvingBindings,
            resolvingHelpers
        });
        resolvingBindings.delete(expression.name);
        return evaluated;
    }

    if (expression.type === "CALL") {
        if (
            !helpers.has(expression.name) ||
            resolvingHelpers.has(expression.name)
        ) {
            return {
                components: [unknownComponent(`${expression.name}()`)],
                unresolvedSymbols: [`${expression.name}()`]
            };
        }

        resolvingHelpers.add(expression.name);
        const evaluated = evaluateUrlExpression(helpers.get(expression.name), {
            bindings,
            helpers,
            resolvingBindings,
            resolvingHelpers
        });
        resolvingHelpers.delete(expression.name);
        return evaluated;
    }

    if (expression.type === "CONCAT") {
        const components = [];
        const unresolvedSymbols = [];

        for (const part of expression.parts) {
            const evaluated = evaluateUrlExpression(part, {
                bindings,
                helpers,
                resolvingBindings,
                resolvingHelpers
            });
            components.push(...evaluated.components);
            unresolvedSymbols.push(...evaluated.unresolvedSymbols);
        }

        return {
            components: normalizeOrigins(mergeStrings(components)),
            unresolvedSymbols: [...new Set(unresolvedSymbols)]
        };
    }

    return {
        components: [unknownComponent(expression.raw ?? expression.type)],
        unresolvedSymbols: [expression.raw ?? expression.type]
    };
}


function componentText(component) {
    if (component.type === "STRING") {
        return component.value;
    }

    if (component.type === "CURRENT_ORIGIN") {
        return "<CURRENT_ORIGIN>";
    }

    return `<${component.type}${component.symbol ? `:${component.symbol}` : ""}>`;
}


function extractPathTemplate(template) {
    const scheme = template.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//);
    let authorityStart = null;

    if (scheme) {
        authorityStart = scheme[0].length;
    } else if (template.startsWith("//")) {
        authorityStart = 2;
    }

    if (authorityStart !== null) {
        let delimiter = -1;

        for (let index = authorityStart; index < template.length; index++) {
            if (["/", "?", "#"].includes(template[index])) {
                delimiter = index;
                break;
            }
        }

        if (delimiter < 0) {
            return "/";
        }

        if (template[delimiter] !== "/") {
            return `/${template.slice(delimiter)}`;
        }

        return template.slice(delimiter);
    }

    return template;
}


function splitPathQueryFragment(referenceTemplate) {
    const queryIndex = referenceTemplate.indexOf("?");
    const fragmentIndex = referenceTemplate.indexOf("#");
    const indexes = [queryIndex, fragmentIndex]
        .filter(index => index >= 0);
    const end = indexes.length > 0
        ? Math.min(...indexes)
        : referenceTemplate.length;

    return {
        pathnameTemplate: referenceTemplate.slice(0, end),
        suffixTemplate: referenceTemplate.slice(end)
    };
}


export function resolveUrlExpression(expression, options = {}) {
    const evaluated = evaluateUrlExpression(expression, options);
    let components = normalizeOrigins(evaluated.components);
    let origin = null;

    if (components[0]?.type === "CURRENT_ORIGIN") {
        origin = "CURRENT_ORIGIN";
        components = components.slice(1);
    }

    const template = components.map(component =>
        component.type === "STRING"
            ? component.value
            : UNKNOWN_MARKER
    ).join("");
    const displayComponents = evaluated.components.map(componentText);
    const firstUnknown = template.indexOf(UNKNOWN_MARKER);
    const lastUnknown = template.lastIndexOf(UNKNOWN_MARKER);
    const knownPrefix = firstUnknown >= 0
        ? template.slice(0, firstUnknown)
        : template;
    const knownSuffix = lastUnknown >= 0
        ? template.slice(lastUnknown + UNKNOWN_MARKER.length)
        : "";

    if (origin && template && !/^[/?#]/.test(template)) {
        return {
            state: URL_RESOLUTION_STATE.PARTIALLY_RESOLVED,
            pathname: null,
            origin,
            components: displayComponents,
            knownPrefix,
            knownSuffix,
            unresolvedSymbols: evaluated.unresolvedSymbols,
            reason: "ORIGIN_CONCATENATED_WITH_NON_ABSOLUTE_REFERENCE"
        };
    }

    const referenceTemplate = origin
        ? (template || "/")
        : extractPathTemplate(template);
    const { pathnameTemplate } = splitPathQueryFragment(referenceTemplate);

    if (!pathnameTemplate.includes(UNKNOWN_MARKER) && pathnameTemplate) {
        return {
            state: URL_RESOLUTION_STATE.RESOLVED,
            pathname: pathnameTemplate,
            origin,
            components: displayComponents,
            knownPrefix,
            knownSuffix,
            unresolvedSymbols: evaluated.unresolvedSymbols,
            reason: null
        };
    }

    const hasKnownPathMaterial = pathnameTemplate
        .replaceAll(UNKNOWN_MARKER, "")
        .length > 0;

    return {
        state: hasKnownPathMaterial
            ? URL_RESOLUTION_STATE.PARTIALLY_RESOLVED
            : URL_RESOLUTION_STATE.UNRESOLVED,
        pathname: null,
        origin,
        components: displayComponents,
        knownPrefix,
        knownSuffix,
        unresolvedSymbols: evaluated.unresolvedSymbols,
        reason: hasKnownPathMaterial
            ? "RUNTIME_VALUE_AFFECTS_PATHNAME"
            : "PATHNAME_NOT_STATICALLY_KNOWN"
    };
}
