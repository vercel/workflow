export interface StepAddress {
    first: number;
    step: number;
}
export interface RelativeOffset {
    offset: number;
}
export type SedAddress = number | "$" | {
    pattern: string;
} | StepAddress | RelativeOffset;
export interface AddressRange {
    start?: SedAddress;
    end?: SedAddress;
    negated?: boolean;
}
export type SedCommandType = "substitute" | "print" | "printFirstLine" | "delete" | "deleteFirstLine" | "append" | "insert" | "change" | "hold" | "holdAppend" | "get" | "getAppend" | "exchange" | "next" | "nextAppend" | "quit" | "quitSilent" | "transliterate" | "lineNumber" | "branch" | "branchOnSubst" | "branchOnNoSubst" | "label" | "zap" | "group" | "list" | "printFilename" | "version" | "readFile" | "readFileLine" | "writeFile" | "writeFirstLine" | "execute";
export interface SubstituteCommand {
    type: "substitute";
    address?: AddressRange;
    pattern: string;
    replacement: string;
    global: boolean;
    ignoreCase: boolean;
    printOnMatch: boolean;
    nthOccurrence?: number;
    extendedRegex?: boolean;
}
export interface PrintCommand {
    type: "print";
    address?: AddressRange;
}
export interface DeleteCommand {
    type: "delete";
    address?: AddressRange;
}
export interface AppendCommand {
    type: "append";
    address?: AddressRange;
    text: string;
}
export interface InsertCommand {
    type: "insert";
    address?: AddressRange;
    text: string;
}
export interface ChangeCommand {
    type: "change";
    address?: AddressRange;
    text: string;
}
export interface HoldCommand {
    type: "hold";
    address?: AddressRange;
}
export interface HoldAppendCommand {
    type: "holdAppend";
    address?: AddressRange;
}
export interface GetCommand {
    type: "get";
    address?: AddressRange;
}
export interface GetAppendCommand {
    type: "getAppend";
    address?: AddressRange;
}
export interface ExchangeCommand {
    type: "exchange";
    address?: AddressRange;
}
export interface NextCommand {
    type: "next";
    address?: AddressRange;
}
export interface QuitCommand {
    type: "quit";
    address?: AddressRange;
    exitCode?: number;
}
export interface QuitSilentCommand {
    type: "quitSilent";
    address?: AddressRange;
    exitCode?: number;
}
export interface NextAppendCommand {
    type: "nextAppend";
    address?: AddressRange;
}
export interface TransliterateCommand {
    type: "transliterate";
    address?: AddressRange;
    source: string;
    dest: string;
}
export interface LineNumberCommand {
    type: "lineNumber";
    address?: AddressRange;
}
export interface BranchCommand {
    type: "branch";
    address?: AddressRange;
    label?: string;
}
export interface BranchOnSubstCommand {
    type: "branchOnSubst";
    address?: AddressRange;
    label?: string;
}
export interface LabelCommand {
    type: "label";
    name: string;
}
export interface BranchOnNoSubstCommand {
    type: "branchOnNoSubst";
    address?: AddressRange;
    label?: string;
}
export interface PrintFirstLineCommand {
    type: "printFirstLine";
    address?: AddressRange;
}
export interface DeleteFirstLineCommand {
    type: "deleteFirstLine";
    address?: AddressRange;
}
export interface ZapCommand {
    type: "zap";
    address?: AddressRange;
}
export interface GroupCommand {
    type: "group";
    address?: AddressRange;
    commands: SedCommand[];
}
export interface ListCommand {
    type: "list";
    address?: AddressRange;
}
export interface PrintFilenameCommand {
    type: "printFilename";
    address?: AddressRange;
}
export interface VersionCommand {
    type: "version";
    address?: AddressRange;
    minVersion?: string;
}
export interface ReadFileCommand {
    type: "readFile";
    address?: AddressRange;
    filename: string;
}
export interface ReadFileLineCommand {
    type: "readFileLine";
    address?: AddressRange;
    filename: string;
}
export interface WriteFileCommand {
    type: "writeFile";
    address?: AddressRange;
    filename: string;
}
export interface WriteFirstLineCommand {
    type: "writeFirstLine";
    address?: AddressRange;
    filename: string;
}
export interface ExecuteCommand {
    type: "execute";
    address?: AddressRange;
    command?: string;
}
export type SedCommand = SubstituteCommand | PrintCommand | PrintFirstLineCommand | DeleteCommand | DeleteFirstLineCommand | AppendCommand | InsertCommand | ChangeCommand | HoldCommand | HoldAppendCommand | GetCommand | GetAppendCommand | ExchangeCommand | NextCommand | QuitCommand | QuitSilentCommand | NextAppendCommand | TransliterateCommand | LineNumberCommand | BranchCommand | BranchOnSubstCommand | BranchOnNoSubstCommand | LabelCommand | ZapCommand | GroupCommand | ListCommand | PrintFilenameCommand | VersionCommand | ReadFileCommand | ReadFileLineCommand | WriteFileCommand | WriteFirstLineCommand | ExecuteCommand;
export interface SedState {
    patternSpace: string;
    holdSpace: string;
    lineNumber: number;
    totalLines: number;
    deleted: boolean;
    printed: boolean;
    quit: boolean;
    quitSilent: boolean;
    exitCode?: number;
    errorMessage?: string;
    appendBuffer: string[];
    changedText?: string;
    substitutionMade: boolean;
    lineNumberOutput: string[];
    nCommandOutput: string[];
    restartCycle: boolean;
    inDRestartedCycle: boolean;
    currentFilename?: string;
    pendingFileReads: Array<{
        filename: string;
        wholeFile: boolean;
    }>;
    pendingFileWrites: Array<{
        filename: string;
        content: string;
    }>;
    pendingExecute?: {
        command: string;
        replacePattern: boolean;
    };
    rangeStates: Map<string, RangeState>;
    lastPattern?: string;
    branchRequest?: string;
    linesConsumedInCycle: number;
}
export interface RangeState {
    active: boolean;
    startLine?: number;
    completed?: boolean;
}
export interface SedExecutionLimits {
    maxIterations: number;
}
