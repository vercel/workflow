export interface KeySpec {
    startField: number;
    startChar?: number;
    endField?: number;
    endChar?: number;
    numeric?: boolean;
    reverse?: boolean;
    ignoreCase?: boolean;
    ignoreLeading?: boolean;
    humanNumeric?: boolean;
    versionSort?: boolean;
    dictionaryOrder?: boolean;
    monthSort?: boolean;
}
export interface SortOptions {
    reverse: boolean;
    numeric: boolean;
    unique: boolean;
    ignoreCase: boolean;
    humanNumeric: boolean;
    versionSort: boolean;
    dictionaryOrder: boolean;
    monthSort: boolean;
    ignoreLeadingBlanks: boolean;
    stable: boolean;
    checkOnly: boolean;
    outputFile: string | null;
    keys: KeySpec[];
    fieldDelimiter: string | null;
}
