/**
 * Word Expansion with Glob Handling
 *
 * Handles the main word expansion flow including:
 * - Brace expansion
 * - Array and positional parameter expansion
 * - Word splitting
 * - Glob/pathname expansion
 */
import { GlobExpander } from "../../shell/glob.js";
import { GlobError } from "../errors.js";
import { getIfs, getIfsSeparator, isIfsEmpty, splitByIfsForExpansion, } from "../helpers/ifs.js";
import { analyzeWordParts } from "./analysis.js";
import { handleArrayPatternRemoval, handleArrayPatternReplacement, } from "./array-pattern-ops.js";
import { handleArrayDefaultValue, handleArrayPatternWithPrefixSuffix, handleArrayWithPrefixSuffix, } from "./array-prefix-suffix.js";
import { handleArraySlicing, handleArrayTransform, } from "./array-slice-transform.js";
import { handleNamerefArrayExpansion, handleSimpleArrayExpansion, } from "./array-word-expansion.js";
import { hasGlobPattern, unescapeGlobPattern } from "./glob-escape.js";
import { handleIndirectArrayExpansion, handleIndirectInAlternative, handleIndirectionWithInnerAlternative, } from "./indirect-expansion.js";
import { getVarNamesWithPrefix } from "./pattern-removal.js";
import { handlePositionalPatternRemoval, handlePositionalPatternReplacement, handlePositionalSlicing, handleSimplePositionalExpansion, } from "./positional-params.js";
import { handleUnquotedArrayKeys, handleUnquotedArrayPatternRemoval, handleUnquotedArrayPatternReplacement, handleUnquotedPositionalPatternRemoval, handleUnquotedPositionalSlicing, handleUnquotedPositionalWithPrefixSuffix, handleUnquotedSimpleArray, handleUnquotedSimplePositional, handleUnquotedVarNamePrefix, } from "./unquoted-expansion.js";
import { getArrayElements } from "./variable.js";
/**
 * Main word expansion function that handles all expansion types and glob matching.
 */
export async function expandWordWithGlobImpl(ctx, word, deps) {
    const wordParts = word.parts;
    const { hasQuoted, hasCommandSub, hasArrayVar, hasArrayAtExpansion, hasParamExpansion, hasVarNamePrefixExpansion, hasIndirection, } = analyzeWordParts(wordParts);
    // Handle brace expansion first (produces multiple values)
    const hasBraces = deps.hasBraceExpansion(wordParts);
    const braceExpanded = hasBraces
        ? await deps.expandWordWithBracesAsync(ctx, word)
        : null;
    if (braceExpanded && braceExpanded.length > 1) {
        return handleBraceExpansionResults(ctx, braceExpanded, hasQuoted);
    }
    // Handle array expansion special cases
    const arrayResult = await handleArrayExpansionCases(ctx, wordParts, hasArrayAtExpansion, hasVarNamePrefixExpansion, hasIndirection, deps);
    if (arrayResult !== null) {
        return arrayResult;
    }
    // Handle positional parameter expansion special cases
    const positionalResult = await handlePositionalExpansionCases(ctx, wordParts, deps);
    if (positionalResult !== null) {
        return positionalResult;
    }
    // Handle unquoted expansion special cases
    const unquotedResult = await handleUnquotedExpansionCases(ctx, wordParts, deps);
    if (unquotedResult !== null) {
        return unquotedResult;
    }
    // Handle mixed word parts with word-producing expansions
    const mixedWordResult = await expandMixedWordParts(ctx, wordParts, deps.expandPart);
    if (mixedWordResult !== null) {
        return applyGlobToValues(ctx, mixedWordResult);
    }
    // Word splitting based on IFS
    if ((hasCommandSub || hasArrayVar || hasParamExpansion) &&
        !isIfsEmpty(ctx.state.env)) {
        const ifsChars = getIfs(ctx.state.env);
        const ifsPattern = deps.buildIfsCharClassPattern(ifsChars);
        const splitResult = await deps.smartWordSplit(ctx, wordParts, ifsChars, ifsPattern, deps.expandPart);
        return applyGlobToValues(ctx, splitResult);
    }
    const value = await deps.expandWordAsync(ctx, word);
    return handleFinalGlobExpansion(ctx, word, wordParts, value, hasQuoted, deps.expandWordForGlobbing);
}
/**
 * Handle brace expansion results with glob expansion
 */
async function handleBraceExpansionResults(ctx, braceExpanded, hasQuoted) {
    const allValues = [];
    for (const value of braceExpanded) {
        if (!hasQuoted && value === "") {
            continue;
        }
        if (!hasQuoted &&
            !ctx.state.options.noglob &&
            hasGlobPattern(value, ctx.state.shoptOptions.extglob)) {
            const matches = await expandGlobPattern(ctx, value);
            allValues.push(...matches);
        }
        else {
            allValues.push(value);
        }
    }
    return { values: allValues, quoted: false };
}
/**
 * Handle array expansion special cases
 */
async function handleArrayExpansionCases(ctx, wordParts, hasArrayAtExpansion, hasVarNamePrefixExpansion, hasIndirection, deps) {
    // Simple array expansion "${a[@]}"
    if (hasArrayAtExpansion) {
        const simpleArrayResult = handleSimpleArrayExpansion(ctx, wordParts);
        if (simpleArrayResult !== null) {
            return simpleArrayResult;
        }
    }
    // Nameref pointing to array[@]
    {
        const namerefArrayResult = handleNamerefArrayExpansion(ctx, wordParts);
        if (namerefArrayResult !== null) {
            return namerefArrayResult;
        }
    }
    // Array default/alternative values
    {
        const arrayDefaultResult = await handleArrayDefaultValue(ctx, wordParts);
        if (arrayDefaultResult !== null) {
            return arrayDefaultResult;
        }
    }
    // Array pattern with prefix/suffix
    {
        const arrayPatternPrefixSuffixResult = await handleArrayPatternWithPrefixSuffix(ctx, wordParts, hasArrayAtExpansion, deps.expandPart, deps.expandWordPartsAsync);
        if (arrayPatternPrefixSuffixResult !== null) {
            return arrayPatternPrefixSuffixResult;
        }
    }
    // Array with prefix/suffix
    {
        const arrayPrefixSuffixResult = await handleArrayWithPrefixSuffix(ctx, wordParts, hasArrayAtExpansion, deps.expandPart);
        if (arrayPrefixSuffixResult !== null) {
            return arrayPrefixSuffixResult;
        }
    }
    // Array slicing
    {
        const arraySlicingResult = await handleArraySlicing(ctx, wordParts, deps.evaluateArithmetic);
        if (arraySlicingResult !== null) {
            return arraySlicingResult;
        }
    }
    // Array transform operations
    {
        const arrayTransformResult = handleArrayTransform(ctx, wordParts);
        if (arrayTransformResult !== null) {
            return arrayTransformResult;
        }
    }
    // Array pattern replacement
    {
        const arrayPatReplResult = await handleArrayPatternReplacement(ctx, wordParts, deps.expandWordPartsAsync, deps.expandPart);
        if (arrayPatReplResult !== null) {
            return arrayPatReplResult;
        }
    }
    // Array pattern removal
    {
        const arrayPatRemResult = await handleArrayPatternRemoval(ctx, wordParts, deps.expandWordPartsAsync, deps.expandPart);
        if (arrayPatRemResult !== null) {
            return arrayPatRemResult;
        }
    }
    // Variable name prefix expansion
    if (hasVarNamePrefixExpansion &&
        wordParts.length === 1 &&
        wordParts[0].type === "DoubleQuoted") {
        const result = handleVarNamePrefixExpansion(ctx, wordParts);
        if (result !== null) {
            return result;
        }
    }
    // Indirect array expansion
    {
        const indirectArrayResult = await handleIndirectArrayExpansion(ctx, wordParts, hasIndirection, deps.expandParameterAsync, deps.expandWordPartsAsync);
        if (indirectArrayResult !== null) {
            return indirectArrayResult;
        }
    }
    // Indirect in alternative
    {
        const indirectInAltResult = await handleIndirectInAlternative(ctx, wordParts);
        if (indirectInAltResult !== null) {
            return indirectInAltResult;
        }
    }
    // Indirection with inner alternative
    {
        const indirectionWithInnerResult = await handleIndirectionWithInnerAlternative(ctx, wordParts);
        if (indirectionWithInnerResult !== null) {
            return indirectionWithInnerResult;
        }
    }
    return null;
}
/**
 * Handle variable name prefix expansion inside double quotes
 */
function handleVarNamePrefixExpansion(ctx, wordParts) {
    const dqPart = wordParts[0];
    if (dqPart.type !== "DoubleQuoted")
        return null;
    // Handle "${!prefix@}" and "${!prefix*}"
    if (dqPart.parts.length === 1 &&
        dqPart.parts[0].type === "ParameterExpansion" &&
        dqPart.parts[0].operation?.type === "VarNamePrefix") {
        const op = dqPart.parts[0].operation;
        const matchingVars = getVarNamesWithPrefix(ctx, op.prefix);
        if (op.star) {
            return {
                values: [matchingVars.join(getIfsSeparator(ctx.state.env))],
                quoted: true,
            };
        }
        return { values: matchingVars, quoted: true };
    }
    // Handle "${!arr[@]}" and "${!arr[*]}"
    if (dqPart.parts.length === 1 &&
        dqPart.parts[0].type === "ParameterExpansion" &&
        dqPart.parts[0].operation?.type === "ArrayKeys") {
        const op = dqPart.parts[0].operation;
        const elements = getArrayElements(ctx, op.array);
        const keys = elements.map(([k]) => String(k));
        if (op.star) {
            return {
                values: [keys.join(getIfsSeparator(ctx.state.env))],
                quoted: true,
            };
        }
        return { values: keys, quoted: true };
    }
    return null;
}
/**
 * Handle positional parameter expansion special cases
 */
async function handlePositionalExpansionCases(ctx, wordParts, deps) {
    // Positional slicing
    {
        const positionalSlicingResult = await handlePositionalSlicing(ctx, wordParts, deps.evaluateArithmetic, deps.expandPart);
        if (positionalSlicingResult !== null) {
            return positionalSlicingResult;
        }
    }
    // Positional pattern replacement
    {
        const positionalPatReplResult = await handlePositionalPatternReplacement(ctx, wordParts, deps.expandPart, deps.expandWordPartsAsync);
        if (positionalPatReplResult !== null) {
            return positionalPatReplResult;
        }
    }
    // Positional pattern removal
    {
        const positionalPatRemResult = await handlePositionalPatternRemoval(ctx, wordParts, deps.expandPart, deps.expandWordPartsAsync);
        if (positionalPatRemResult !== null) {
            return positionalPatRemResult;
        }
    }
    // Simple positional expansion
    {
        const simplePositionalResult = await handleSimplePositionalExpansion(ctx, wordParts, deps.expandPart);
        if (simplePositionalResult !== null) {
            return simplePositionalResult;
        }
    }
    return null;
}
/**
 * Handle unquoted expansion special cases
 */
async function handleUnquotedExpansionCases(ctx, wordParts, deps) {
    // Unquoted array pattern replacement
    {
        const unquotedArrayPatReplResult = await handleUnquotedArrayPatternReplacement(ctx, wordParts, deps.expandWordPartsAsync, deps.expandPart);
        if (unquotedArrayPatReplResult !== null) {
            return unquotedArrayPatReplResult;
        }
    }
    // Unquoted array pattern removal
    {
        const unquotedArrayPatRemResult = await handleUnquotedArrayPatternRemoval(ctx, wordParts, deps.expandWordPartsAsync, deps.expandPart);
        if (unquotedArrayPatRemResult !== null) {
            return unquotedArrayPatRemResult;
        }
    }
    // Unquoted positional pattern removal
    {
        const unquotedPosPatRemResult = await handleUnquotedPositionalPatternRemoval(ctx, wordParts, deps.expandWordPartsAsync, deps.expandPart);
        if (unquotedPosPatRemResult !== null) {
            return unquotedPosPatRemResult;
        }
    }
    // Unquoted positional slicing
    {
        const unquotedSliceResult = await handleUnquotedPositionalSlicing(ctx, wordParts, deps.evaluateArithmetic, deps.expandPart);
        if (unquotedSliceResult !== null) {
            return unquotedSliceResult;
        }
    }
    // Unquoted simple positional
    {
        const unquotedSimplePositionalResult = await handleUnquotedSimplePositional(ctx, wordParts);
        if (unquotedSimplePositionalResult !== null) {
            return unquotedSimplePositionalResult;
        }
    }
    // Unquoted simple array
    {
        const unquotedSimpleArrayResult = await handleUnquotedSimpleArray(ctx, wordParts);
        if (unquotedSimpleArrayResult !== null) {
            return unquotedSimpleArrayResult;
        }
    }
    // Unquoted variable name prefix
    {
        const unquotedVarNamePrefixResult = handleUnquotedVarNamePrefix(ctx, wordParts);
        if (unquotedVarNamePrefixResult !== null) {
            return unquotedVarNamePrefixResult;
        }
    }
    // Unquoted array keys
    {
        const unquotedArrayKeysResult = handleUnquotedArrayKeys(ctx, wordParts);
        if (unquotedArrayKeysResult !== null) {
            return unquotedArrayKeysResult;
        }
    }
    // Unquoted positional with prefix/suffix
    {
        const unquotedPrefixSuffixResult = await handleUnquotedPositionalWithPrefixSuffix(ctx, wordParts, deps.expandPart);
        if (unquotedPrefixSuffixResult !== null) {
            return unquotedPrefixSuffixResult;
        }
    }
    return null;
}
/**
 * Find word-producing expansion in a part
 */
function findWordProducingExpansion(part) {
    if (part.type !== "DoubleQuoted")
        return null;
    for (let i = 0; i < part.parts.length; i++) {
        const inner = part.parts[i];
        if (inner.type !== "ParameterExpansion")
            continue;
        if (inner.operation)
            continue;
        const arrayMatch = inner.parameter.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[([@*])\]$/);
        if (arrayMatch) {
            return {
                type: "array",
                name: arrayMatch[1],
                atIndex: i,
                isStar: arrayMatch[2] === "*",
            };
        }
        if (inner.parameter === "@" || inner.parameter === "*") {
            return {
                type: "positional",
                atIndex: i,
                isStar: inner.parameter === "*",
            };
        }
    }
    return null;
}
/**
 * Expand a DoubleQuoted part with word-producing expansion
 */
async function expandDoubleQuotedWithWordProducing(ctx, part, info, expandPart) {
    let prefix = "";
    for (let i = 0; i < info.atIndex; i++) {
        prefix += await expandPart(ctx, part.parts[i]);
    }
    let suffix = "";
    for (let i = info.atIndex + 1; i < part.parts.length; i++) {
        suffix += await expandPart(ctx, part.parts[i]);
    }
    let values;
    if (info.type === "array") {
        const elements = getArrayElements(ctx, info.name);
        values = elements.map(([, v]) => v);
        if (values.length === 0) {
            const scalarValue = ctx.state.env[info.name];
            if (scalarValue !== undefined) {
                values = [scalarValue];
            }
        }
    }
    else {
        const numParams = Number.parseInt(ctx.state.env["#"] || "0", 10);
        values = [];
        for (let i = 1; i <= numParams; i++) {
            values.push(ctx.state.env[String(i)] || "");
        }
    }
    if (info.isStar) {
        const ifsSep = getIfsSeparator(ctx.state.env);
        const joined = values.join(ifsSep);
        return [prefix + joined + suffix];
    }
    if (values.length === 0) {
        const combined = prefix + suffix;
        return combined ? [combined] : [];
    }
    if (values.length === 1) {
        return [prefix + values[0] + suffix];
    }
    return [
        prefix + values[0],
        ...values.slice(1, -1),
        values[values.length - 1] + suffix,
    ];
}
/**
 * Expand mixed word parts with word-producing expansions
 */
async function expandMixedWordParts(ctx, wordParts, expandPart) {
    if (wordParts.length < 2)
        return null;
    let hasWordProducing = false;
    for (const part of wordParts) {
        if (findWordProducingExpansion(part)) {
            hasWordProducing = true;
            break;
        }
    }
    if (!hasWordProducing)
        return null;
    const ifsChars = getIfs(ctx.state.env);
    const ifsEmpty = isIfsEmpty(ctx.state.env);
    const partWords = [];
    for (const part of wordParts) {
        const wpInfo = findWordProducingExpansion(part);
        if (wpInfo && part.type === "DoubleQuoted") {
            const words = await expandDoubleQuotedWithWordProducing(ctx, part, wpInfo, expandPart);
            partWords.push(words);
        }
        else if (part.type === "DoubleQuoted" || part.type === "SingleQuoted") {
            const value = await expandPart(ctx, part);
            partWords.push([value]);
        }
        else if (part.type === "Literal") {
            partWords.push([part.value]);
        }
        else if (part.type === "ParameterExpansion") {
            const value = await expandPart(ctx, part);
            if (ifsEmpty) {
                partWords.push(value ? [value] : []);
            }
            else {
                const split = splitByIfsForExpansion(value, ifsChars);
                partWords.push(split);
            }
        }
        else {
            const value = await expandPart(ctx, part);
            if (ifsEmpty) {
                partWords.push(value ? [value] : []);
            }
            else {
                const split = splitByIfsForExpansion(value, ifsChars);
                partWords.push(split);
            }
        }
    }
    const result = [];
    for (const words of partWords) {
        if (words.length === 0) {
            continue;
        }
        if (result.length === 0) {
            result.push(...words);
        }
        else {
            const lastIdx = result.length - 1;
            result[lastIdx] = result[lastIdx] + words[0];
            for (let j = 1; j < words.length; j++) {
                result.push(words[j]);
            }
        }
    }
    return result;
}
/**
 * Apply glob expansion to values
 */
async function applyGlobToValues(ctx, values) {
    if (ctx.state.options.noglob) {
        return { values, quoted: false };
    }
    const expandedValues = [];
    for (const v of values) {
        if (hasGlobPattern(v, ctx.state.shoptOptions.extglob)) {
            const matches = await expandGlobPattern(ctx, v);
            expandedValues.push(...matches);
        }
        else {
            expandedValues.push(v);
        }
    }
    return { values: expandedValues, quoted: false };
}
/**
 * Expand a glob pattern
 */
async function expandGlobPattern(ctx, pattern) {
    const globExpander = new GlobExpander(ctx.fs, ctx.state.cwd, ctx.state.env, {
        globstar: ctx.state.shoptOptions.globstar,
        nullglob: ctx.state.shoptOptions.nullglob,
        failglob: ctx.state.shoptOptions.failglob,
        dotglob: ctx.state.shoptOptions.dotglob,
        extglob: ctx.state.shoptOptions.extglob,
        globskipdots: ctx.state.shoptOptions.globskipdots,
    });
    const matches = await globExpander.expand(pattern);
    if (matches.length > 0) {
        return matches;
    }
    if (globExpander.hasFailglob()) {
        throw new GlobError(pattern);
    }
    if (globExpander.hasNullglob()) {
        return [];
    }
    return [pattern];
}
/**
 * Handle final glob expansion after word expansion
 */
async function handleFinalGlobExpansion(ctx, word, wordParts, value, hasQuoted, expandWordForGlobbing) {
    const hasGlobParts = wordParts.some((p) => p.type === "Glob");
    if (!ctx.state.options.noglob && hasGlobParts) {
        const globPattern = await expandWordForGlobbing(ctx, word);
        if (hasGlobPattern(globPattern, ctx.state.shoptOptions.extglob)) {
            const matches = await expandGlobPattern(ctx, globPattern);
            if (matches.length > 0 && matches[0] !== globPattern) {
                return { values: matches, quoted: false };
            }
            if (matches.length === 0) {
                return { values: [], quoted: false };
            }
        }
        const unescapedValue = unescapeGlobPattern(value);
        if (!isIfsEmpty(ctx.state.env)) {
            const ifsChars = getIfs(ctx.state.env);
            const splitValues = splitByIfsForExpansion(unescapedValue, ifsChars);
            return { values: splitValues, quoted: false };
        }
        return { values: [unescapedValue], quoted: false };
    }
    if (!hasQuoted &&
        !ctx.state.options.noglob &&
        hasGlobPattern(value, ctx.state.shoptOptions.extglob)) {
        const globPattern = await expandWordForGlobbing(ctx, word);
        if (hasGlobPattern(globPattern, ctx.state.shoptOptions.extglob)) {
            const matches = await expandGlobPattern(ctx, globPattern);
            if (matches.length > 0 && matches[0] !== globPattern) {
                return { values: matches, quoted: false };
            }
        }
    }
    if (value === "" && !hasQuoted) {
        return { values: [], quoted: false };
    }
    if (hasGlobParts && !hasQuoted) {
        const unescapedValue = unescapeGlobPattern(value);
        if (!isIfsEmpty(ctx.state.env)) {
            const ifsChars = getIfs(ctx.state.env);
            const splitValues = splitByIfsForExpansion(unescapedValue, ifsChars);
            return { values: splitValues, quoted: false };
        }
        return { values: [unescapedValue], quoted: false };
    }
    return { values: [value], quoted: hasQuoted };
}
