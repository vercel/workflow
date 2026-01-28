/**
 * Form data handling for curl command
 */
import type { FormField } from "./types.js";
/**
 * URL-encode form data in curl's --data-urlencode format
 * Supports: name=content, =content, name@file, @file
 */
export declare function encodeFormData(input: string): string;
/**
 * Parse -F/--form field specification
 * Supports: name=value, name=@file, name=<file, name=value;type=mime
 */
export declare function parseFormField(spec: string): FormField | null;
/**
 * Generate multipart form data body and boundary
 */
export declare function generateMultipartBody(fields: FormField[], fileContents: Map<string, string>): {
    body: string;
    boundary: string;
};
