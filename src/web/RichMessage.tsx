import "katex/dist/katex.min.css";
import {
  Children,
  type ComponentPropsWithoutRef,
  cloneElement,
  isValidElement,
  memo,
  type ReactElement,
  type ReactNode,
  useMemo,
} from "react";
import Markdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

interface RichMessageProps {
  content: string;
  knownHandles: ReadonlySet<string>;
}

function RichMessageView({ content, knownHandles }: RichMessageProps) {
  const components = useMemo<Components>(
    () => ({
      p: ({ children }) => <p>{highlightMentions(children, knownHandles)}</p>,
      h1: ({ children }) => <h1>{highlightMentions(children, knownHandles)}</h1>,
      h2: ({ children }) => <h2>{highlightMentions(children, knownHandles)}</h2>,
      h3: ({ children }) => <h3>{highlightMentions(children, knownHandles)}</h3>,
      h4: ({ children }) => <h4>{highlightMentions(children, knownHandles)}</h4>,
      h5: ({ children }) => <h5>{highlightMentions(children, knownHandles)}</h5>,
      h6: ({ children }) => <h6>{highlightMentions(children, knownHandles)}</h6>,
      li: ({ children }) => <li>{highlightMentions(children, knownHandles)}</li>,
      td: ({ children }) => <td>{highlightMentions(children, knownHandles)}</td>,
      th: ({ children }) => <th>{highlightMentions(children, knownHandles)}</th>,
      a: MarkdownLink,
      code: MarkdownCode,
    }),
    [knownHandles],
  );

  return (
    <div className="message-markdown">
      <Markdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { strict: false, trust: false }]]}
        components={components}
      >
        {content}
      </Markdown>
    </div>
  );
}

export const RichMessage = memo(RichMessageView, (previous, next) => {
  if (previous.content !== next.content || previous.knownHandles.size !== next.knownHandles.size) {
    return false;
  }
  for (const handle of previous.knownHandles) {
    if (!next.knownHandles.has(handle)) return false;
  }
  return true;
});

export default RichMessage;

function highlightMentions(children: ReactNode, knownHandles: ReadonlySet<string>): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") return highlightTextMentions(child, knownHandles);
    if (!isValidElement(child)) return child;
    const element = child as ReactElement<{ children?: ReactNode; node?: { tagName?: string } }>;
    const tagName = element.props.node?.tagName;
    if (
      element.type === MarkdownLink ||
      element.type === MarkdownCode ||
      tagName === "a" ||
      tagName === "code" ||
      tagName === "pre"
    ) {
      return child;
    }
    if (element.props.children === undefined) return child;
    return cloneElement(element, {
      children: highlightMentions(element.props.children, knownHandles),
    });
  });
}

function MarkdownLink({
  node: _node,
  children,
  href,
  ...props
}: ComponentPropsWithoutRef<"a"> & { node?: unknown }) {
  if (!href) return <span>{children}</span>;
  const external = /^https?:\/\//i.test(href);
  return (
    <a
      {...props}
      href={href}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
    >
      {children}
    </a>
  );
}

function MarkdownCode({
  node: _node,
  ...props
}: ComponentPropsWithoutRef<"code"> & { node?: unknown }) {
  return <code {...props} />;
}

function highlightTextMentions(content: string, knownHandles: ReadonlySet<string>): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /@[a-zA-Z0-9][a-zA-Z0-9_-]{1,30}/g;
  let cursor = 0;
  for (const match of content.matchAll(pattern)) {
    const index = match.index;
    if (index > cursor) nodes.push(content.slice(cursor, index));
    const handle = match[0].slice(1).toLowerCase();
    nodes.push(
      <mark
        className={knownHandles.has(handle) ? undefined : "unresolved"}
        key={`mention-${index}`}
      >
        {match[0]}
      </mark>,
    );
    cursor = index + match[0].length;
  }
  if (cursor < content.length) nodes.push(content.slice(cursor));
  return nodes;
}
