import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown" dir="auto">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: (props) => (
            <a {...props} target="_blank" rel="noopener noreferrer" />
          ),
          img: ({ alt }) => (
            <span className="muted">
              [Image reference: {alt || "see source PDF"}]
            </span>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
