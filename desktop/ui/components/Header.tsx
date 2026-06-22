import type { Snapshot } from "../types";
import { Tooltip } from "./Tooltip";

interface Props {
  counts?: Snapshot["counts"];
  error: string | null;
}

const BADGE_TOOLTIP = {
  active:  "Agentes com heartbeat recente — respondendo normalmente",
  suspect: "Sem heartbeat há +1 min — podem estar travados",
  dead:    "Sem heartbeat há +3 min — provavelmente inativos",
  closed:  "Sessões encerradas nesta janela",
};

export function Header({ counts, error }: Props) {
  return (
    <header className="header">
      <div className="brand">
        <img src="./logo.png" width={30} height={30} alt="" style={{ imageRendering: "auto", flexShrink: 0 }} />
        <span>AgentDesk</span>
        <span className="dim">Desktop</span>
      </div>
      <div className="counts">
        <Badge kind="active"  label="Ativos"     value={counts?.active  ?? 0} />
        <Badge kind="suspect" label="Atrasados"  value={counts?.suspect ?? 0} />
        <Badge kind="dead"    label="Inativos"   value={counts?.dead    ?? 0} />
        <Badge kind="closed"  label="Encerrados" value={counts?.closed  ?? 0} />
      </div>
      {error && (
        <div className="header-right">
          <Tooltip label={error} side="bottom">
            <span className="error">{error}</span>
          </Tooltip>
        </div>
      )}
    </header>
  );
}

function Badge({ kind, label, value }: {
  kind: "active" | "suspect" | "dead" | "closed";
  label: string;
  value: number;
}) {
  return (
    <Tooltip label={BADGE_TOOLTIP[kind]} side="bottom">
      <span className={`badge badge-${kind}`}>
        <span className="badge-value">{value}</span>
        <span className="badge-label">{label}</span>
      </span>
    </Tooltip>
  );
}
