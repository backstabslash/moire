import type { CSSProperties } from "react";
import type { CommitInfo } from "../../../shared/types";
import { agentOf, hueOf, initials } from "../model/avatar";

export function Avatar({ name, email }: { name: string; email: string }) {
  return (
    <span className="avatar" style={{ "--avatar-hue": hueOf(email || name) } as CSSProperties} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

export function AgentChip({ commit }: { commit: Pick<CommitInfo, "author" | "email" | "coauthors"> }) {
  const agent = agentOf([`${commit.author} <${commit.email}>`, ...commit.coauthors]);
  return (
    agent && (
      <i className="ref ref-agent" data-tip={`Written with ${agent}`}>
        {agent}
      </i>
    )
  );
}
