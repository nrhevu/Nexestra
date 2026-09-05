import "katex/dist/katex.min.css";
import {
  Children,
  type ComponentPropsWithoutRef,
  cloneElement,
  isValidElement,
  memo,
  type ReactElement,
  type ReactNode,
  useCallback,
  useMemo,
  useState,
} from "react";
import Markdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

interface RichMessageProps {
  content: string;
  knownHandles: ReadonlySet<string>;
  knownKnowledgeHandles?: ReadonlySet<string>;
}

function RichMessageView({
  content,
  knownHandles,
  knownKnowledgeHandles = EMPTY_HANDLES,
}: RichMessageProps) {
  const components = useMemo<Components>(
    () => ({
      p: ({ children }) => (
        <p>{highlightReferences(children, knownHandles, knownKnowledgeHandles)}</p>
      ),
      h1: ({ children }) => (
        <h1>{highlightReferences(children, knownHandles, knownKnowledgeHandles)}</h1>
      ),
      h2: ({ children }) => (
        <h2>{highlightReferences(children, knownHandles, knownKnowledgeHandles)}</h2>
      ),
      h3: ({ children }) => (
        <h3>{highlightReferences(children, knownHandles, knownKnowledgeHandles)}</h3>
      ),
      h4: ({ children }) => (
        <h4>{highlightReferences(children, knownHandles, knownKnowledgeHandles)}</h4>
      ),
      h5: ({ children }) => (
        <h5>{highlightReferences(children, knownHandles, knownKnowledgeHandles)}</h5>
      ),
      h6: ({ children }) => (
        <h6>{highlightReferences(children, knownHandles, knownKnowledgeHandles)}</h6>
      ),
      li: ({ children }) => (
        <li>{highlightReferences(children, knownHandles, knownKnowledgeHandles)}</li>
      ),
      td: ({ children }) => (
        <td>{highlightReferences(children, knownHandles, knownKnowledgeHandles)}</td>
      ),
      th: ({ children }) => (
        <th>{highlightReferences(children, knownHandles, knownKnowledgeHandles)}</th>
      ),
      a: MarkdownLink,
      code: MarkdownCode,
      pre: CodeBlock,
    }),
    [knownHandles, knownKnowledgeHandles],
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
  if (previous.content !== next.content || !setsEqual(previous.knownHandles, next.knownHandles)) {
    return false;
  }
  return setsEqual(
    previous.knownKnowledgeHandles ?? EMPTY_HANDLES,
    next.knownKnowledgeHandles ?? EMPTY_HANDLES,
  );
});

export default RichMessage;

const EMPTY_HANDLES: ReadonlySet<string> = new Set();

function highlightReferences(
  children: ReactNode,
  knownHandles: ReadonlySet<string>,
  knownKnowledgeHandles: ReadonlySet<string>,
): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") {
      return highlightTextReferences(child, knownHandles, knownKnowledgeHandles);
    }
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
      children: highlightReferences(element.props.children, knownHandles, knownKnowledgeHandles),
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

function CodeBlock({ children, ...props }: ComponentPropsWithoutRef<"pre"> & { node?: unknown }) {
  const [copied, setCopied] = useState(false);

  // Extract code content from children
  const codeContent = useCallback(() => {
    if (!children) return "";
    const extractText = (node: ReactNode): string => {
      if (typeof node === "string") return node;
      if (typeof node === "number") return String(node);
      if (Array.isArray(node)) return node.map(extractText).join("");
      if (isValidElement(node)) {
        const element = node as ReactElement<{ children?: ReactNode }>;
        return extractText(element.props.children);
      }
      return "";
    };
    return extractText(children).trim();
  }, [children]);

  const handleCopy = useCallback(() => {
    const text = codeContent();
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [codeContent]);

  return (
    <pre {...props} className="code-block">
      <button
        type="button"
        className={`code-copy-button${copied ? " copied" : ""}`}
        onClick={handleCopy}
        aria-label={copied ? "Copied!" : "Copy code"}
      >
        {copied ? "Copied!" : "Copy"}
      </button>
      {children}
    </pre>
  );
}

function highlightTextReferences(
  content: string,
  knownHandles: ReadonlySet<string>,
  knownKnowledgeHandles: ReadonlySet<string>,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(?:@[a-zA-Z0-9][a-zA-Z0-9_-]{1,30}|#[a-zA-Z0-9][a-zA-Z0-9_-]{1,47})/g;
  let cursor = 0;
  for (const match of content.matchAll(pattern)) {
    const index = match.index;
    if (index > cursor) nodes.push(content.slice(cursor, index));
    const reference = match[0];
    const handle = reference.slice(1).toLowerCase();
    const isKnowledge = reference.startsWith("#");
    const known = isKnowledge ? knownKnowledgeHandles.has(handle) : knownHandles.has(handle);
    nodes.push(
      <mark
        className={
          `${isKnowledge ? "knowledge-reference" : ""}${known ? "" : " unresolved"}`.trim() ||
          undefined
        }
        key={`reference-${index}`}
      >
        {reference}
      </mark>,
    );
    cursor = index + reference.length;
  }
  if (cursor < content.length) nodes.push(content.slice(cursor));
  return nodes;
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}
