/**
 * Expand `<Spec8Note>` into a `<Callout>` that opens with one fixed lead.
 *
 * New runs use spec version 9 or later on every World that supports it, so the
 * docs describe that behavior as the default. Where a run created at spec 8
 * behaves differently, a page says so with:
 *
 *   <Spec8Note>
 *   this setting is not read.
 *   </Spec8Note>
 *
 * which renders as a callout reading "For runs started before v5.8.0, on
 * third-party Worlds without spec version 9 support, or with
 * `WORKFLOW_SPEC_VERSION=8`, this setting is not read." The children continue
 * the lead's sentence, so start them in lowercase.
 *
 * This runs in the remark stage rather than as a React component so the
 * processed-markdown export (llms.txt, `.md` routes, copy-page) carries the
 * full sentence too, instead of a bare `<Spec8Note>` tag an agent cannot
 * expand.
 */

/** Minimal structural view of an mdast tree; avoids depending on @types/mdast. */
type Node = {
  type: string;
  name?: string | null;
  value?: string;
  url?: string;
  attributes?: unknown[];
  children?: Node[];
};

export const SPEC8_NOTE_COMPONENT = 'Spec8Note';

export const SPEC8_NOTE_WORLD_SUPPORT_URL =
  '/worlds/building-a-world#supporting-spec-9-runs';
export const SPEC8_NOTE_SPEC_VERSION_URL =
  '/docs/configuration/runtime-tuning#workflow_spec_version';

function lead(trailing: string): Node[] {
  return [
    {
      type: 'text',
      value: 'For runs started before v5.8.0, on third-party Worlds without ',
    },
    {
      type: 'link',
      url: SPEC8_NOTE_WORLD_SUPPORT_URL,
      children: [{ type: 'text', value: 'spec version 9' }],
    },
    { type: 'text', value: ' support, or with ' },
    {
      type: 'link',
      url: SPEC8_NOTE_SPEC_VERSION_URL,
      children: [{ type: 'inlineCode', value: 'WORKFLOW_SPEC_VERSION=8' }],
    },
    { type: 'text', value: trailing },
  ];
}

function toCallout(children: Node[], flow: boolean): Node {
  const [first, ...rest] = children;
  const body: Node[] =
    first?.type === 'paragraph'
      ? [
          {
            ...first,
            children: [...lead(', '), ...(first.children ?? [])],
          },
          ...rest,
        ]
      : [{ type: 'paragraph', children: lead(':') }, ...children];
  return {
    type: flow ? 'mdxJsxFlowElement' : 'mdxJsxTextElement',
    name: 'Callout',
    attributes: [],
    children: body,
  };
}

function isNote(node: Node | undefined): boolean {
  return (
    (node?.type === 'mdxJsxFlowElement' ||
      node?.type === 'mdxJsxTextElement') &&
    node.name === SPEC8_NOTE_COMPONENT
  );
}

function walk(node: Node): void {
  const children = node.children;
  if (!children) return;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.type === 'mdxJsxFlowElement' && isNote(child)) {
      children[i] = toCallout(child.children ?? [], true);
      continue;
    }
    // `<Spec8Note>text</Spec8Note>` on one line parses as a paragraph holding
    // a text element. Lift it to a flow callout so it renders as a block.
    if (
      child.type === 'paragraph' &&
      child.children?.length === 1 &&
      isNote(child.children[0])
    ) {
      const inline = child.children[0].children ?? [];
      children[i] = toCallout([{ type: 'paragraph', children: inline }], true);
      continue;
    }
    walk(child);
  }
}

export function remarkSpec8Note() {
  return (tree: Node) => {
    walk(tree);
  };
}
