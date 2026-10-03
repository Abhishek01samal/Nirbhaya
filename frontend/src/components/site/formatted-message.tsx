import React from "react";

function parseBold(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*.*?\*\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return (
        <strong key={index} className="font-bold text-foreground opacity-95">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return part;
  });
}

export function FormattedMessage({ content }: { content: string }) {
  if (!content) return null;

  // Split content by inline or line-break numbered steps (e.g. " 1. ", " 2. ", "\n1. ")
  const rawBlocks = content.split(/(?=(?:\n+|^|\s+)\d+\.\s+)/g);

  return (
    <div className="space-y-2 text-sm leading-relaxed">
      {rawBlocks.map((block, bIdx) => {
        const trimmed = block.trim();
        if (!trimmed) return null;

        // Match numbered steps like "1. **Lock the doors:** ..."
        const listMatch = trimmed.match(/^(\d+\.)\s+([\s\S]+)/);
        if (listMatch && listMatch[1] && listMatch[2]) {
          const num = listMatch[1];
          const rest = listMatch[2];
          return (
            <div key={bIdx} className="my-2 flex items-start gap-2.5 pl-1">
              <span className="shrink-0 select-none rounded border border-border bg-muted/30 px-1.5 py-0.5 font-mono text-[11px] font-bold text-foreground">
                {num}
              </span>
              <div className="flex-1 leading-snug">{parseBold(rest)}</div>
            </div>
          );
        }

        // Handle paragraph lines split by \n
        const lines = trimmed.split(/\n+/);
        return (
          <div key={bIdx} className="space-y-1.5">
            {lines.map((line, lIdx) => {
              const lineTrimmed = line.trim();
              if (!lineTrimmed) return null;

              if (lineTrimmed.startsWith("* ") || lineTrimmed.startsWith("- ")) {
                return (
                  <div key={lIdx} className="my-1 flex items-start gap-2 pl-3">
                    <span className="font-bold text-red-500">•</span>
                    <span className="flex-1">{parseBold(lineTrimmed.slice(2))}</span>
                  </div>
                );
              }

              return <p key={lIdx}>{parseBold(lineTrimmed)}</p>;
            })}
          </div>
        );
      })}
    </div>
  );
}
