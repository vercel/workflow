/**
 * Currently a JSON-compatible value (the result of `devalue.stringify()` + `eval()`),
 * but eventually might be binary data (`Uint8Array` or possibly `ArrayBufferView`).
 */
export type SerializedData = unknown;
