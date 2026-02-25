import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function Markdown({ content, className }: { content: string; className?: string }) {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className="text-primary hover:underline break-words"
            >
              {children}
            </a>
          ),
          p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="my-2 ml-5 list-disc space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 ml-5 list-decimal space-y-1">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-border pl-3 text-text-secondary/90">
              {children}
            </blockquote>
          ),
          h1: ({ children }) => <h1 className="text-base font-semibold mt-3 mb-2">{children}</h1>,
          h2: ({ children }) => <h2 className="text-sm font-semibold mt-3 mb-2">{children}</h2>,
          h3: ({ children }) => <h3 className="text-sm font-medium mt-3 mb-2">{children}</h3>,
          hr: () => <hr className="my-3 border-border/70" />,
          pre: ({ children }) => (
            <pre className="my-2 overflow-x-auto rounded-lg border border-border bg-background/40 p-3 text-xs leading-relaxed">
              {children}
            </pre>
          ),
          code: ({ children, className }) => {
            const text = Array.isArray(children)
              ? children.join("")
              : typeof children === "string"
                ? children
                : "";
            const isBlock = Boolean(className) || text.includes("\n");

            if (isBlock) {
              return <code className="font-mono text-xs">{text.replace(/\n$/, "")}</code>;
            }

            return (
              <code className="px-1 py-0.5 rounded bg-surface-2 border border-border font-mono text-[0.85em]">
                {children}
              </code>
            );
          },
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto">
              <table className="w-full text-sm border border-border">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-border bg-surface-2 px-2 py-1 text-left font-medium">{children}</th>
          ),
          td: ({ children }) => <td className="border border-border px-2 py-1 align-top">{children}</td>,
          img: () => null,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
