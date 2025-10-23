import path from 'node:path';
import type {
  ExportedDeclarations,
  Node as TsNode,
  Symbol as TsSymbol,
  Type,
} from 'ts-morph';
import { Project, SyntaxKind, ts } from 'ts-morph';
import type {
  BaseArgs,
  GeneratedDefinition,
  GeneratedFunction,
  GeneratedType,
  Tags,
  TypeField,
} from './types';

const DEFAULT_FILENAME = '$.ts';

const project = new Project({
  compilerOptions: {
    exactOptionalPropertyTypes: true,
    strictNullChecks: true,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    baseUrl: process.cwd(),
    paths: {
      '@workflow/core/*': ['./packages/core/src/*'],
    },
  },
});

const IGNORED_TYPES = new Set([
  'Date',
  'RegExp',
  'ReactElement',
  'Element',
  'CSSProperties',
]);

let compilerObject: ts.TypeChecker;

/**
 * Finds and returns the export declaration for the specified export name
 */
function findExportDeclaration(
  sourceFile: ReturnType<typeof project.createSourceFile>,
  exportName: string
): ExportedDeclarations {
  const output: ExportedDeclarations[] = [];
  for (const [key, declaration] of sourceFile.getExportedDeclarations()) {
    if (key === exportName) output.push(...declaration);
  }

  let declaration = output[0];
  if (!declaration) {
    // Try to handle re-exports by looking for the actual function
    const exportAssignments = sourceFile.getExportAssignments();
    const defaultExport = exportAssignments.find(
      (exp) => exp.isExportEquals() === false
    );

    if (defaultExport && exportName === 'default') {
      const expression = defaultExport.getExpression();
      if (expression) {
        // Try to resolve the symbol from the expression
        const symbol = expression.getSymbol();
        if (symbol) {
          const declarations = symbol.getDeclarations();
          if (declarations.length > 0) {
            declaration = declarations[0] as ExportedDeclarations;
          }
        }
      }
    }

    if (!declaration) {
      throw new Error(
        `Can't find "${exportName}" declaration. This might be a re-exported function from another module. Try providing the full function definition instead of re-exporting.`
      );
    }
  }

  return declaration;
}

/**
 * Generates a documentation definition for a given code snippet and export name.
 */
export function generateDefinition({
  code,
  exportName = 'default',
  flattened = false,
}: BaseArgs): GeneratedDefinition & (GeneratedType | GeneratedFunction) {
  compilerObject ??= project.getTypeChecker().compilerObject;

  const sourceFile = project.createSourceFile(DEFAULT_FILENAME, code, {
    overwrite: true,
  });

  const declaration = findExportDeclaration(sourceFile, exportName);

  const declarationFilePath = declaration.getSourceFile().getFilePath();
  const filePath = path.relative(process.cwd(), declarationFilePath);
  const symbol = declaration.getSymbolOrThrow();
  const { comment, tags } = getCommentAndTags(declaration);
  const description = ts.displayPartsToString(comment);

  if (tags.returns && typeof tags.returns === 'string') {
    tags.returns = replaceJsDocLinks(tags.returns);
  }

  const definition: GeneratedDefinition = {
    ...(filePath !== DEFAULT_FILENAME && { filePath }),
    name: symbol.getName(),
    ...(description && { description }),
    ...(Object.keys(tags).length && { tags }),
  };

  const declarationType = declaration.getType();
  const callSignatures = declarationType.getCallSignatures();
  const isFunction = callSignatures.length > 0;

  if (!isFunction) {
    const entries = declarationType
      .getProperties()
      .filter((prop) => {
        const propName = prop.getName();
        // Filter out Symbol properties and internal methods
        if (propName.startsWith('__') || propName.includes('@')) {
          return false;
        }
        // Filter out 'then' method for Promise-like objects
        if (propName === 'then') {
          return false;
        }
        return true;
      })
      .flatMap((prop) =>
        getDocEntry({
          symbol: prop,
          declaration,
          flattened,
        })
      )
      .filter((entry) => !entry.tags || !('internal' in entry.tags));

    if (!entries.length) {
      const typeName = declarationType.getText();
      if (typeName === 'any') {
        throw new Error(
          'Your type is resolved as "any", it seems like you have an issue in "generateDefinition.code" argument.'
        );
      }
      throw new Error(
        `No properties found, check if your type "${typeName}" exist.`
      );
    }

    return {
      ...definition,
      entries,
    };
  }

  return {
    ...definition,
    signatures: callSignatures.map((signature) => {
      const params = signature.getParameters();

      // Get JSDoc tags from the signature for @param descriptions
      const signatureDecl = signature.getDeclaration();
      const signatureTags =
        'getJsDocs' in signatureDecl
          ? signatureDecl
              .getJsDocs()
              .flatMap((jsDoc: any) =>
                jsDoc
                  .getTags()
                  .filter(
                    (tag: any) =>
                      tag.getTagName() === 'param' ||
                      tag.getTagName() === 'throws'
                  )
              )
          : [];

      const typeParams = params.flatMap((param) => {
        const baseEntry = getDocEntry({
          symbol: param,
          declaration,
          flattened,
        });

        // Try to find @param description from signature JSDoc
        const paramName = param.getName();
        const paramTag = signatureTags.find((tag: any) => {
          const tagText = tag.getText();
          return tagText.includes(paramName);
        });

        if (paramTag && !Array.isArray(baseEntry)) {
          let tagText = paramTag.getText();
          tagText = tagText.replace(/^\s*\*\s*/, '');
          const match = tagText.match(
            new RegExp(`${paramName}\\s*-\\s*(.+?)(?:\\s*\\*)?$`, 's')
          );
          if (match) {
            baseEntry.description = replaceJsDocLinks(
              match[1]
                .replace(/\s*\*\s*$/, '')
                .replace(/^\s*\*\s*/gm, '')
                .trim()
            );
          }
        }

        return baseEntry;
      });

      const returnType = signature
        .getDeclaration()
        .getSignature()
        .getReturnType();

      let flattenedReturnType: GeneratedFunction['signatures'][number]['returns'] =
        flattened && shouldFlattenType(returnType)
          ? returnType.getProperties().flatMap((childProp) =>
              getDocEntry({
                symbol: childProp,
                declaration,
                flattened,
              })
            )
          : [];

      if (!flattenedReturnType.length) {
        flattenedReturnType = {
          type: getFormattedText(returnType),
        };
      }

      return {
        params: typeParams,
        returns: flattenedReturnType,
        throws: tags.throws as string[] | undefined,
      };
    }),
  };
}

/**
 * Gets the comment and tags for a given declaration.
 */
function getCommentAndTags(declaration: ExportedDeclarations): {
  comment: ts.SymbolDisplayPart[];
  tags: Tags;
} {
  const symbol = declaration.getSymbolOrThrow();
  const comment = symbol.compilerSymbol.getDocumentationComment(compilerObject);

  if (!comment.length) {
    const aliasSymbol = declaration.getType().getAliasSymbol();
    if (aliasSymbol) {
      return {
        comment:
          aliasSymbol.compilerSymbol.getDocumentationComment(compilerObject),
        tags: getTags(aliasSymbol),
      };
    }
  }

  return {
    comment,
    tags: getTags(symbol),
  };
}

/**
 * Gets a documentation entry for a given symbol.
 */
function getDocEntry({
  symbol,
  declaration,
  flattened,
  prefix = '',
}: {
  symbol: TsSymbol;
  declaration: ExportedDeclarations;
  flattened: boolean;
  prefix?: string;
}): TypeField | TypeField[] {
  const originalSubType = project
    .getTypeChecker()
    .getTypeOfSymbolAtLocation(symbol, declaration);
  const valueDeclaration = symbol.getValueDeclaration();
  const isFunctionParameter =
    valueDeclaration && valueDeclaration.getKind() === SyntaxKind.Parameter;

  const subType = isFunctionParameter
    ? originalSubType.getNonNullableType()
    : originalSubType;

  if (flattened && shouldFlattenType(subType)) {
    return subType.getProperties().flatMap((childProp) => {
      const childPrefix = isFunctionParameter
        ? symbol.getName().replace(/^_+/, '')
        : symbol.getName();
      const newPrefix =
        typeof +childPrefix === 'number' && !Number.isNaN(+childPrefix)
          ? `[${childPrefix}] ${originalSubType.isNullable() ? '?' : ''}`
          : childPrefix;
      return getDocEntry({
        symbol: childProp,
        declaration,
        flattened,
        prefix: prexify(prefix, newPrefix),
      });
    });
  }

  const tags = getTags(symbol);
  const name = symbol.getName();
  const typeDescription = replaceJsDocLinks(
    ts.displayPartsToString(
      symbol.compilerSymbol.getDocumentationComment(compilerObject)
    )
  ).replace(/^- /, '');

  const isOptional = isFunctionParameter
    ? (valueDeclaration.asKind(SyntaxKind.Parameter)?.isOptional() ?? false)
    : symbol.isOptional();

  const typeName = getTypeName({
    tags,
    symbol,
    subType,
    valueDeclaration,
  });

  return {
    name: prexify(prefix, name),
    type: typeName,
    ...(typeDescription && { description: typeDescription }),
    ...(Object.keys(tags).length && { tags }),
    ...(isOptional && { optional: isOptional }),
  };
}

function getTypeName({
  tags,
  symbol,
  subType,
  valueDeclaration,
}: {
  tags: Tags;
  symbol: TsSymbol;
  subType: Type;
  valueDeclaration: TsNode | undefined;
}) {
  const aliasSymbol = subType.getAliasSymbol();
  const subTypeTags = aliasSymbol ? getTags(aliasSymbol) : {};
  const remarksValue = tags.remarks || subTypeTags.remarks;
  const typeName =
    typeof remarksValue === 'string'
      ? remarksValue.match(/^`(?<name>.+)`/)?.groups?.name
      : undefined;

  if (typeName) {
    return typeName;
  }

  const declarationNode = symbol
    .getDeclarations()
    .find(
      (d) =>
        ts.isPropertySignature(d.compilerNode) || ts.isParameter(d.compilerNode)
    );
  const typeNode =
    declarationNode?.asKind(SyntaxKind.PropertySignature) ??
    declarationNode?.asKind(SyntaxKind.Parameter);
  const t = typeNode?.getTypeNode()?.getText();

  const useTypeNode =
    t &&
    (t.startsWith('Partial<') ||
      ['React.ReactNode', 'React.ReactElement'].includes(t));

  if (useTypeNode) {
    return t;
  }

  const isInline = 'inline' in tags || 'inline' in subTypeTags;

  if (!isInline) {
    const typeOf = valueDeclaration?.getType() ?? symbol.getDeclaredType();
    return typeOf.isUnknown() ? 'unknown' : getFormattedText(subType);
  }

  const [signature] = subType.getCallSignatures();
  const isFunction = !!signature;

  if (isFunction) {
    const params = signature.getParameters().map((param) => {
      const paramDecl = param.getDeclarations()[0]!;
      const paramType = project
        .getTypeChecker()
        .getTypeOfSymbolAtLocation(param, paramDecl);
      const inlineParamAlias = paramType.getNonNullableType().getAliasSymbol();
      const paramTags = inlineParamAlias && getTags(inlineParamAlias);

      const paramTypeStr =
        paramTags && 'inline' in paramTags
          ? inlineParamAlias
              .getDeclarations()[0]!
              .asKindOrThrow(SyntaxKind.TypeAliasDeclaration)
              .getTypeNodeOrThrow()
              .getText()
          : getFormattedText(paramType);
      const optional = paramDecl
        .asKindOrThrow(SyntaxKind.Parameter)
        .isOptional();

      return `${param.getName()}${optional ? '?' : ''}: ${paramTypeStr}`;
    });

    return `(${params.join(', ')}) => ${getFormattedText(signature.getReturnType())}`;
  }

  const [aliasDecl] = aliasSymbol!.getDeclarations();
  if (!aliasDecl) {
    throw new Error("Can't find alias declaration for type.");
  }
  const inlineNode = aliasDecl
    .asKindOrThrow(SyntaxKind.TypeAliasDeclaration)
    .getTypeNodeOrThrow();
  return inlineNode.getText();
}

function prexify(prefix: string, name: string): string {
  return prefix ? [prefix, name].join('.') : name;
}

function shouldFlattenType(t: Type): boolean {
  if (
    !t.isObject() ||
    t.isArray() ||
    t.isTuple() ||
    t.getCallSignatures().length > 0 ||
    t.getText() === '{}' ||
    !t.getProperties().length
  ) {
    return false;
  }

  try {
    const baseName = t.getSymbolOrThrow().getName();
    if (IGNORED_TYPES.has(baseName)) return false;
    return t.isInterface() || baseName === '__type' || baseName === '__object';
  } catch {
    console.error(`Symbol "${t.getText()}" isn't found.`);
    return false;
  }
}

function getTags(prop: TsSymbol): Tags {
  const tags: Record<string, string | string[]> = Object.create(null);
  for (const tag of prop.getJsDocTags()) {
    const tagName = tag.getName();
    const tagValue = ts.displayPartsToString(tag.getText());
    switch (tagName) {
      case 'throws':
        if (!tags.throws) {
          tags.throws = [];
        }
        (tags.throws as string[]).push(tagValue);
        break;
      case 'then':
        continue;
      default:
        if (tagName in tags) {
          tags[tagName] += `\n${tagValue}`;
        } else {
          tags[tagName] = tagValue;
        }
    }
  }
  return tags;
}

function getFormattedText(t: Type): string {
  return t.getText(
    undefined,
    ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope
  );
}

function replaceJsDocLinks(md: string): string {
  return md.replaceAll(/{@link (?<link>[^}]*)}/g, '$1');
}
