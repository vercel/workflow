export type Tags = Record<string, string | string[]>;

export type ReturnField = {
  type: string;
};

export type GeneratedDefinition = {
  filePath?: string;
  name: string;
  description?: string;
  tags?: Tags;
};

export type GeneratedFunction = {
  signatures: {
    params: TypeField[];
    returns: TypeField[] | ReturnField;
    throws?: string[];
  }[];
};

export type GeneratedType = {
  entries: TypeField[];
};

export type TypeField = {
  name: string;
  type: string;
  description?: string;
  optional?: boolean;
  tags?: Tags;
};

export type ThrowField = {
  type: string;
  description?: string;
};

export type BaseArgs = {
  code: string;
  exportName?: string;
  flattened?: boolean;
};
