/**
 * Indirect Array Expansion Handlers
 *
 * Handles "${!ref}" style indirect expansions where ref points to an array:
 * - "${!ref}" where ref='arr[@]' or ref='arr[*]'
 * - "${!ref:offset}" and "${!ref:offset:length}" - array slicing via indirection
 * - "${!ref:-default}" and "${!ref:+alternative}" - default/alternative via indirection
 * - "${ref+${!ref}}" - indirect in alternative value
 */
import { evaluateArithmetic } from "../arithmetic.js";
import { ArithmeticError } from "../errors.js";
import { getIfsSeparator } from "../helpers/ifs.js";
import { getArrayElements, getVariable, isVariableSet } from "./variable.js";
import { getVariableAttributes } from "./variable-attrs.js";
/**
 * Handle "${!ref}" where ref='arr[@]' or ref='arr[*]' - indirect array expansion.
 * This handles all the inner operation cases as well.
 */
export async function handleIndirectArrayExpansion(ctx, wordParts, hasIndirection, expandParameterAsync, expandWordPartsAsync) {
    if (!hasIndirection ||
        wordParts.length !== 1 ||
        wordParts[0].type !== "DoubleQuoted") {
        return null;
    }
    const dqPart = wordParts[0];
    if (dqPart.parts.length !== 1 ||
        dqPart.parts[0].type !== "ParameterExpansion" ||
        dqPart.parts[0].operation?.type !== "Indirection") {
        return null;
    }
    const paramPart = dqPart.parts[0];
    const indirOp = paramPart.operation;
    // Get the value of the reference variable (e.g., ref='arr[@]')
    const refValue = await getVariable(ctx, paramPart.parameter);
    // Check if the target is an array expansion (arr[@] or arr[*])
    const arrayMatch = refValue.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[([@*])\]$/);
    if (!arrayMatch) {
        // Handle ${!ref} where ref='@' or ref='*' (no array)
        if (!indirOp.innerOp) {
            if (refValue === "@" || refValue === "*") {
                const numParams = Number.parseInt(ctx.state.env["#"] || "0", 10);
                const params = [];
                for (let i = 1; i <= numParams; i++) {
                    params.push(ctx.state.env[String(i)] || "");
                }
                if (refValue === "*") {
                    // ref='*' - join with IFS into one word (like "$*")
                    return {
                        values: [params.join(getIfsSeparator(ctx.state.env))],
                        quoted: true,
                    };
                }
                // ref='@' - each param as a separate word (like "$@")
                return { values: params, quoted: true };
            }
        }
        return null;
    }
    const arrayName = arrayMatch[1];
    const isStar = arrayMatch[2] === "*";
    const elements = getArrayElements(ctx, arrayName);
    if (indirOp.innerOp) {
        // Handle "${!ref[@]:offset}" or "${!ref[@]:offset:length}" - array slicing via indirection
        if (indirOp.innerOp.type === "Substring") {
            return handleIndirectArraySlicing(ctx, elements, arrayName, isStar, indirOp.innerOp);
        }
        // Handle DefaultValue, UseAlternative, AssignDefault, ErrorIfUnset
        if (indirOp.innerOp.type === "DefaultValue" ||
            indirOp.innerOp.type === "UseAlternative" ||
            indirOp.innerOp.type === "AssignDefault" ||
            indirOp.innerOp.type === "ErrorIfUnset") {
            return handleIndirectArrayDefaultAlternative(ctx, elements, arrayName, isStar, indirOp.innerOp, expandWordPartsAsync);
        }
        // Handle Transform operations specially for @a (attributes)
        if (indirOp.innerOp.type === "Transform" &&
            indirOp.innerOp.operator === "a") {
            const attrs = getVariableAttributes(ctx, arrayName);
            const values = elements.map(() => attrs);
            if (isStar) {
                return {
                    values: [values.join(getIfsSeparator(ctx.state.env))],
                    quoted: true,
                };
            }
            return { values, quoted: true };
        }
        // Handle other innerOps (PatternRemoval, PatternReplacement, Transform, etc.)
        // Apply the operation to each element
        const values = [];
        for (const [, elemValue] of elements) {
            const syntheticPart = {
                type: "ParameterExpansion",
                parameter: "_indirect_elem_",
                operation: indirOp.innerOp,
            };
            // Temporarily set the element value
            const oldVal = ctx.state.env._indirect_elem_;
            ctx.state.env._indirect_elem_ = elemValue;
            try {
                const result = await expandParameterAsync(ctx, syntheticPart, true);
                values.push(result);
            }
            finally {
                if (oldVal !== undefined) {
                    ctx.state.env._indirect_elem_ = oldVal;
                }
                else {
                    delete ctx.state.env._indirect_elem_;
                }
            }
        }
        if (isStar) {
            return {
                values: [values.join(getIfsSeparator(ctx.state.env))],
                quoted: true,
            };
        }
        return { values, quoted: true };
    }
    // No innerOp - return array elements directly
    if (elements.length > 0) {
        const values = elements.map(([, v]) => v);
        if (isStar) {
            // arr[*] - join with IFS into one word
            return {
                values: [values.join(getIfsSeparator(ctx.state.env))],
                quoted: true,
            };
        }
        // arr[@] - each element as a separate word
        return { values, quoted: true };
    }
    // No array elements - check for scalar variable
    const scalarValue = ctx.state.env[arrayName];
    if (scalarValue !== undefined) {
        return { values: [scalarValue], quoted: true };
    }
    // Variable is unset - return empty
    return { values: [], quoted: true };
}
/**
 * Handle "${!ref[@]:offset}" or "${!ref[@]:offset:length}" - array slicing via indirection
 */
async function handleIndirectArraySlicing(ctx, elements, arrayName, isStar, innerOp) {
    const offset = innerOp.offset
        ? await evaluateArithmetic(ctx, innerOp.offset.expression)
        : 0;
    const length = innerOp.length
        ? await evaluateArithmetic(ctx, innerOp.length.expression)
        : undefined;
    // For sparse arrays, offset refers to index position
    let startIdx = 0;
    if (offset < 0) {
        if (elements.length > 0) {
            const lastIdx = elements[elements.length - 1][0];
            const maxIndex = typeof lastIdx === "number" ? lastIdx : 0;
            const targetIndex = maxIndex + 1 + offset;
            if (targetIndex < 0)
                return { values: [], quoted: true };
            startIdx = elements.findIndex(([idx]) => typeof idx === "number" && idx >= targetIndex);
            if (startIdx < 0)
                return { values: [], quoted: true };
        }
    }
    else {
        startIdx = elements.findIndex(([idx]) => typeof idx === "number" && idx >= offset);
        if (startIdx < 0)
            return { values: [], quoted: true };
    }
    let slicedElements;
    if (length !== undefined) {
        if (length < 0) {
            throw new ArithmeticError(`${arrayName}[@]: substring expression < 0`);
        }
        slicedElements = elements.slice(startIdx, startIdx + length);
    }
    else {
        slicedElements = elements.slice(startIdx);
    }
    const values = slicedElements.map(([, v]) => v);
    if (isStar) {
        return {
            values: [values.join(getIfsSeparator(ctx.state.env))],
            quoted: true,
        };
    }
    return { values, quoted: true };
}
/**
 * Handle DefaultValue, UseAlternative, AssignDefault, ErrorIfUnset for indirect array
 */
async function handleIndirectArrayDefaultAlternative(ctx, elements, arrayName, isStar, innerOp, expandWordPartsAsync) {
    const checkEmpty = innerOp.checkEmpty ?? false;
    const values = elements.map(([, v]) => v);
    // For arrays, "empty" means zero elements (not that elements are empty strings)
    const isEmpty = elements.length === 0;
    const isUnset = elements.length === 0;
    if (innerOp.type === "UseAlternative") {
        // ${!ref[@]:+word} - return word if set and non-empty
        const shouldUseAlt = !isUnset && !(checkEmpty && isEmpty);
        if (shouldUseAlt && innerOp.word) {
            const altValue = await expandWordPartsAsync(ctx, innerOp.word.parts, true);
            return { values: [altValue], quoted: true };
        }
        return { values: [], quoted: true };
    }
    if (innerOp.type === "DefaultValue") {
        // ${!ref[@]:-word} - return word if unset or empty
        const shouldUseDefault = isUnset || (checkEmpty && isEmpty);
        if (shouldUseDefault && innerOp.word) {
            const defValue = await expandWordPartsAsync(ctx, innerOp.word.parts, true);
            return { values: [defValue], quoted: true };
        }
        if (isStar) {
            return {
                values: [values.join(getIfsSeparator(ctx.state.env))],
                quoted: true,
            };
        }
        return { values, quoted: true };
    }
    if (innerOp.type === "AssignDefault") {
        // ${!ref[@]:=word} - assign and return word if unset or empty
        const shouldAssign = isUnset || (checkEmpty && isEmpty);
        if (shouldAssign && innerOp.word) {
            const assignValue = await expandWordPartsAsync(ctx, innerOp.word.parts, true);
            // Assign to the target array
            ctx.state.env[`${arrayName}_0`] = assignValue;
            ctx.state.env[`${arrayName}__length`] = "1";
            return { values: [assignValue], quoted: true };
        }
        if (isStar) {
            return {
                values: [values.join(getIfsSeparator(ctx.state.env))],
                quoted: true,
            };
        }
        return { values, quoted: true };
    }
    // ErrorIfUnset case - not common for arrays
    if (isStar) {
        return {
            values: [values.join(getIfsSeparator(ctx.state.env))],
            quoted: true,
        };
    }
    return { values, quoted: true };
}
/**
 * Handle ${ref+${!ref}} or ${ref-${!ref}} - indirect in alternative/default value.
 * This handles patterns like: ${hooksSlice+"${!hooksSlice}"} which should preserve element boundaries
 */
export async function handleIndirectInAlternative(ctx, wordParts) {
    if (wordParts.length !== 1 ||
        wordParts[0].type !== "ParameterExpansion" ||
        (wordParts[0].operation?.type !== "UseAlternative" &&
            wordParts[0].operation?.type !== "DefaultValue")) {
        return null;
    }
    const paramPart = wordParts[0];
    const op = paramPart.operation;
    const opWord = op?.word;
    // Check if the inner word is a quoted indirect expansion to an array
    if (!opWord ||
        opWord.parts.length !== 1 ||
        opWord.parts[0].type !== "DoubleQuoted") {
        return null;
    }
    const innerDq = opWord.parts[0];
    if (innerDq.parts.length !== 1 ||
        innerDq.parts[0].type !== "ParameterExpansion" ||
        innerDq.parts[0].operation?.type !== "Indirection") {
        return null;
    }
    const innerParam = innerDq.parts[0];
    // Get the value of the reference variable to see if it points to an array
    const refValue = await getVariable(ctx, innerParam.parameter);
    const arrayMatch = refValue.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[([@*])\]$/);
    if (!arrayMatch) {
        return null;
    }
    // Check if we should use the alternative/default
    const isSet = await isVariableSet(ctx, paramPart.parameter);
    const isEmpty = (await getVariable(ctx, paramPart.parameter)) === "";
    const checkEmpty = op.checkEmpty ?? false;
    let shouldExpand;
    if (op.type === "UseAlternative") {
        // ${var+word} - expand if var IS set (and non-empty if :+)
        shouldExpand = isSet && !(checkEmpty && isEmpty);
    }
    else {
        // ${var-word} - expand if var is NOT set (or empty if :-)
        shouldExpand = !isSet || (checkEmpty && isEmpty);
    }
    if (shouldExpand) {
        // Expand the inner indirect array reference
        const arrayName = arrayMatch[1];
        const isStar = arrayMatch[2] === "*";
        const elements = getArrayElements(ctx, arrayName);
        if (elements.length > 0) {
            const values = elements.map(([, v]) => v);
            if (isStar) {
                // arr[*] - join with IFS into one word
                return {
                    values: [values.join(getIfsSeparator(ctx.state.env))],
                    quoted: true,
                };
            }
            // arr[@] - each element as a separate word (quoted)
            return { values, quoted: true };
        }
        // No array elements - check for scalar variable
        const scalarValue = ctx.state.env[arrayName];
        if (scalarValue !== undefined) {
            return { values: [scalarValue], quoted: true };
        }
        // Variable is unset - return empty
        return { values: [], quoted: true };
    }
    // Don't expand the alternative - return empty
    return { values: [], quoted: false };
}
/**
 * Handle ${!ref+${!ref}} or ${!ref-${!ref}} - indirect with innerOp in alternative/default value.
 * This handles patterns like: ${!hooksSlice+"${!hooksSlice}"} which should preserve element boundaries
 */
export async function handleIndirectionWithInnerAlternative(ctx, wordParts) {
    if (wordParts.length !== 1 ||
        wordParts[0].type !== "ParameterExpansion" ||
        wordParts[0].operation?.type !== "Indirection") {
        return null;
    }
    const paramPart = wordParts[0];
    const indirOp = paramPart.operation;
    const innerOp = indirOp.innerOp;
    if (!innerOp ||
        (innerOp.type !== "UseAlternative" && innerOp.type !== "DefaultValue")) {
        return null;
    }
    const opWord = innerOp.word;
    // Check if the inner word is a quoted indirect expansion to an array
    if (!opWord ||
        opWord.parts.length !== 1 ||
        opWord.parts[0].type !== "DoubleQuoted") {
        return null;
    }
    const innerDq = opWord.parts[0];
    if (innerDq.parts.length !== 1 ||
        innerDq.parts[0].type !== "ParameterExpansion" ||
        innerDq.parts[0].operation?.type !== "Indirection") {
        return null;
    }
    const innerParam = innerDq.parts[0];
    // Get the value of the reference variable to see if it points to an array
    const refValue = await getVariable(ctx, innerParam.parameter);
    const arrayMatch = refValue.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[([@*])\]$/);
    if (!arrayMatch) {
        return null;
    }
    // First resolve the outer indirection
    const outerRefValue = await getVariable(ctx, paramPart.parameter);
    // Check if we should use the alternative/default
    const isSet = await isVariableSet(ctx, paramPart.parameter);
    const isEmpty = outerRefValue === "";
    const checkEmpty = innerOp.checkEmpty ?? false;
    let shouldExpand;
    if (innerOp.type === "UseAlternative") {
        // ${!var+word} - expand if the indirect target IS set (and non-empty if :+)
        shouldExpand = isSet && !(checkEmpty && isEmpty);
    }
    else {
        // ${!var-word} - expand if the indirect target is NOT set (or empty if :-)
        shouldExpand = !isSet || (checkEmpty && isEmpty);
    }
    if (shouldExpand) {
        // Expand the inner indirect array reference
        const arrayName = arrayMatch[1];
        const isStar = arrayMatch[2] === "*";
        const elements = getArrayElements(ctx, arrayName);
        if (elements.length > 0) {
            const values = elements.map(([, v]) => v);
            if (isStar) {
                // arr[*] - join with IFS into one word
                return {
                    values: [values.join(getIfsSeparator(ctx.state.env))],
                    quoted: true,
                };
            }
            // arr[@] - each element as a separate word (quoted)
            return { values, quoted: true };
        }
        // No array elements - check for scalar variable
        const scalarValue = ctx.state.env[arrayName];
        if (scalarValue !== undefined) {
            return { values: [scalarValue], quoted: true };
        }
        // Variable is unset - return empty
        return { values: [], quoted: true };
    }
    // Don't expand the alternative - fall through to return empty or the outer value
    return { values: [], quoted: false };
}
