import { ChevronDown, ChevronUp, FileCode2, ListEnd, LoaderCircle, Play, Trash2 } from "lucide-react";
import type { QueuedTurn } from "@forge/contracts";

export default function TurnQueue({ items, running, busyId, onMove, onDelete, onStart }: {
  items: QueuedTurn[];
  running: boolean;
  busyId: string;
  onMove: (index: number, direction: -1 | 1) => void;
  onDelete: (item: QueuedTurn) => void;
  onStart: () => void;
}) {
  if (!items.length) return null;
  return <section className="turn-queue" aria-labelledby="turn-queue-title">
    <header>
      <div><ListEnd size={15} /><strong id="turn-queue-title">后续任务</strong><span>{items.length}</span></div>
      {!running && <button className="queue-start" type="button" disabled={Boolean(busyId)} onClick={onStart}>
        {busyId === "start" ? <LoaderCircle className="spin" size={13} /> : <Play size={13} />}继续执行
      </button>}
    </header>
    <ol>
      {items.map((item, index) => <li key={item.id}>
        <span className="queue-index">{index + 1}</span>
        <div className="queue-copy">
          <p>{item.text}</p>
          <small>{item.contextFiles.length ? <><FileCode2 size={11} />{item.contextFiles.length} 个上下文文件</> : "将在当前任务结束后执行"}</small>
        </div>
        <div className="queue-actions">
          <button type="button" aria-label={`上移：${item.text}`} disabled={Boolean(busyId) || index === 0} onClick={() => onMove(index, -1)}><ChevronUp size={14} /></button>
          <button type="button" aria-label={`下移：${item.text}`} disabled={Boolean(busyId) || index === items.length - 1} onClick={() => onMove(index, 1)}><ChevronDown size={14} /></button>
          <button className="queue-delete" type="button" aria-label={`取消等待：${item.text}`} disabled={Boolean(busyId)} onClick={() => onDelete(item)}>
            {busyId === item.id ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}
          </button>
        </div>
      </li>)}
    </ol>
  </section>;
}
