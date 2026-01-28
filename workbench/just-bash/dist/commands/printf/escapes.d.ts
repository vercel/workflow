/**
 * Shared escape sequence and formatting utilities
 * Used by printf command and find -printf
 */
/**
 * Apply width and alignment to a string value
 * Supports: width (right-justify), -width (left-justify), .precision (truncate)
 * @param value - The string value to format
 * @param width - The field width (negative for left-justify)
 * @param precision - Maximum length (-1 for no limit)
 */
export declare function applyWidth(value: string, width: number, precision: number): string;
/**
 * Parse a width/precision spec from a format directive
 * Returns: [width, precision, charsConsumed]
 * width: positive for right-justify, negative for left-justify
 * precision: -1 if not specified
 */
export declare function parseWidthPrecision(format: string, startIndex: number): [number, number, number];
/**
 * Process escape sequences in a string
 * Handles: \n, \t, \r, \\, \a, \b, \f, \v, \e, \0NNN (octal), \xHH (hex),
 *          \uHHHH (unicode), \UHHHHHHHH (unicode)
 */
export declare function processEscapes(str: string): string;
