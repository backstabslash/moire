import { useMemo, useState } from "react";
import type { NoteSection } from "../../../shared/types";
import { renderMarkdown } from "../model/markdown";
import { Enlarged, mediaUrl } from "./Screenshots";

const MEDIA = /^\w[\w.-]*\.(png|jpe?g|gif|webp)$/i;

function Markdown({ root, text, onImage }: { root: string; text: string; onImage(img: HTMLImageElement): void }) {
  const html = useMemo(() => renderMarkdown(text, null, (src) => (MEDIA.test(src) ? mediaUrl(root, src) : null)), [root, text]);
  return (
    <div
      className="md note-md"
      onClick={(e) => {
        if (e.target instanceof HTMLImageElement) onImage(e.target);
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function Section({ root, section: { title, body, before, after } }: { root: string; section: NoteSection }) {
  const [open, setOpen] = useState<{ src: string; alt: string } | null>(null);
  const enlarge = (img: HTMLImageElement) => setOpen({ src: img.src, alt: img.alt });
  const side = (tag: "a" | "b", label: string, text?: string) =>
    text && (
      <div className={`note-side ${tag}`}>
        <div className="note-side-label">
          <span className={`plate-tag tag-${tag}`}>{tag.toUpperCase()}</span>
          {label}
        </div>
        <Markdown root={root} text={text} onImage={enlarge} />
      </div>
    );
  return (
    <section className="note-section">
      {title && <h3>{title}</h3>}
      {body && <Markdown root={root} text={body} onImage={enlarge} />}
      {(before || after) && (
        <div className="note-pair">
          {side("a", "Before", before)}
          {side("b", "After", after)}
        </div>
      )}
      {open && <Enlarged src={open.src} shot={{ file: open.alt, caption: open.alt }} onClose={() => setOpen(null)} />}
    </section>
  );
}

export function NoteSections({ root, sections }: { root: string; sections: NoteSection[] }) {
  return (
    <>
      {sections.map((section, i) => (
        <Section key={i} root={root} section={section} />
      ))}
    </>
  );
}
