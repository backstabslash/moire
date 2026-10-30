import { useEffect, useState } from "react";
import type { CommitDetail } from "../../../shared/types";
import { AgentChip, Avatar } from "./Avatar";

export function CommitHead({ root, sha }: { root: string; sha: string }) {
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let stale = false;
    window.moire.commitDetail(root, sha).then(
      (d) => !stale && setDetail(d),
      () => !stale && setDetail(null),
    );
    return () => {
      stale = true;
    };
  }, [root, sha]);

  if (!detail) return <div className="commit-head" />;
  const date = new Date(detail.date).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  return (
    <div className="commit-head">
      <code>{detail.short}</code>
      {detail.body ? (
        <button
          className="commit-subject"
          aria-expanded={open}
          data-tip={open ? "Hide the message body" : "Show the message body"}
          onClick={() => setOpen(!open)}
        >
          {detail.subject}
        </button>
      ) : (
        <b className="commit-subject">{detail.subject}</b>
      )}
      <span className="commit-meta">
        <Avatar name={detail.author} email={detail.email} />
        {detail.author}, {date}
        <AgentChip commit={detail} />
      </span>
      {open && <p className="commit-body">{detail.body}</p>}
    </div>
  );
}
