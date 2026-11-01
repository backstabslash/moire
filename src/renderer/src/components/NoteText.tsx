import { noteSpans } from "../model/notes";

export function NoteText({ text }: { text: string }) {
  return <>{noteSpans(text).map((s, i) => (s.code ? <code key={i}>{s.text}</code> : s.text))}</>;
}
