// This should error - misspelled directive
'use workflows';
export async function test() {
    return 42;
}
