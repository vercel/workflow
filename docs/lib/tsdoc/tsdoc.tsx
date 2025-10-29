import cn from 'clsx';
import Slugger from 'github-slugger';
import Link from 'next/link';
import type { FC, ReactElement, ReactNode } from 'react';
import { Callout } from '@/components/ui/callout';
import type { generateDefinition } from './base';
import type { GeneratedFunction, TypeField } from './types';

type TSDocProps = {
  definition: ReturnType<typeof generateDefinition>;
  typeLinkMap?: Record<string, string>;
  noParametersContent?: ReactNode;
  showSections: ('parameters' | 'returns' | 'throws')[];
};

const classes = {
  card: cn('rounded-sm transition-colors'),
  anchor: cn(
    'absolute top-2 right-2 text-lg font-black',
    'before:content-["#"] hover:text-foreground',
    'px-2 py-1 opacity-0 group-hover:opacity-100 transition-opacity'
  ),
};

export const TSDoc: FC<TSDocProps> = ({
  definition,
  typeLinkMap = {},
  noParametersContent = (
    <p className="text-muted-foreground">
      This function does not accept any parameters.
    </p>
  ),
  showSections = ['parameters', 'returns'],
}) => {
  const showParameters = showSections.includes('parameters');
  const showReturns = showSections.includes('returns');
  const showThrows = showSections.includes('throws');
  if ('entries' in definition) {
    return (
      <FieldsTable fields={definition.entries} typeLinkMap={typeLinkMap} />
    );
  }

  const { signatures } = definition;
  const withSignatures = signatures.length > 1;

  if (!withSignatures) {
    return (
      <FunctionSignature
        signature={signatures[0]}
        showParameters={showParameters}
        showReturns={showReturns}
        showThrows={showThrows}
        noParametersContent={noParametersContent}
        typeLinkMap={typeLinkMap}
      />
    );
  }

  return (
    <div>
      <Callout>This function has multiple signatures.</Callout>
      {signatures.map((signature, index) => (
        <div key={index} className="mt-8">
          <h4>Signature {index + 1}</h4>
          <FunctionSignature
            signature={signature}
            index={index + 1}
            showParameters={showParameters}
            showReturns={showReturns}
            showThrows={showThrows}
            noParametersContent={noParametersContent}
            typeLinkMap={typeLinkMap}
          />
        </div>
      ))}
    </div>
  );
};

function FunctionSignature({
  signature,
  index = '',
  showParameters = true,
  showReturns = true,
  showThrows = true,
  noParametersContent = (
    <p className="text-muted-foreground">
      This function does not accept any parameters.
    </p>
  ),
  typeLinkMap = {},
}: {
  signature: GeneratedFunction['signatures'][number];
  index?: string | number;
  showParameters?: boolean;
  showReturns?: boolean;
  showThrows?: boolean;
  noParametersContent?: ReactNode;
  typeLinkMap?: TSDocProps['typeLinkMap'];
}) {
  const slugger = new Slugger();
  const unnamedReturnId = `returns${index}`;

  return (
    <div className="[&_code]:text-xs">
      {showParameters && (
        <div>
          {signature.params.length ? (
            <FieldsTable fields={signature.params} typeLinkMap={typeLinkMap} />
          ) : (
            noParametersContent
          )}
        </div>
      )}
      {showReturns && (
        <div>
          {Array.isArray(signature.returns) ? (
            <div className="space-y-4">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b text-left">
                    <th className="py-2 w-1/6">Name</th>
                    <th className="py-2 w-1/3">Type</th>
                    <th className="py-2 w-1/2">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {signature.returns.map((prop) => {
                    const id = slugger.slug(prop.name);
                    return (
                      <Row key={id} id={id}>
                        <NameCell optional={prop.optional} name={prop.name} />
                        <TypeCell type={prop.type} typeLinkMap={typeLinkMap} />
                        <td className="p-3 table-cell break-words">
                          {linkify(prop.description || '', typeLinkMap)}
                        </td>
                      </Row>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div
              id={unnamedReturnId}
              className={cn(
                classes.card,
                'text-sm relative p-3 border before:content-["Type:_"]'
              )}
            >
              <code className="bg-muted px-1.5 py-0.5 rounded text-sm">
                {linkify(signature.returns.type, typeLinkMap)}
              </code>
            </div>
          )}
        </div>
      )}
      {showThrows && (
        <div>
          {signature.throws?.length ? (
            <table className="w-full text-sm border-collapse my-6 table-fixed">
              <thead>
                <tr className="border-b text-left">
                  <th className="py-2 w-2/4">Type</th>
                  <th className="py-2 w-2/4">Description</th>
                </tr>
              </thead>
              <tbody>
                {signature.throws.map((throwsItem, index) => {
                  const match = throwsItem.match(/^`?([^`\s]+)`?\s*-\s*(.+)$/);
                  const type = match ? match[1] : throwsItem;
                  const description = match ? match[2] : '';
                  const id = `throws-${index}`;

                  return (
                    <Row key={id} id={id}>
                      <td className="relative table-cell pr-3">
                        <code className="bg-muted px-1.5 py-0.5 rounded text-xs whitespace-nowrap my-0">
                          {linkify(type, typeLinkMap)}
                        </code>
                      </td>
                      <td className="p-3 table-cell break-words">
                        {description && (
                          <p className="text-sm whitespace-pre-wrap !my-0 break-words">
                            {linkify(description, typeLinkMap)}
                          </p>
                        )}
                      </td>
                    </Row>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p className="text-muted-foreground">
              This function does not throw any errors.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

const Row: FC<{
  children: ReactNode;
  id: string;
}> = ({ children, id }) => {
  return (
    <tr
      id={id}
      className={cn(classes.card, 'group mb-2 table-row not-last:border-b')}
    >
      {children}
    </tr>
  );
};

const NameCell: FC<{
  name: string;
  optional?: boolean;
}> = ({ name, optional }) => {
  return (
    <td className="relative table-cell pr-3">
      {name && (
        <code
          className={cn(
            'bg-muted px-1.5 py-0.5 rounded text-xs whitespace-nowrap my-0',
            optional && 'after:content-["?"]'
          )}
        >
          {name}
        </code>
      )}
    </td>
  );
};

const TypeCell: FC<{
  type: string;
  typeLinkMap: TSDocProps['typeLinkMap'];
}> = ({ type, typeLinkMap }) => {
  return (
    <td className="p-3 table-cell break-words">{linkify(type, typeLinkMap)}</td>
  );
};

const FieldsTable: FC<{
  fields: TypeField[];
  typeLinkMap: TSDocProps['typeLinkMap'];
}> = ({ fields, typeLinkMap }) => {
  const slugger = new Slugger();

  return (
    <table className="w-full text-sm border-collapse my-6 table-fixed">
      <thead>
        <tr className="border-b text-left">
          <th className="py-2 w-1/4">Name</th>
          <th className="py-2 w-1/4">Type</th>
          <th className="py-2 w-1/2">Description</th>
        </tr>
      </thead>
      <tbody>
        {fields.map((field) => {
          const id = slugger.slug(field.name);
          const tags = field.tags ?? {};
          const description = [
            field.description || tags.description,
            tags.deprecated && `**Deprecated**: ${tags.deprecated}`,
          ]
            .filter(Boolean)
            .join('\n');

          return (
            <Row key={id} id={id}>
              <NameCell optional={field.optional} name={field.name} />
              <TypeCell type={field.type} typeLinkMap={typeLinkMap} />
              <td
                className={cn(
                  'table-cell p-3',
                  !description && 'after:content-["-"]',
                  'break-words overflow-hidden text-sm [&_a]:no-underline [&_a]:font-normal [&_a]:hover:no-underline'
                )}
              >
                {linkify(description, typeLinkMap)}
              </td>
            </Row>
          );
        })}
      </tbody>
    </table>
  );
};

function linkify(
  text: string,
  typeLinkMap: TSDocProps['typeLinkMap'] = {}
): ReactNode {
  // Combined regex to match markdown links and inline code
  const markdownRegex = /(\[([^\]]+)\]\(([^)]+)\))|(`([^`]+)`)/g;

  // Split the text by markdown elements
  const parts: (string | ReactElement)[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  // Reset regex state to ensure consistent behavior across calls
  markdownRegex.lastIndex = 0;
  match = markdownRegex.exec(text);
  while (match !== null) {
    // Add text before the match
    if (match.index > lastIndex) {
      parts.push(text.substring(lastIndex, match.index));
    }

    if (match[1]) {
      // It's a markdown link: [text](url)
      const linkText = match[2];
      const linkUrl = match[3];

      // Check if the link text contains inline code
      if (linkText.includes('`')) {
        const codeParts = linkText.split(/`([^`]+)`/);
        const linkContent = codeParts
          .map((part, i) => {
            if (i % 2 === 1) {
              // It's code
              return (
                <code key={`code-${parts.length}-${i}`} className="text-xs">
                  {part}
                </code>
              );
            }
            return part;
          })
          .filter(Boolean);

        parts.push(
          <Link key={parts.length} href={linkUrl} className="text-primary-blue">
            {linkContent}
          </Link>
        );
      } else {
        parts.push(
          <Link key={parts.length} href={linkUrl}>
            {linkText}
          </Link>
        );
      }
    } else if (match[4]) {
      // It's inline code: `code`
      const codeText = match[5];
      parts.push(
        <code
          key={parts.length}
          className="bg-muted px-1 py-0.5 rounded text-xs"
        >
          {codeText}
        </code>
      );
    }

    lastIndex = match.index + match[0].length;
    match = markdownRegex.exec(text);
  }

  // Add any remaining text
  if (lastIndex < text.length) {
    parts.push(text.substring(lastIndex));
  }

  // If no markdown links were found, use the original logic for type links
  if (parts.length === 0) {
    const result: (string | ReactElement)[] = [];
    const chunks = text.match(/(\w+|\W+)/g) || [];

    for (const chunk of chunks) {
      const href = Object.hasOwn(typeLinkMap, chunk)
        ? typeLinkMap[chunk]
        : undefined;
      if (href) {
        result.push(
          <Link key={result.length} href={href} className="text-primary-blue">
            {chunk}
          </Link>
        );
        continue;
      }
      if (typeof result.at(-1) === 'string') {
        result[result.length - 1] += chunk;
        continue;
      }
      result.push(chunk);
    }
    return result;
  }

  // Process remaining text parts for type links
  return parts.flatMap((part, index) => {
    if (typeof part !== 'string') return part;

    // Apply type link mapping to text parts
    const chunks = part.match(/(\w+|\W+)/g) || [];
    const processedChunks: (string | ReactElement)[] = [];

    for (const chunk of chunks) {
      const href = Object.hasOwn(typeLinkMap, chunk)
        ? typeLinkMap[chunk]
        : undefined;
      if (href) {
        processedChunks.push(
          <Link
            key={`${index}-${processedChunks.length}`}
            href={href}
            className="text-primary-blue hover:underline"
          >
            <code>{chunk}</code>
          </Link>
        );
      } else {
        if (typeof processedChunks[processedChunks.length - 1] === 'string') {
          processedChunks[processedChunks.length - 1] += chunk;
        } else {
          processedChunks.push(chunk);
        }
      }
    }

    return processedChunks.length === 1 ? processedChunks[0] : processedChunks;
  });
}
